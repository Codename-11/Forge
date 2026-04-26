"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Activity,
  ExternalLink,
  MoreHorizontal,
  Pause,
  Power,
  PowerOff,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";
import { cn } from "@/lib/utils";

type AgentStatus = "ONLINE" | "BUSY" | "OFFLINE";

export function AgentQuickActions({
  agentId,
  profileKey,
  name: _name,
  status,
}: {
  agentId: string;
  profileKey: string;
  name: string;
  status: AgentStatus;
}) {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const heartbeat = trpc.agent.heartbeat.useMutation({
    onSuccess: (_data, vars) => {
      const next = (vars.status ?? "ONLINE") as AgentStatus;
      toast.success(`@${profileKey} is now ${next.toLowerCase()}`);
      void utils.agent.list.invalidate();
      void utils.agent.byProfileKey.invalidate();
      void utils.agent.pipeline.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const force = (next: AgentStatus) => {
    setOpen(false);
    heartbeat.mutate({ id: agentId, status: next });
  };

  const detailHref = `/w/${ws.slug}/agents/${profileKey}`;
  const deliveriesHref = `${detailHref}#webhook-health`;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label="Agent actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={cn(
          "focus-ring inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-subtle hover:text-foreground",
          open && "bg-subtle text-foreground",
        )}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>

      {open && (
        <div
          role="menu"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          className="absolute right-0 top-full z-30 mt-1 w-44 rounded-md border border-border bg-card py-1 shadow-md"
        >
          <Link
            href={detailHref}
            onClick={() => setOpen(false)}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-subtle"
          >
            <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
            <span>View detail</span>
          </Link>

          <div className="my-1 h-px bg-border" />

          <button
            type="button"
            onClick={() => force("ONLINE")}
            disabled={status === "ONLINE" || heartbeat.isPending}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-subtle disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <Power className="h-3.5 w-3.5 text-muted-foreground" />
            <span>Force ONLINE</span>
          </button>
          <button
            type="button"
            onClick={() => force("BUSY")}
            disabled={status === "BUSY" || heartbeat.isPending}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-subtle disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <Pause className="h-3.5 w-3.5 text-muted-foreground" />
            <span>Force BUSY</span>
          </button>
          <button
            type="button"
            onClick={() => force("OFFLINE")}
            disabled={status === "OFFLINE" || heartbeat.isPending}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-subtle disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <PowerOff className="h-3.5 w-3.5 text-muted-foreground" />
            <span>Force OFFLINE</span>
          </button>

          <div className="my-1 h-px bg-border" />

          <Link
            href={deliveriesHref}
            onClick={() => setOpen(false)}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-subtle"
          >
            <Activity className="h-3.5 w-3.5 text-muted-foreground" />
            <span>View recent deliveries</span>
          </Link>
        </div>
      )}
    </div>
  );
}
