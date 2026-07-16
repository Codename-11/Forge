"use client";

import { useEffect, useState } from "react";
import { ArtifactAgentPublishPolicy } from "@prisma/client";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Section } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";

export default function ArtifactSettingsPage() {
  const ws = useWorkspace();
  const canEdit = ws.role === "OWNER" || ws.role === "ADMIN";
  const utils = trpc.useUtils();
  const { data } = trpc.workspace.current.useQuery();
  const [externalSharing, setExternalSharing] = useState(false);
  const [publicPublishing, setPublicPublishing] = useState(false);
  const [defaultExpiry, setDefaultExpiry] = useState(7);
  const [previewEnabled, setPreviewEnabled] = useState(false);
  const [agentPolicy, setAgentPolicy] = useState<ArtifactAgentPublishPolicy>(
    ArtifactAgentPublishPolicy.REQUIRE_APPROVAL,
  );

  useEffect(() => {
    if (!data) return;
    setExternalSharing(data.artifactExternalSharingEnabled);
    setPublicPublishing(data.artifactPublicPublishingEnabled);
    setDefaultExpiry(data.artifactDefaultLinkExpiryDays);
    setPreviewEnabled(data.artifactPreviewEnabled);
    setAgentPolicy(data.artifactAgentPublishPolicy);
  }, [data]);

  const update = trpc.workspace.update.useMutation({
    onSuccess: async () => {
      await utils.workspace.current.invalidate();
      toast.success("Artifact settings saved.");
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <>
      <Topbar
        title="Artifact settings"
        subtitle="Review, sharing, publishing, and preview policy"
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          <Section
            title="Sharing & publishing"
            hint="New artifacts are private. Existing artifacts remain workspace-visible after migration."
          >
            <div className="space-y-5 rounded-lg border border-border bg-card/40 p-5">
              <Toggle
                checked={externalSharing}
                onChange={setExternalSharing}
                disabled={!canEdit}
                label="Enable expiring external share links"
                hint="Owners can publish an accepted immutable version to a revocable, unguessable link."
              />
              <Toggle
                checked={publicPublishing}
                onChange={setPublicPublishing}
                disabled={!canEdit}
                label="Allow public publishing"
                hint="Reserved for public gallery-style publishing. Link sharing remains separately controlled above."
              />
              <label className="block max-w-xs text-sm">
                <span className="font-medium">Default link expiry (days)</span>
                <span className="text-meta mb-2 mt-1 block text-muted-foreground">
                  Applied when an owner does not choose a custom expiry.
                </span>
                <Input
                  type="number"
                  min={1}
                  max={365}
                  value={defaultExpiry}
                  disabled={!canEdit}
                  onChange={(event) => setDefaultExpiry(Number(event.target.value) || 1)}
                />
              </label>
            </div>
          </Section>

          <Section
            title="Agents & preview renderer"
            hint="Forge remains the source of truth; renderers receive pinned versions."
          >
            <div className="space-y-5 rounded-lg border border-border bg-card/40 p-5">
              <label className="block text-sm">
                <span className="font-medium">Agent publish policy</span>
                <span className="text-meta mb-2 mt-1 block text-muted-foreground">
                  Controls whether an agent may move accepted work into a published state.
                </span>
                <select
                  value={agentPolicy}
                  disabled={!canEdit}
                  onChange={(event) =>
                    setAgentPolicy(event.target.value as ArtifactAgentPublishPolicy)
                  }
                  className="focus-ring w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="NEVER">Never</option>
                  <option value="REQUIRE_APPROVAL">Require human approval</option>
                  <option value="ALLOW">Allow</option>
                </select>
              </label>
              <Toggle
                checked={previewEnabled}
                onChange={setPreviewEnabled}
                disabled={!canEdit}
                label="Enable Artifact Preview deployments"
                hint="Requires ARTIFACT_PREVIEW_URL and a scoped ARTIFACT_PREVIEW_TOKEN on the Forge server."
              />
            </div>
          </Section>

          <div className="flex justify-end">
            <Button
              variant="ember"
              disabled={!canEdit || update.isPending || !data}
              onClick={() =>
                update.mutate({
                  artifactExternalSharingEnabled: externalSharing,
                  artifactPublicPublishingEnabled: publicPublishing,
                  artifactDefaultLinkExpiryDays: defaultExpiry,
                  artifactPreviewEnabled: previewEnabled,
                  artifactAgentPublishPolicy: agentPolicy,
                })
              }
            >
              Save artifact settings
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

function Toggle(props: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled: boolean;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex items-start justify-between gap-4 text-sm">
      <span>
        <span className="block font-medium">{props.label}</span>
        <span className="text-meta mt-1 block text-muted-foreground">{props.hint}</span>
      </span>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
        className="mt-1 h-4 w-4 accent-ember"
      />
    </label>
  );
}
