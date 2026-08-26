from __future__ import annotations

import asyncio
import importlib.util
import io
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch


class Platform(str):
    pass


class PlatformConfig:
    def __init__(self, enabled=True, api_key="test-key", token="", extra=None):
        self.enabled = enabled
        self.api_key = api_key
        self.token = token
        self.extra = extra or {}


class SendResult:
    def __init__(self, success, error=None, message_id=None):
        self.success = success
        self.error = error
        self.message_id = message_id


class BasePlatformAdapter:
    def __init__(self, config, platform):
        self.config = config
        self.platform = platform

    def _mark_connected(self):
        pass

    def _mark_disconnected(self):
        pass

    def _set_fatal_error(self, *args, **kwargs):
        self.fatal_error = (args, kwargs)


gateway = types.ModuleType("gateway")
gateway_config = types.ModuleType("gateway.config")
gateway_config.Platform = Platform
gateway_platforms = types.ModuleType("gateway.platforms")
gateway_base = types.ModuleType("gateway.platforms.base")
gateway_base.BasePlatformAdapter = BasePlatformAdapter
gateway_base.PlatformConfig = PlatformConfig
gateway_base.SendResult = SendResult
sys.modules.setdefault("gateway", gateway)
sys.modules.setdefault("gateway.config", gateway_config)
sys.modules.setdefault("gateway.platforms", gateway_platforms)
sys.modules.setdefault("gateway.platforms.base", gateway_base)

MODULE_PATH = Path(__file__).resolve().parents[1] / "adapter.py"
spec = importlib.util.spec_from_file_location("forge_platform_adapter_test", MODULE_PATH)
assert spec and spec.loader
adapter_module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = adapter_module
spec.loader.exec_module(adapter_module)


class ForgeAdapterTest(unittest.TestCase):
    def make_adapter(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        env = patch.dict(
            "os.environ",
            {"HERMES_HOME": temp.name, "HERMES_PROFILE": "victor"},
            clear=False,
        )
        env.start()
        self.addCleanup(env.stop)
        adapter = adapter_module.ForgeAdapter(
            PlatformConfig(extra={"base_url": "https://forge.example.test"})
        )
        self.addCleanup(adapter._sequences.close)
        return adapter

    def test_negotiates_versioned_connector(self):
        adapter = self.make_adapter()
        adapter._call_tool = Mock(
            return_value={
                "selectedVersion": "1.0",
                "connectorId": "connector-1",
                "capabilities": {"draftStreaming": True},
            }
        )

        self.assertTrue(asyncio.run(adapter.connect()))
        self.assertTrue(adapter._negotiated)
        name, arguments, idempotent = adapter._call_tool.call_args.args
        self.assertEqual(name, "chat.connector.negotiate")
        self.assertEqual(arguments["profileKey"], "victor")
        self.assertTrue(idempotent)

    def test_negotiation_failure_uses_legacy_tools(self):
        adapter = self.make_adapter()
        adapter._call_tool = Mock(side_effect=RuntimeError("unknown tool"))

        self.assertTrue(asyncio.run(adapter.connect()))
        self.assertFalse(adapter._negotiated)

    def test_transport_negotiation_failure_does_not_claim_legacy_connection(self):
        adapter = self.make_adapter()
        adapter._call_tool = Mock(side_effect=RuntimeError("connection refused"))

        self.assertFalse(asyncio.run(adapter.connect()))
        self.assertFalse(adapter._negotiated)
        self.assertEqual(adapter.fatal_error[0][0], "connector_negotiation_failed")

    def test_mcp_requests_send_stable_forge_user_agent(self):
        adapter = self.make_adapter()
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = b'{"result": {"ok": true}}'

        with patch.object(adapter_module.urllib.request, "urlopen", return_value=response) as opened:
            adapter._call_tool_once("chat.connector.negotiate", {})

        request = opened.call_args.args[0]
        self.assertEqual(request.get_header("User-agent"), adapter_module.FORGE_USER_AGENT)
        self.assertEqual(adapter_module.FORGE_USER_AGENT, "Forge-Hermes-Platform/2.0.0")
        plugin = (MODULE_PATH.parent / "plugin.yaml").read_text(encoding="utf-8")
        self.assertIn(f"version: {adapter_module.ADAPTER_VERSION}", plugin)

    def test_http_failures_are_classified_and_sanitized(self):
        adapter = self.make_adapter()
        error = adapter_module.urllib.error.HTTPError(
            adapter.rpc_url,
            403,
            "Forbidden",
            {},
            io.BytesIO(
                b'authorization: Bearer super-secret https://forge.example.test/private?token=bad'
            ),
        )
        with patch.object(adapter_module.urllib.request, "urlopen", side_effect=error):
            with self.assertRaises(adapter_module.ForgeMcpError) as raised:
                adapter._call_tool_once("chat.connector.negotiate", {})

        self.assertEqual(raised.exception.status, 403)
        self.assertEqual(raised.exception.error_class, "http_error")
        self.assertFalse(raised.exception.retryable)
        self.assertNotIn("super-secret", str(raised.exception))
        self.assertNotIn("forge.example.test", str(raised.exception))

    def test_negotiated_event_has_stable_contract_and_increasing_sequence(self):
        adapter = self.make_adapter()
        adapter._negotiated = True
        adapter._selected_version = "1.0"
        adapter._connector_id = "connector-1"
        adapter._call_tool = Mock(return_value={"accepted": True, "messageId": "message-1"})

        first = asyncio.run(
            adapter.deliver_event(
                kind="status.changed",
                thread_id="thread-1",
                session_id="session-1",
                reply_to_message_id="user-message-1",
                payload={"status": "thinking"},
                event_id="event-1",
            )
        )
        second = asyncio.run(
            adapter.deliver_event(
                kind="status.changed",
                thread_id="thread-1",
                session_id="session-1",
                payload={"status": "working"},
                event_id="event-2",
            )
        )

        self.assertTrue(first.success)
        self.assertTrue(second.success)
        first_envelope = adapter._call_tool.call_args_list[0].args[1]["envelope"]
        second_envelope = adapter._call_tool.call_args_list[1].args[1]["envelope"]
        self.assertEqual(first_envelope["eventId"], "event-1")
        self.assertEqual(first_envelope["direction"], "hermes_to_forge")
        self.assertEqual(first_envelope["replyToMessageId"], "user-message-1")
        self.assertEqual(first_envelope["attribution"]["profileKey"], "victor")
        self.assertEqual((first_envelope["sequence"], second_envelope["sequence"]), (1, 2))

    def test_negotiated_draft_uses_event_envelopes(self):
        adapter = self.make_adapter()
        adapter._negotiated = True
        adapter._selected_version = "1.0"
        adapter._call_tool = Mock(return_value={"accepted": True})

        result = asyncio.run(
            adapter.send_draft(
                "thread-1",
                7,
                "hello",
                {"reply_to_message_id": "user-message-1", "session_id": "session-1"},
            )
        )
        final = asyncio.run(
            adapter.send("thread-1", "hello world", metadata={"session_id": "session-1"})
        )

        self.assertTrue(result.success)
        self.assertTrue(final.success)
        kinds = [call.args[1]["envelope"]["kind"] for call in adapter._call_tool.call_args_list]
        self.assertEqual(kinds, ["message.started", "message.delta", "message.final"])

    def test_failed_event_stays_in_durable_outbox_and_flushes_in_order(self):
        adapter = self.make_adapter()
        adapter._negotiated = True
        adapter._selected_version = "1.0"
        adapter._call_tool = Mock(
            side_effect=[RuntimeError("offline"), {"accepted": True}, {"accepted": True}]
        )

        failed = asyncio.run(
            adapter.deliver_event(
                kind="status.changed",
                thread_id="thread-1",
                session_id="session-1",
                payload={"status": "thinking"},
                event_id="event-1",
            )
        )
        recovered = asyncio.run(
            adapter.deliver_event(
                kind="status.changed",
                thread_id="thread-1",
                session_id="session-1",
                payload={"status": "working"},
                event_id="event-2",
            )
        )

        self.assertFalse(failed.success)
        self.assertTrue(recovered.success)
        delivered = [call.args[1]["envelope"]["eventId"] for call in adapter._call_tool.call_args_list]
        self.assertEqual(delivered, ["event-1", "event-1", "event-2"])
        self.assertEqual(adapter._sequences.pending(), [])

    def test_failed_final_reuses_its_event_identity_on_retry(self):
        adapter = self.make_adapter()
        adapter._negotiated = True
        adapter._selected_version = "1.0"
        adapter.max_retries = 1
        adapter._call_tool = Mock(return_value={"accepted": True})

        partial = asyncio.run(
            adapter.send_draft(
                "thread-1",
                9,
                "hello",
                {"reply_to_message_id": "user-1", "session_id": "session-1"},
            )
        )
        self.assertTrue(partial.success)
        adapter._call_tool = Mock(
            side_effect=[RuntimeError("offline"), {"accepted": True, "messageId": "message-1"}]
        )

        failed = asyncio.run(adapter.send("thread-1", "hello world"))
        recovered = asyncio.run(adapter.send("thread-1", "hello world"))

        self.assertFalse(failed.success)
        self.assertTrue(recovered.success)
        final_ids = [
            call.args[1]["envelope"]["eventId"] for call in adapter._call_tool.call_args_list
        ]
        self.assertEqual(len(final_ids), 2)
        self.assertEqual(final_ids[0], final_ids[1])
        self.assertEqual(adapter._sequences.pending(), [])
        self.assertEqual(adapter._drafts, {})

    def test_legacy_draft_contract_is_retained(self):
        adapter = self.make_adapter()
        adapter._negotiated = False
        adapter._call_tool = Mock(
            side_effect=[{"draftId": "draft-1"}, {"ok": True}, {"messageId": "message-1"}]
        )

        partial = asyncio.run(adapter.send_draft("thread-1", 3, "hello"))
        final = asyncio.run(adapter.send("thread-1", "hello world"))

        self.assertTrue(partial.success)
        self.assertTrue(final.success)
        names = [call.args[0] for call in adapter._call_tool.call_args_list]
        self.assertEqual(names, ["chat.startDraft", "chat.appendDraftChunk", "chat.finalizeDraft"])
        self.assertTrue(all(call.args[2] is False for call in adapter._call_tool.call_args_list))


if __name__ == "__main__":
    unittest.main()
