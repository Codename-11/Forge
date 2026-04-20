"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useHotkey } from "@/lib/keyboard";
import { trpc } from "@/lib/trpc";
import { useMaybeWorkspace } from "@/hooks/use-workspace";

const PRIORITIES = ["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"] as const;
type Priority = (typeof PRIORITIES)[number];

export function QuickCreate() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState<string>("");
  const [priority, setPriority] = useState<Priority>("NONE");
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [templateId, setTemplateId] = useState<string>("");
  const router = useRouter();
  const ws = useMaybeWorkspace();
  const utils = trpc.useUtils();
  const { data: projects } = trpc.project.list.useQuery(
    { archived: false, limit: 100 },
    { enabled: open },
  );
  const { data: templates } = trpc.template.list.useQuery(undefined, { enabled: open });

  const create = trpc.issue.create.useMutation({
    onSuccess: async (issue) => {
      toast.success(`Created #${issue.number}`);
      close();
      await utils.issue.list.invalidate();
      const base = ws ? `/w/${ws.slug}` : "";
      router.push(`${base}/issues/${issue.id}`);
    },
    onError: (err) => toast.error(err.message),
  });

  function close() {
    setOpen(false);
    setTitle("");
    setDescription("");
    setProjectId("");
    setPriority("NONE");
    setLabelIds([]);
    setTemplateId("");
  }

  function applyTemplate(tid: string) {
    setTemplateId(tid);
    const t = templates?.find((x) => x.id === tid);
    if (!t) return;
    setTitle(t.titleTemplate);
    setDescription(t.descriptionTemplate ?? "");
    setProjectId(t.projectId ?? "");
    setPriority(t.defaultPriority as Priority);
    setLabelIds(t.labelIds);
  }

  useHotkey("c", () => setOpen(true));

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest("[data-quick-create]") as HTMLElement | null;
      if (!el) return;
      const pid = el.dataset.quickCreateProject;
      if (pid) setProjectId(pid);
      setOpen(true);
    };
    document.addEventListener("click", handler);

    const evt = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId?: string; templateId?: string }>).detail ?? {};
      if (detail.projectId) setProjectId(detail.projectId);
      setOpen(true);
    };
    window.addEventListener("forge:quick-create", evt);

    return () => {
      document.removeEventListener("click", handler);
      window.removeEventListener("forge:quick-create", evt);
    };
  }, []);

  return (
    <Dialog open={open} onClose={close} className="max-w-lg">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim().length < 1) return;
          create.mutate({
            title: title.trim(),
            description: description.trim() || undefined,
            projectId: projectId || undefined,
            priority,
            labelIds,
          });
        }}
        className="space-y-3 p-5"
      >
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
          <span>New issue</span>
          <span className="ml-auto kbd">⏎ to create</span>
        </div>

        {templates && templates.length > 0 && (
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Start from template</label>
            <select
              value={templateId}
              onChange={(e) => applyTemplate(e.target.value)}
              className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="">Blank</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <Input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Issue title"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)…"
          rows={3}
          className="focus-ring w-full rounded-md border border-input bg-background p-2 text-sm text-foreground placeholder:text-muted-foreground"
        />
        <div className="grid grid-cols-2 gap-2">
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">No project</option>
            {projects?.items.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as Priority)}
            className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
          >
            {PRIORITIES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </div>
        {labelIds.length > 0 && (
          <div className="flex flex-wrap gap-1 text-[11px]">
            {labelIds.map((lid) => (
              <Badge key={lid}>{lid.slice(0, 8)}</Badge>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={close}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="ember"
            size="sm"
            disabled={!title.trim() || create.isPending}
          >
            {create.isPending ? "Creating…" : "Create issue"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
