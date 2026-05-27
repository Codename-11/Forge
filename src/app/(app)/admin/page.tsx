"use client";
import { useState } from "react";
import { DatabaseBackup, Plus } from "lucide-react";
import { toast } from "sonner";
import { AdminPage } from "@/components/admin-shell/admin-shell";
import { AdminOverview } from "@/components/admin-shell/admin-overview";
import { AdminButton } from "@/components/admin-shell/admin-ui";
import { QuickForm } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";

/**
 * `/admin` — instance Overview. Server shell around the `AdminOverview`
 * client component (metric tiles, tenants/users tables, system card,
 * instance-events feed, license footer). The header actions ("Backup
 * now", "New tenant") are wired here since they live on the page shell;
 * both fan out to `instanceAdmin.*` mutations and rely on tRPC cache
 * invalidation to refetch the embedded `AdminOverview` queries. Part of
 * the multi-workspace restructure.
 */
export default function AdminOverviewPage() {
  const [tenantOpen, setTenantOpen] = useState(false);

  const backup = trpc.instanceAdmin.backup.useMutation({
    onSuccess: (r) => toast.success("Backup requested.", { description: r.note }),
    onError: (e) => toast.error(e.message),
  });

  return (
    <AdminPage
      activePath="/admin"
      crumbs={["Instance", "Overview"]}
      eyebrow="Instance"
      title="Forge · self-hosted"
      subtitle="Health, tenants, and license across the whole instance"
      actions={
        <>
          <AdminButton
            icon={DatabaseBackup}
            disabled={backup.isPending}
            onClick={() => backup.mutate()}
          >
            {backup.isPending ? "Backing up…" : "Backup now"}
          </AdminButton>
          <AdminButton icon={Plus} tone="ember" onClick={() => setTenantOpen(true)}>
            New tenant
          </AdminButton>
        </>
      }
    >
      <AdminOverview />
      <NewTenantDialog open={tenantOpen} onOpenChange={setTenantOpen} />
    </AdminPage>
  );
}

/* ── New-tenant dialog ──────────────────────────────────────────────── */
function NewTenantDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [key, setKey] = useState("");
  // Track whether the operator has hand-edited slug/key so we stop
  // auto-deriving them from the name.
  const [slugTouched, setSlugTouched] = useState(false);
  const [keyTouched, setKeyTouched] = useState(false);

  const create = trpc.instanceAdmin.createTenant.useMutation({
    onSuccess: async (w) => {
      await utils.instanceAdmin.tenants.invalidate();
      await utils.instanceAdmin.system.invalidate();
      toast.success(`Created ${w.name} (${w.key}).`);
    },
    onError: (e) => toast.error(e.message),
  });

  function reset() {
    setName("");
    setSlug("");
    setKey("");
    setSlugTouched(false);
    setKeyTouched(false);
  }

  function onNameChange(v: string) {
    setName(v);
    if (!slugTouched) {
      setSlug(v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48));
    }
    if (!keyTouched) {
      setKey(v.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4));
    }
  }

  return (
    <QuickForm
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
      title="New workspace"
      description="Creates a tenant with seeded statuses, labels, and Cycle 1. You become its owner. Slug and key are immutable after create."
      primaryLabel="Create workspace"
      loading={create.isPending}
      onSubmit={async () => {
        const n = name.trim();
        const s = slug.trim();
        const k = key.trim().toUpperCase();
        if (!n) return { error: "Name required." };
        if (!/^[a-z0-9-]{2,48}$/.test(s)) return { error: "Slug must be 2-48 lowercase letters, numbers, or dashes." };
        if (!/^[A-Z]{2,6}$/.test(k)) return { error: "Key must be 2-6 uppercase letters." };
        try {
          await create.mutateAsync({ name: n, slug: s, key: k });
          reset();
          return undefined;
        } catch (e) {
          return { error: e instanceof Error ? e.message : "Failed to create workspace." };
        }
      }}
    >
      <QuickForm.Field label="Name" required>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Acme Corp"
          autoFocus
        />
      </QuickForm.Field>
      <div className="grid grid-cols-2 gap-2">
        <QuickForm.Field label="Slug" required hint="URL segment">
          <Input
            value={slug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
            }}
            placeholder="acme"
            className="font-mono"
          />
        </QuickForm.Field>
        <QuickForm.Field label="Key" required hint="Issue prefix">
          <Input
            value={key}
            onChange={(e) => {
              setKeyTouched(true);
              setKey(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 6));
            }}
            placeholder="ACM"
            className="font-mono uppercase"
          />
        </QuickForm.Field>
      </div>
    </QuickForm>
  );
}
