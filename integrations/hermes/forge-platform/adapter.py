"""Hermes platform adapter for versioned Forge chat delivery.

The adapter negotiates the Forge connector protocol at startup. New Forge
servers receive ordered, idempotent event envelopes through
``chat.connector.deliver``. Older servers continue to use the established
``chat.startDraft`` / ``chat.appendDraftChunk`` / ``chat.finalizeDraft`` /
``chat.appendMessage`` tools.

Forge owns the durable ChatThread-to-Hermes-session mapping. This plugin never
creates a second transcript store and never sends a Forge API secret in event
payloads or diagnostics.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
from typing import Any, Dict, Optional
import urllib.error
import urllib.request
import uuid

from gateway.config import Platform
from gateway.platforms.base import BasePlatformAdapter, PlatformConfig, SendResult

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "http://127.0.0.1:3000"
CONNECTOR_NAME = "hermes-forge-platform"
CONNECTOR_VERSIONS = ("1.0",)
ADAPTER_VERSION = "2.0.0"
FORGE_USER_AGENT = f"Forge-Hermes-Platform/{ADAPTER_VERSION}"
NEGOTIATE_TOOL = "chat.connector.negotiate"
DELIVER_TOOL = "chat.connector.deliver"


def _clean_base_url(value: str | None) -> str:
    return (value or DEFAULT_BASE_URL).strip().rstrip("/") or DEFAULT_BASE_URL


def _api_key_from_config(config: PlatformConfig) -> str:
    return (
        str(getattr(config, "api_key", None) or "").strip()
        or str(getattr(config, "token", None) or "").strip()
        or os.getenv("FORGE_API_KEY", "").strip()
    )


def _base_url_from_config(config: PlatformConfig) -> str:
    extra = getattr(config, "extra", {}) or {}
    return _clean_base_url(
        str(extra.get("url") or "").strip()
        or str(extra.get("base_url") or "").strip()
        or os.getenv("FORGE_BASE_URL")
    )


def _positive_int_env(name: str, default: int, maximum: int) -> int:
    try:
        return max(1, min(int(os.getenv(name, str(default))), maximum))
    except (TypeError, ValueError):
        return default


def check_requirements() -> bool:
    return bool(os.getenv("FORGE_API_KEY"))


def validate_config(config: PlatformConfig) -> bool:
    return bool(_api_key_from_config(config))


def is_connected(config: PlatformConfig) -> bool:
    return bool(getattr(config, "enabled", False)) and validate_config(config)


def _env_enablement() -> Dict[str, Any]:
    if not os.getenv("FORGE_API_KEY"):
        return {}
    return {
        "url": _clean_base_url(os.getenv("FORGE_BASE_URL")),
        "streaming": True,
        "handle_chat_message_posted": True,
    }


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class SequenceStore:
    """Durably allocate monotonically increasing sequence numbers per lane."""

    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(str(path), check_same_thread=False)
        self._lock = threading.Lock()
        self._connection.execute(
            "CREATE TABLE IF NOT EXISTS connector_sequence "
            "(lane TEXT PRIMARY KEY, value INTEGER NOT NULL)"
        )
        self._connection.execute(
            "CREATE TABLE IF NOT EXISTS connector_outbox "
            "(event_id TEXT PRIMARY KEY, lane TEXT NOT NULL, sequence INTEGER NOT NULL, "
            "envelope TEXT NOT NULL, created_at TEXT NOT NULL)"
        )
        self._connection.execute(
            "CREATE INDEX IF NOT EXISTS connector_outbox_lane_sequence "
            "ON connector_outbox(lane, sequence)"
        )
        self._connection.commit()

    def next(self, lane: str) -> int:
        with self._lock, self._connection:
            row = self._connection.execute(
                "INSERT INTO connector_sequence(lane, value) VALUES (?, 1) "
                "ON CONFLICT(lane) DO UPDATE SET value = value + 1 "
                "RETURNING value", (lane,),
            ).fetchone()
        return int(row[0])

    def enqueue(self, lane: str, envelope: Dict[str, Any]) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                "INSERT OR IGNORE INTO connector_outbox"
                "(event_id, lane, sequence, envelope, created_at) VALUES (?, ?, ?, ?, ?)",
                (envelope["eventId"], lane, envelope["sequence"], json.dumps(envelope), _utc_now()),
            )

    def pending(self, lane: Optional[str] = None) -> list[Dict[str, Any]]:
        with self._lock:
            if lane is None:
                rows = self._connection.execute(
                    "SELECT lane, envelope FROM connector_outbox ORDER BY lane, sequence"
                ).fetchall()
            else:
                rows = self._connection.execute(
                    "SELECT lane, envelope FROM connector_outbox WHERE lane = ? ORDER BY sequence",
                    (lane,),
                ).fetchall()
        return [{"lane": row[0], "envelope": json.loads(row[1])} for row in rows]

    def acknowledge(self, event_id: str) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                "DELETE FROM connector_outbox WHERE event_id = ?", (event_id,)
            )

    def close(self) -> None:
        self._connection.close()


class ForgeMcpError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        retryable: bool,
        status: int | None = None,
        error_class: str = "connector_error",
    ):
        super().__init__(message)
        self.retryable = retryable
        self.status = status
        self.error_class = error_class


def _sanitize_diagnostic(value: Any, maximum: int = 300) -> str:
    text = str(value or "Connector request failed.")
    text = re.sub(r"Bearer\s+[^\s,)]+", "Bearer [REDACTED]", text, flags=re.IGNORECASE)
    text = re.sub(
        r"(token|secret|key|authorization|signature)([\"'\s:=]+)[^\s\"'&}]+",
        r"\1\2[REDACTED]",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(r"https?://[^\s\"']+", "[REDACTED_URL]", text, flags=re.IGNORECASE)
    text = " ".join(text.split())
    return text if len(text) <= maximum else text[: maximum - 3] + "..."


def _connector_error_fields(exc: Exception) -> tuple[str, int | None, bool]:
    return (
        str(getattr(exc, "error_class", exc.__class__.__name__)),
        getattr(exc, "status", None),
        bool(getattr(exc, "retryable", True)),
    )


def _negotiation_tool_missing(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(
        marker in text
        for marker in (
            "unknown tool",
            "tool not found",
            "method not found",
            "-32601",
        )
    )


@dataclass
class DraftState:
    stream_id: str
    last_body: str
    reply_to_message_id: str
    session_id: Optional[str]
    legacy_draft_id: Optional[str] = None
    final_event_id: Optional[str] = None


class ForgeAdapter(BasePlatformAdapter):
    """Outbound Forge adapter with negotiated event and legacy draft paths."""

    def __init__(self, config: PlatformConfig):
        super().__init__(config, Platform("forge"))
        self.api_key = _api_key_from_config(config)
        self.base_url = _base_url_from_config(config)
        self.rpc_url = f"{self.base_url}/api/mcp/rpc"
        self.profile_key = os.getenv("HERMES_PROFILE", "default").strip() or "default"
        self.max_retries = _positive_int_env("FORGE_CONNECTOR_MAX_RETRIES", 4, 8)
        self.retry_base_ms = _positive_int_env("FORGE_CONNECTOR_RETRY_BASE_MS", 250, 10_000)
        hermes_home = Path(os.getenv("HERMES_HOME", str(Path.home() / ".hermes")))
        self._sequences = SequenceStore(hermes_home / "forge-platform-state.db")
        self._drafts: Dict[tuple[str, int], DraftState] = {}
        self._negotiated = False
        self._selected_version: Optional[str] = None
        self._connector_id: Optional[str] = None
        self._server_capabilities: Dict[str, Any] = {}

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if not self.api_key:
            self._set_fatal_error("missing_api_key", "FORGE_API_KEY is required", retryable=False)
            return False

        request = {
            "connector": CONNECTOR_NAME,
            "versions": list(CONNECTOR_VERSIONS),
            "profileKey": self.profile_key,
            "capabilities": {
                "orderedEvents": True,
                "idempotentDelivery": True,
                "draftStreaming": True,
                "proactiveDelivery": True,
                "statusEvents": True,
                "toolEvents": True,
                "attribution": True,
                "sessionMapping": "forge-owned",
                "eventKinds": [
                    "message.started",
                    "message.delta",
                    "message.final",
                    "message.proactive",
                    "status.changed",
                    "tool.started",
                    "tool.completed",
                    "tool.failed",
                    "approval.requested",
                    "approval.resolved",
                    "delivery.error",
                ],
            },
        }
        try:
            result = await asyncio.to_thread(
                self._call_tool, NEGOTIATE_TOOL, request, True
            )
            selected = str((result or {}).get("selectedVersion") or "").strip()
            if selected not in CONNECTOR_VERSIONS:
                raise RuntimeError(f"Unsupported Forge connector version: {selected or 'missing'}")
            self._selected_version = selected
            self._connector_id = str((result or {}).get("connectorId") or "").strip() or None
            capabilities = (result or {}).get("capabilities")
            self._server_capabilities = capabilities if isinstance(capabilities, dict) else {}
            self._negotiated = True
            logger.info("[Forge] Negotiated connector protocol %s", selected)
            await asyncio.to_thread(self._flush_outbox)
        except Exception as exc:
            # An older Forge server has no negotiation tool. Preserve the
            # established draft protocol, but never infer new capabilities.
            if not _negotiation_tool_missing(exc):
                self._set_fatal_error(
                    "connector_negotiation_failed",
                    "Forge connector negotiation failed",
                    retryable=True,
                )
                error_class, status, retryable = _connector_error_fields(exc)
                logger.error(
                    "[Forge] Connector negotiation failed class=%s status=%s retryable=%s detail=%s",
                    error_class,
                    status if status is not None else "none",
                    retryable,
                    _sanitize_diagnostic(exc),
                )
                return False
            self._negotiated = False
            self._selected_version = None
            self._connector_id = None
            self._server_capabilities = {}
            logger.warning("[Forge] Connector negotiation unavailable; using legacy chat tools: %s", exc)

        self._mark_connected()
        return True

    async def disconnect(self) -> None:
        self._mark_disconnected()

    def supports_draft_streaming(
        self,
        chat_type: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> bool:
        if not self._negotiated:
            return True
        return self._server_capabilities.get("draftStreaming") is not False

    def _attribution(self, metadata: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        metadata = metadata or {}
        attribution: Dict[str, Any] = {
            "actorType": "agent",
            "profileKey": self.profile_key,
        }
        for source, target in (
            ("agent_id", "agentId"),
            ("agent_name", "displayName"),
            ("message_id", "hermesMessageId"),
        ):
            value = metadata.get(source)
            if value is not None and str(value).strip():
                attribution[target] = str(value).strip()
        return attribution

    def _new_envelope(
        self,
        *,
        kind: str,
        thread_id: str,
        payload: Dict[str, Any],
        session_id: Optional[str] = None,
        reply_to_message_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        event_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        lane = f"{thread_id}:{session_id or '-'}"
        occurred_at = _utc_now()
        resolved_event_id = event_id or f"hermes_{uuid.uuid4().hex}"
        envelope: Dict[str, Any] = {
            "protocolVersion": self._selected_version or CONNECTOR_VERSIONS[0],
            "connector": CONNECTOR_NAME,
            "eventId": resolved_event_id,
            "sequence": self._sequences.next(lane),
            "direction": "hermes_to_forge",
            "kind": kind,
            "occurredAt": occurred_at,
            "threadId": thread_id,
            "attribution": self._attribution(metadata),
            "idempotency": {
                "key": resolved_event_id,
                "scope": "connector-event",
            },
            "payload": payload,
        }
        if self._connector_id:
            envelope["connectorId"] = self._connector_id
        if session_id:
            envelope["sessionId"] = session_id
        if reply_to_message_id:
            envelope["replyToMessageId"] = reply_to_message_id
        return envelope

    async def deliver_event(
        self,
        *,
        kind: str,
        thread_id: str,
        payload: Dict[str, Any],
        session_id: Optional[str] = None,
        reply_to_message_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        event_id: Optional[str] = None,
    ) -> SendResult:
        """Deliver one idempotent connector event to Forge."""
        if not self._negotiated:
            return SendResult(success=False, error="Forge connector protocol was not negotiated")
        envelope = self._new_envelope(
            kind=kind,
            thread_id=thread_id,
            payload=payload,
            session_id=session_id,
            reply_to_message_id=reply_to_message_id,
            metadata=metadata,
            event_id=event_id,
        )
        lane = f"{thread_id}:{session_id or '-'}"
        self._sequences.enqueue(lane, envelope)
        try:
            results = await asyncio.to_thread(self._flush_outbox, lane)
            result = results.get(envelope["eventId"])
        except Exception as exc:
            logger.exception("[Forge] Connector delivery failed event=%s kind=%s", envelope["eventId"], kind)
            return SendResult(success=False, error=str(exc))
        message_id = None
        if isinstance(result, dict):
            message_id = str(result.get("messageId") or result.get("id") or "") or None
        return SendResult(success=True, message_id=message_id)

    def _flush_outbox(self, lane: Optional[str] = None) -> Dict[str, Any]:
        results: Dict[str, Any] = {}
        for item in self._sequences.pending(lane):
            envelope = item["envelope"]
            result = self._call_tool(DELIVER_TOOL, {"envelope": envelope}, True)
            results[envelope["eventId"]] = result
            self._sequences.acknowledge(envelope["eventId"])
        return results

    async def send_draft(
        self,
        chat_id: str,
        draft_id: int,
        content: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        thread_id = str(chat_id or "").strip()
        if not thread_id:
            return SendResult(success=False, error="Missing Forge thread id")
        body = str(content or "")
        metadata = metadata or {}
        key = (thread_id, int(draft_id))
        state = self._drafts.get(key)
        reply_to = str(metadata.get("reply_to_message_id") or "").strip()
        session_id = str(metadata.get("session_id") or "").strip() or None

        if self._negotiated:
            if state is None:
                state = DraftState(
                    stream_id=f"stream_{uuid.uuid4().hex}",
                    last_body="",
                    reply_to_message_id=reply_to,
                    session_id=session_id,
                )
                self._drafts[key] = state
                started = await self.deliver_event(
                    kind="message.started",
                    thread_id=thread_id,
                    session_id=session_id,
                    reply_to_message_id=reply_to or None,
                    metadata=metadata,
                    payload={"streamId": state.stream_id, "role": "agent"},
                )
                if not started.success:
                    self._drafts.pop(key, None)
                    return started
            delta = body[len(state.last_body):] if body.startswith(state.last_body) else body
            if delta:
                delivered = await self.deliver_event(
                    kind="message.delta",
                    thread_id=thread_id,
                    session_id=state.session_id,
                    reply_to_message_id=state.reply_to_message_id or None,
                    metadata=metadata,
                    payload={"streamId": state.stream_id, "delta": delta},
                )
                if not delivered.success:
                    return delivered
            state.last_body = body
            return SendResult(success=True)

        # Legacy Forge compatibility path. These tools have no idempotency key,
        # so they are deliberately attempted once rather than blindly retried.
        try:
            if state is None:
                args: Dict[str, Any] = {"threadId": thread_id}
                if reply_to:
                    args["replyToMessageId"] = reply_to
                opened = await asyncio.to_thread(self._call_tool, "chat.startDraft", args, False)
                forge_draft_id = str((opened or {}).get("draftId") or "")
                if not forge_draft_id:
                    raise RuntimeError("chat.startDraft returned no draftId")
                state = DraftState(
                    stream_id=f"legacy_{draft_id}",
                    last_body="",
                    reply_to_message_id=reply_to,
                    session_id=session_id,
                    legacy_draft_id=forge_draft_id,
                )
                self._drafts[key] = state
            delta = body[len(state.last_body):] if body.startswith(state.last_body) else body
            if delta:
                await asyncio.to_thread(
                    self._call_tool,
                    "chat.appendDraftChunk",
                    {"threadId": thread_id, "draftId": state.legacy_draft_id, "delta": delta},
                    False,
                )
            state.last_body = body
            return SendResult(success=True)
        except Exception as exc:
            self._drafts.pop(key, None)
            return SendResult(success=False, error=str(exc))

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        thread_id = str(chat_id or "").strip()
        body = str(content or "").strip()
        if not thread_id:
            return SendResult(success=False, error="Missing Forge thread id")
        if not body or body == "[SILENT]":
            self._drop_drafts(thread_id)
            return SendResult(success=True)

        metadata = metadata or {}
        draft_key, state = self._find_draft(thread_id)
        reply_to_id = str(
            reply_to
            or (state.reply_to_message_id if state else "")
            or metadata.get("reply_to_message_id")
            or ""
        ).strip()
        session_id = str(
            (state.session_id if state else "") or metadata.get("session_id") or ""
        ).strip() or None

        if self._negotiated:
            kind = "message.final"
            payload: Dict[str, Any] = {"body": body, "role": "agent"}
            if state:
                payload["streamId"] = state.stream_id
                if not state.final_event_id:
                    state.final_event_id = f"hermes_{uuid.uuid4().hex}"
            result = await self.deliver_event(
                kind=kind,
                thread_id=thread_id,
                session_id=session_id,
                reply_to_message_id=reply_to_id or None,
                metadata=metadata,
                payload=payload,
                event_id=state.final_event_id if state else None,
            )
            if result.success and draft_key is not None:
                self._drafts.pop(draft_key, None)
            return result

        # Legacy finalization has no idempotency key, so retain its established
        # single-attempt behavior and consume the draft before making the call.
        if draft_key is not None:
            self._drafts.pop(draft_key, None)

        try:
            if state and state.legacy_draft_id:
                result = await asyncio.to_thread(
                    self._call_tool,
                    "chat.finalizeDraft",
                    {"threadId": thread_id, "draftId": state.legacy_draft_id, "body": body},
                    False,
                )
            else:
                args: Dict[str, Any] = {"threadId": thread_id, "body": body}
                if reply_to_id:
                    args["replyToMessageId"] = reply_to_id
                result = await asyncio.to_thread(self._call_tool, "chat.appendMessage", args, False)
        except Exception as exc:
            return SendResult(success=False, error=str(exc))
        message_id = str((result or {}).get("id") or (result or {}).get("messageId") or "") or None
        return SendResult(success=True, message_id=message_id)

    async def send_status(
        self,
        thread_id: str,
        status: str,
        *,
        detail: Optional[str] = None,
        session_id: Optional[str] = None,
        reply_to_message_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        payload: Dict[str, Any] = {"status": status}
        if detail:
            payload["detail"] = detail
        return await self.deliver_event(
            kind="status.changed",
            thread_id=thread_id,
            session_id=session_id,
            reply_to_message_id=reply_to_message_id,
            metadata=metadata,
            payload=payload,
        )

    async def send_tool_event(
        self,
        thread_id: str,
        phase: str,
        tool_name: str,
        call_id: str,
        *,
        session_id: Optional[str] = None,
        reply_to_message_id: Optional[str] = None,
        summary: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        normalized = phase if phase in {"started", "completed", "failed"} else "failed"
        payload: Dict[str, Any] = {"toolName": tool_name, "callId": call_id}
        if summary:
            payload["summary"] = summary
        return await self.deliver_event(
            kind=f"tool.{normalized}",
            thread_id=thread_id,
            session_id=session_id,
            reply_to_message_id=reply_to_message_id,
            metadata=metadata,
            payload=payload,
        )

    async def send_proactive(
        self,
        thread_id: str,
        content: str,
        *,
        session_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        event_id: Optional[str] = None,
    ) -> SendResult:
        return await self.deliver_event(
            kind="message.proactive",
            thread_id=thread_id,
            session_id=session_id,
            metadata=metadata,
            event_id=event_id,
            payload={"body": content, "role": "agent"},
        )

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"id": chat_id, "name": f"Forge thread {chat_id}", "type": "forge_thread"}

    def _find_draft(self, thread_id: str) -> tuple[Optional[tuple[str, int]], Optional[DraftState]]:
        for key in list(self._drafts):
            if key[0] == thread_id:
                return key, self._drafts[key]
        return None, None

    def _drop_drafts(self, thread_id: str) -> None:
        for key in list(self._drafts):
            if key[0] == thread_id:
                self._drafts.pop(key, None)

    def _call_tool(
        self,
        name: str,
        arguments: Dict[str, Any],
        idempotent: bool = False,
    ) -> Any:
        attempts = self.max_retries if idempotent else 1
        last_error: Optional[Exception] = None
        for attempt in range(1, attempts + 1):
            try:
                return self._call_tool_once(name, arguments)
            except Exception as exc:
                last_error = exc
                if attempt >= attempts or not getattr(exc, "retryable", True):
                    break
                delay = min(5.0, (self.retry_base_ms / 1000.0) * (2 ** (attempt - 1)))
                logger.warning(
                    "[Forge] MCP call retry tool=%s attempt=%d/%d delay=%.2fs",
                    name,
                    attempt + 1,
                    attempts,
                    delay,
                )
                time.sleep(delay)
        raise last_error or RuntimeError(f"Forge MCP call failed: {name}")

    def _call_tool_once(self, name: str, arguments: Dict[str, Any]) -> Any:
        payload = {
            "jsonrpc": "2.0",
            "id": str(uuid.uuid4()),
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        }
        req = urllib.request.Request(
            self.rpc_url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "Authorization": f"Bearer {self.api_key}",
                "User-Agent": FORGE_USER_AGENT,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                raw = response.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            detail = _sanitize_diagnostic(exc.read().decode("utf-8", "replace"))
            raise ForgeMcpError(
                f"Forge MCP HTTP {exc.code}: {detail}",
                retryable=exc.code == 408 or exc.code == 429 or exc.code >= 500,
                status=exc.code,
                error_class="http_error",
            ) from exc
        except urllib.error.URLError as exc:
            raise ForgeMcpError(
                "Forge MCP transport unavailable",
                retryable=True,
                error_class="transport_error",
            ) from exc
        data = json.loads(raw)
        if data.get("error"):
            raise ForgeMcpError(f"Forge MCP error: {data['error']}", retryable=False)
        result = data.get("result") or {}
        content = result.get("content") or []
        if content and isinstance(content, list):
            text = content[0].get("text") if isinstance(content[0], dict) else None
            if text:
                try:
                    return json.loads(text)
                except json.JSONDecodeError:
                    return {"text": text}
        return result


def register(ctx):
    ctx.register_platform(
        name="forge",
        label="Forge",
        adapter_factory=lambda cfg: ForgeAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        env_enablement_fn=_env_enablement,
        required_env=["FORGE_API_KEY"],
        install_hint="Set FORGE_API_KEY and optional FORGE_BASE_URL in the Hermes profile .env",
        emoji="🛠️",
        pii_safe=False,
        allow_update_command=False,
    )
