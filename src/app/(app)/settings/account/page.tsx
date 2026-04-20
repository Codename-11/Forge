"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useTheme } from "next-themes";
import { Topbar } from "@/components/topbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Section } from "@/components/settings/section";
import { trpc } from "@/lib/trpc";
import { useIsMac } from "@/lib/platform";

const COMMON_TIMEZONES = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Toronto",
  "America/Sao_Paulo",
  "UTC",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Moscow",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

const COMMON_LOCALES = [
  { code: "en-US", label: "English (US)" },
  { code: "en-GB", label: "English (UK)" },
  { code: "en-CA", label: "English (Canada)" },
  { code: "de-DE", label: "Deutsch" },
  { code: "fr-FR", label: "Français" },
  { code: "es-ES", label: "Español" },
  { code: "pt-BR", label: "Português (BR)" },
  { code: "ja-JP", label: "日本語" },
  { code: "zh-CN", label: "中文 (简体)" },
];

export default function AccountPage() {
  const { data: me, refetch } = trpc.workspace.me.useQuery();
  const { theme: currentTheme, setTheme } = useTheme();
  const isMac = useIsMac();

  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [timezone, setTimezone] = useState<string>("");
  const [locale, setLocale] = useState<string>("");
  const [timeFormat, setTimeFormat] = useState<"12h" | "24h">("12h");
  const [browserTz, setBrowserTz] = useState<string>("");
  const [browserLocale, setBrowserLocale] = useState<string>("");

  useEffect(() => {
    if (typeof Intl !== "undefined") {
      try {
        setBrowserTz(Intl.DateTimeFormat().resolvedOptions().timeZone);
      } catch {}
      try {
        setBrowserLocale(Intl.DateTimeFormat().resolvedOptions().locale);
      } catch {}
    }
  }, []);

  useEffect(() => {
    if (!me) return;
    setName(me.user.name ?? "");
    setHandle(me.user.handle ?? "");
    setTimezone(me.user.timezone ?? "");
    setLocale(me.user.locale ?? "");
    setTimeFormat((me.user.timeFormat as "12h" | "24h" | null) ?? "12h");
  }, [me]);

  const update = trpc.workspace.updatePreferences.useMutation({
    onSuccess: () => {
      toast.success("Preferences saved.");
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const effectiveTz = timezone || browserTz || "UTC";
  const effectiveLocale = locale || browserLocale || "en-US";

  const previewDate = new Date();
  let preview = "";
  try {
    preview = new Intl.DateTimeFormat(effectiveLocale, {
      timeZone: effectiveTz,
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
      hourCycle: timeFormat === "24h" ? "h23" : "h12",
      timeZoneName: "short",
    }).format(previewDate);
  } catch {
    preview = previewDate.toISOString();
  }

  return (
    <>
      <Topbar title="Account" subtitle="Profile, timezone, locale, and theme." />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-6 p-6">
          <Section title="Profile">
            <div className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-card/40 p-4 sm:grid-cols-2">
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Handle">
                <Input
                  value={handle}
                  onChange={(e) => setHandle(e.target.value.replace(/[^a-z0-9_-]/gi, ""))}
                  placeholder="alice"
                />
              </Field>
              <Field label="Email">
                <Input value={me?.user.email ?? ""} disabled />
              </Field>
              <Field label="Platform">
                <div className="flex h-8 items-center gap-2 rounded-md border border-input bg-background/60 px-2 text-sm">
                  <Badge>{isMac ? "macOS" : "Windows / Linux"}</Badge>
                  <span className="text-muted-foreground">detected</span>
                </div>
              </Field>
            </div>
          </Section>

          <Section
            title="Regional"
            actions={
              <span className="font-mono text-[11px] text-muted-foreground">{preview}</span>
            }
          >
            <div className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-card/40 p-4 sm:grid-cols-2">
              <Field label="Timezone">
                <select
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value="">Browser default ({browserTz || "—"})</option>
                  {COMMON_TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                  {timezone && !COMMON_TIMEZONES.includes(timezone) && (
                    <option value={timezone}>{timezone}</option>
                  )}
                </select>
              </Field>
              <Field label="Locale">
                <select
                  value={locale}
                  onChange={(e) => setLocale(e.target.value)}
                  className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value="">Browser default ({browserLocale || "—"})</option>
                  {COMMON_LOCALES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label} · {l.code}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Time format">
                <div className="flex h-8 items-center gap-1 rounded-md bg-subtle p-0.5 text-[11px]">
                  {(["12h", "24h"] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setTimeFormat(f)}
                      className={
                        "focus-ring flex-1 rounded px-2 py-1 transition-colors " +
                        (timeFormat === f
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground")
                      }
                    >
                      {f === "12h" ? "12-hour · 3:04 PM" : "24-hour · 15:04"}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Theme">
                <div className="flex h-8 items-center gap-1 rounded-md bg-subtle p-0.5 text-[11px]">
                  {(["light", "dark", "system"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTheme(t)}
                      className={
                        "focus-ring flex-1 rounded px-2 py-1 capitalize transition-colors " +
                        (currentTheme === t
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground")
                      }
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </Field>
            </div>
          </Section>

          <div className="flex justify-end gap-2">
            <Button
              variant="ember"
              disabled={update.isPending}
              onClick={() =>
                update.mutate({
                  name: name.trim() || undefined,
                  handle: handle.trim() || undefined,
                  timezone: timezone || null,
                  locale: locale || null,
                  timeFormat,
                  theme: (currentTheme as "light" | "dark" | "system" | undefined) ?? null,
                })
              }
            >
              {update.isPending ? "Saving…" : "Save preferences"}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}
