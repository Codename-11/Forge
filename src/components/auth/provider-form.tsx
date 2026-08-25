"use client";

import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";

export function ProviderButton({
  action,
  providerId,
  icon,
  label,
}: {
  action: (formData: FormData) => Promise<void>;
  providerId: string;
  icon: string;
  label: string;
}) {
  return (
    <form action={action} className="contents">
      <input type="hidden" name="providerId" value={providerId} />
      <button
        type="submit"
        className="focus-ring flex h-10 w-full items-center gap-2.5 rounded-md border border-border bg-background px-3.5 text-[0.8125rem] font-medium text-foreground transition-colors hover:bg-subtle"
      >
        <span className="grid h-[22px] w-[22px] place-items-center rounded-sm bg-subtle font-mono text-[0.6875rem] font-semibold">
          {icon}
        </span>
        <span>{label}</span>
      </button>
    </form>
  );
}

/**
 * Browser-side submission is intentional: a Server Component cannot mutate
 * the cookies used by Auth.js. The visible progress state also gives users a
 * way back if a provider is unreachable.
 */
export function AutoRedirectProvider({
  action,
  providerId,
  providerName,
}: {
  action: (formData: FormData) => Promise<void>;
  providerId: string;
  providerName: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    formRef.current?.requestSubmit();
  }, []);

  return (
    <form ref={formRef} action={action} className="space-y-4">
      <input type="hidden" name="providerId" value={providerId} />
      <div className="flex items-center gap-3 rounded-md border border-border bg-card/40 p-4 text-sm">
        <Loader2 className="h-4 w-4 animate-spin text-ember motion-reduce:animate-none" />
        <span>
          Continuing to <strong>{providerName}</strong>…
        </span>
      </div>
      <button
        type="submit"
        className="focus-ring text-xs text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground"
      >
        Continue now
      </button>
    </form>
  );
}
