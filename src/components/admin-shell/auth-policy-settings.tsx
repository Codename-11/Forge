"use client";

import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Combobox } from "@/components/ui/combobox";
import { Section } from "@/components/settings/section";

type AuthenticationMode = "LOCAL_ONLY" | "EXTERNAL_ONLY" | "HYBRID";
type RegistrationMode = "DISABLED" | "INVITE_ONLY" | "OPEN";

const MODES: Array<{ value: AuthenticationMode; label: string; hint: string }> = [
  { value: "LOCAL_ONLY", label: "Local only", hint: "Forge passwords only" },
  { value: "EXTERNAL_ONLY", label: "External only", hint: "OIDC or OAuth providers" },
  { value: "HYBRID", label: "Hybrid", hint: "Passwords and external providers" },
];

export function AuthPolicySettings() {
  const utils = trpc.useUtils();
  const query = trpc.sso.policy.useQuery();
  const providers = trpc.sso.list.useQuery();
  const [mode, setMode] = useState<AuthenticationMode>("HYBRID");
  const [registrationMode, setRegistrationMode] = useState<RegistrationMode>("INVITE_ONLY");
  const [breakGlass, setBreakGlass] = useState(true);
  const [autoRedirectProviderId, setAutoRedirectProviderId] = useState<string>("");
  const [passwordMinLength, setPasswordMinLength] = useState(12);
  const [passwordResetTtlMinutes, setPasswordResetTtlMinutes] = useState(30);
  const [lockoutThreshold, setLockoutThreshold] = useState(10);
  const [lockoutMinutes, setLockoutMinutes] = useState(15);

  useEffect(() => {
    const policy = query.data?.policy;
    if (!policy) return;
    setMode(policy.mode);
    setRegistrationMode(policy.registrationMode);
    setBreakGlass(policy.breakGlassCredentialsEnabled);
    setAutoRedirectProviderId(policy.autoRedirectProviderId ?? "");
    setPasswordMinLength(policy.passwordMinLength);
    setPasswordResetTtlMinutes(policy.passwordResetTtlMinutes);
    setLockoutThreshold(policy.lockoutThreshold);
    setLockoutMinutes(policy.lockoutMinutes);
  }, [query.data]);

  const update = trpc.sso.updatePolicy.useMutation({
    onSuccess: async () => {
      await utils.sso.policy.invalidate();
      toast.success("Authentication policy saved.");
    },
    onError: (error) => toast.error(error.message),
  });

  const enabledProviders = (providers.data ?? []).filter((provider) => provider.enabled);
  const externalOnlyWarning = mode === "EXTERNAL_ONLY" && enabledProviders.length === 0;

  return (
    <Section
      title="Authentication policy"
      hint="Controls how this instance accepts and presents login methods. Workspace access remains governed by memberships and roles."
      actions={
        <Button
          size="sm"
          variant="ember"
          disabled={update.isPending || externalOnlyWarning}
          onClick={() =>
            update.mutate({
              mode,
              registrationMode,
              breakGlassCredentialsEnabled: breakGlass,
              autoRedirectProviderId: autoRedirectProviderId || null,
              passwordMinLength,
              passwordResetTtlMinutes,
              lockoutThreshold,
              lockoutMinutes,
            })
          }
        >
          Save policy
        </Button>
      }
    >
      <div className="space-y-4 rounded-lg border border-border bg-card/40 p-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {MODES.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => setMode(item.value)}
              className={`focus-ring rounded-md border p-3 text-left transition-colors ${
                mode === item.value
                  ? "border-ember/60 bg-ember/10"
                  : "border-border bg-background hover:bg-subtle"
              }`}
            >
              <div className="text-sm font-medium">{item.label}</div>
              <div className="mt-1 text-xs text-muted-foreground">{item.hint}</div>
            </button>
          ))}
        </div>

        {externalOnlyWarning && (
          <div className="rounded-md border border-danger/30 bg-danger/5 p-3 text-xs text-danger">
            Enable at least one external provider before selecting external-only authentication.
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1.5 text-xs">
            <span className="font-medium">Registration</span>
            <Combobox
              value={registrationMode}
              onChange={(value) => value && setRegistrationMode(value as RegistrationMode)}
              options={[
                { value: "DISABLED", label: "Administrators only" },
                { value: "INVITE_ONLY", label: "Invite only" },
                { value: "OPEN", label: "Open registration" },
              ]}
              ariaLabel="Registration policy"
              matchTriggerWidth
              className="h-9 w-full justify-between px-2.5"
            />
          </label>
          <label className="grid gap-1.5 text-xs">
            <span className="font-medium">Automatic redirect</span>
            <Combobox
              value={autoRedirectProviderId || null}
              onChange={(value) => setAutoRedirectProviderId(value ?? "")}
              options={enabledProviders.map((provider) => ({
                value: provider.id,
                label: `Redirect to ${provider.name}`,
              }))}
              disabled={mode === "LOCAL_ONLY"}
              allowNone
              noneLabel="Show provider chooser"
              placeholder="Show provider chooser"
              ariaLabel="Automatic redirect provider"
              matchTriggerWidth
              className="h-9 w-full justify-between px-2.5"
            />
          </label>
        </div>

        <label className="flex items-start gap-2.5 rounded-md border border-border bg-background/50 p-3">
          <input
            type="checkbox"
            checked={breakGlass}
            onChange={(event) => setBreakGlass(event.target.checked)}
            className="mt-0.5 accent-ember"
          />
          <span className="text-xs">
            Protected break-glass operator login
            <span className="mt-0.5 block text-muted-foreground">
              Keeps the environment-backed instance administrator available at /signin/local when an
              external provider fails.
            </span>
          </span>
        </label>

        {breakGlass && query.data && !query.data.breakGlassConfigured && (
          <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 p-3 text-xs text-warning">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Configure ADMIN_EMAIL and ADMIN_PASSWORD before enabling break glass.
          </div>
        )}

        <details className="rounded-md border border-border bg-background/40 p-3">
          <summary className="focus-ring cursor-pointer text-xs font-medium">
            Password and lockout policy
          </summary>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <PolicyNumber
              label="Minimum length"
              value={passwordMinLength}
              min={8}
              max={128}
              onChange={setPasswordMinLength}
            />
            <PolicyNumber
              label="Reset expiry (min)"
              value={passwordResetTtlMinutes}
              min={5}
              max={1440}
              onChange={setPasswordResetTtlMinutes}
            />
            <PolicyNumber
              label="Failed attempts"
              value={lockoutThreshold}
              min={3}
              max={100}
              onChange={setLockoutThreshold}
            />
            <PolicyNumber
              label="Lockout (min)"
              value={lockoutMinutes}
              min={1}
              max={1440}
              onChange={setLockoutMinutes}
            />
          </div>
        </details>
      </div>
    </Section>
  );
}

function PolicyNumber({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="grid gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Math.max(min, Math.min(max, Number(event.target.value))))}
      />
    </label>
  );
}
