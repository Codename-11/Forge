"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { Section } from "@/components/settings/section";
import { SectionDivider } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { writeAppearanceCookie } from "@/lib/appearance-cookie";

type Density = "compact" | "comfortable";
type TextSize = "default" | "larger";
type Motion = "full" | "reduced";
type Background =
  | "grid"
  | "glow"
  | "dots"
  | "reactive"
  | "particles"
  | "none";

/**
 * Appearance settings — per-user, server-saved.
 *
 * Two knobs that re-flow the entire product without a page reload:
 *   - Density:   compact (current) | comfortable (more breathing room)
 *   - Text size: default (current) | larger (+1px)
 *
 * The provider on the workspace shell mirrors the saved values onto
 * `<html>` via `data-density` / `data-textsize`; the four utility
 * classes in `globals.css` (`.text-id`, `.text-meta`, `.text-filename`,
 * `.text-subtitle`) cascade off those attributes.
 *
 * UX choices worth flagging:
 *   - Auto-save on click. No "Save preferences" button — every toggle
 *     mutates immediately and the live preview row at the top reflects
 *     the change before the network round-trip resolves (optimistic
 *     `data-*` writes on the html element).
 *   - The previews aren't decorative — they use the actual utility
 *     classes the rest of the app will use, so what you see is exactly
 *     what every issue ID / timestamp will look like.
 *   - Cards are big, deliberate radio targets. Forge is keyboard-driven
 *     elsewhere; the personality knob is a place to slow down.
 */
export default function AppearancePage() {
  const utils = trpc.useUtils();
  const { data: me } = trpc.user.me.useQuery();

  const [density, setDensity] = useState<Density>("compact");
  const [textSize, setTextSize] = useState<TextSize>("default");
  const [motion, setMotion] = useState<Motion>("full");
  const [background, setBackground] = useState<Background>("grid");

  useEffect(() => {
    if (!me) return;
    setDensity(me.density === "comfortable" ? "comfortable" : "compact");
    setTextSize(me.textSize === "larger" ? "larger" : "default");
    setMotion(me.motion === "reduced" ? "reduced" : "full");
    setBackground(
      me.backgroundStyle === "glow" ||
        me.backgroundStyle === "dots" ||
        me.backgroundStyle === "reactive" ||
        me.backgroundStyle === "particles" ||
        me.backgroundStyle === "none"
        ? me.backgroundStyle
        : "grid",
    );
  }, [me]);

  const update = trpc.user.updateAppearance.useMutation({
    onSuccess: () => {
      utils.user.me.invalidate();
      toast.success("Appearance saved.");
    },
    onError: (e) => toast.error(e.message),
  });

  function chooseDensity(next: Density) {
    if (next === density) return;
    setDensity(next);
    // Optimistic DOM update so the preview row + the rest of the app
    // re-flow before the round-trip resolves. Cookie is mirrored so
    // the next page reload skips the FOUC entirely.
    document.documentElement.setAttribute("data-density", next);
    writeAppearanceCookie({ density: next, textSize, motion, background });
    update.mutate({ density: next });
  }

  function chooseTextSize(next: TextSize) {
    if (next === textSize) return;
    setTextSize(next);
    document.documentElement.setAttribute("data-textsize", next);
    writeAppearanceCookie({ density, textSize: next, motion, background });
    update.mutate({ textSize: next });
  }

  function chooseMotion(next: Motion) {
    if (next === motion) return;
    setMotion(next);
    // Flips the forge-* motion layer live: data-motion="off" freezes
    // every ambient animation to its static fallback (independent of the
    // OS reduced-motion media query, which still also gates them).
    document.documentElement.setAttribute(
      "data-motion",
      next === "reduced" ? "off" : "on",
    );
    writeAppearanceCookie({ density, textSize, motion: next, background });
    update.mutate({ motion: next });
  }

  function chooseBackground(next: Background) {
    if (next === background) return;
    setBackground(next);
    // Live-swaps the shell's ambient background layer (.forge-page-bg)
    // via the data-bg attribute the provider also stamps.
    document.documentElement.setAttribute("data-bg", next);
    writeAppearanceCookie({ density, textSize, motion, background: next });
    update.mutate({ backgroundStyle: next });
  }

  return (
    <>
      <Topbar
        title="Appearance"
        subtitle="Tune the rhythm of the interface — saved to your account."
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-10 p-8">
          {/* Hero / live preview ------------------------------------- */}
          <section className="rounded-2xl border border-border bg-card/40 p-6">
            <div className="mb-1 font-mono text-[0.6875rem] uppercase tracking-[0.2em] text-muted-foreground">
              Live preview
            </div>
            <div className="mb-5 text-sm text-muted-foreground">
              The two rows below are the actual utility classes used across
              Forge. They will reshape across the whole app the moment you
              pick a different option.
            </div>

            <div className="space-y-3 rounded-xl border border-border/80 bg-background/60 p-4">
              <div className="flex items-center gap-3">
                <span className="text-id rounded border border-border bg-subtle/60 px-1.5 py-0.5 text-muted-foreground">
                  AXI-1024
                </span>
                <span className="text-sm font-medium text-foreground">
                  Tighten the dispatcher&apos;s idle release window
                </span>
                <span className="text-meta ml-auto text-muted-foreground">
                  updated 4m ago
                </span>
              </div>
              <div className="flex items-center gap-3 border-t border-border/60 pt-3">
                <span className="text-id rounded border border-border bg-subtle/60 px-1.5 py-0.5 text-muted-foreground">
                  PER-71
                </span>
                <span className="text-sm font-medium text-foreground">
                  Re-style the inbox empty state
                </span>
                <span className="text-meta ml-auto text-muted-foreground">
                  updated yesterday
                </span>
              </div>
            </div>

            <div className="mt-4 flex items-center gap-2 text-[0.6875rem] text-muted-foreground">
              <span className="inline-block h-1 w-1 rounded-full bg-ember" />
              <span>
                {density === "compact" ? "Compact" : "Comfortable"} ·{" "}
                {textSize === "larger" ? "Larger text" : "Default text"}
              </span>
            </div>
          </section>

          <SectionDivider />

          {/* Density -------------------------------------------------- */}
          <Section
            title="Density"
            hint="Spacing and identifier sizes across lists, tables, and overlays."
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <ChoiceCard
                active={density === "compact"}
                onClick={() => chooseDensity("compact")}
                title="Compact"
                blurb="Tighter spacing, smaller identifiers. Pack more on screen."
                sample={<DensitySample tight />}
              />
              <ChoiceCard
                active={density === "comfortable"}
                onClick={() => chooseDensity("comfortable")}
                title="Comfortable"
                blurb="More breathing room, slightly larger labels. Easier to scan."
                sample={<DensitySample />}
              />
            </div>
          </Section>

          <SectionDivider />

          {/* Text size ------------------------------------------------ */}
          <Section
            title="Text size"
            hint="Bumps the smallest type in the UI by ~1px. Body copy stays the same."
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <ChoiceCard
                active={textSize === "default"}
                onClick={() => chooseTextSize("default")}
                title="Default"
                blurb="The standard sizes Forge ships with."
                sample={
                  <span className="font-mono text-[0.6875rem] text-muted-foreground">
                    AXI-1024 · 11px meta
                  </span>
                }
              />
              <ChoiceCard
                active={textSize === "larger"}
                onClick={() => chooseTextSize("larger")}
                title="Larger"
                blurb="One step up across IDs, timestamps, and overlays."
                sample={
                  <span className="font-mono text-[0.6875rem] text-muted-foreground">
                    AXI-1024 · 12px meta
                  </span>
                }
              />
            </div>
          </Section>

          <SectionDivider />

          {/* Motion --------------------------------------------------- */}
          <Section
            title="Motion"
            hint="Ambient animation — the grid drift, streaming shimmer, count-ups, and presence breath. Your OS reduced-motion setting is always respected; this is an in-app override."
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <ChoiceCard
                active={motion === "full"}
                onClick={() => chooseMotion("full")}
                title="Full"
                blurb="Subtle, restrained motion across the app."
                sample={
                  <span className="flex items-center gap-2 text-[0.6875rem] text-muted-foreground">
                    <span className="inline-flex h-1.5 w-1.5 items-center justify-center">
                      <span className="h-1.5 w-1.5 rounded-full bg-success shadow-[0_0_0_3px_hsl(var(--success)/0.25)] motion-safe:animate-forge-breath" />
                    </span>
                    ambient
                  </span>
                }
              />
              <ChoiceCard
                active={motion === "reduced"}
                onClick={() => chooseMotion("reduced")}
                title="Reduced"
                blurb="Freeze every ambient animation to its static state."
                sample={
                  <span className="flex items-center gap-2 text-[0.6875rem] text-muted-foreground">
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
                    static
                  </span>
                }
              />
            </div>
          </Section>

          <SectionDivider />

          {/* Background ----------------------------------------------- */}
          <Section
            title="Background"
            hint="The ambient layer behind every page. Drifts gently when Motion is Full; static otherwise. Default is the grid."
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <ChoiceCard
                active={background === "grid"}
                onClick={() => chooseBackground("grid")}
                title="Grid"
                blurb="The default paper grid. Quiet, structural."
                sample={<BackgroundSample variant="grid" />}
              />
              <ChoiceCard
                active={background === "glow"}
                onClick={() => chooseBackground("glow")}
                title="Glow"
                blurb="Dot grid with a slow ember bloom drifting through it."
                sample={<BackgroundSample variant="glow" />}
              />
              <ChoiceCard
                active={background === "dots"}
                onClick={() => chooseBackground("dots")}
                title="Dots"
                blurb="A fine dot field. Lighter than the grid."
                sample={<BackgroundSample variant="dots" />}
              />
              <ChoiceCard
                active={background === "reactive"}
                onClick={() => chooseBackground("reactive")}
                title="Reactive dot grid"
                blurb="Live canvas. Dots near the cursor scale and brighten toward ember as you move."
                sample={<BackgroundSample variant="reactive" />}
              />
              <ChoiceCard
                active={background === "particles"}
                onClick={() => chooseBackground("particles")}
                title="Particles"
                blurb="Free-floating embers that drift and lean toward the cursor. Live canvas."
                sample={<BackgroundSample variant="particles" />}
              />
              <ChoiceCard
                active={background === "none"}
                onClick={() => chooseBackground("none")}
                title="None"
                blurb="Plain paper. No ambient layer at all."
                sample={<BackgroundSample variant="none" />}
              />
            </div>
          </Section>

          <p className="pb-4 text-center text-[0.6875rem] text-muted-foreground">
            Saved automatically. Changes apply across every workspace.
          </p>
        </div>
      </div>
    </>
  );
}

function ChoiceCard({
  active,
  onClick,
  title,
  blurb,
  sample,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  blurb: string;
  sample: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        "focus-ring group flex flex-col items-stretch gap-3 rounded-xl border p-4 text-left transition-colors " +
        (active
          ? "border-ember/60 bg-ember/5 shadow-[0_0_0_1px_hsl(var(--ember)/0.4)]"
          : "border-border bg-card/40 hover:bg-subtle/40")
      }
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold tracking-tight text-foreground">
          {title}
        </span>
        <span
          className={
            "h-3 w-3 rounded-full border transition-colors " +
            (active
              ? "border-ember bg-ember"
              : "border-border bg-background group-hover:border-foreground/30")
          }
          aria-hidden="true"
        />
      </div>
      <div className="text-xs leading-relaxed text-muted-foreground">{blurb}</div>
      <div className="mt-1 flex items-center justify-center rounded-md border border-border/70 bg-background/60 px-3 py-3">
        {sample}
      </div>
    </button>
  );
}

function BackgroundSample({
  variant,
}: {
  variant: Background;
}) {
  // Honest, self-contained preview of each background (doesn't depend on
  // the user's current data-bg). Small static swatch.
  const common = "h-12 w-full overflow-hidden rounded-md border border-border/70";
  if (variant === "none") {
    return <div className={`${common} bg-background`} />;
  }
  if (variant === "reactive") {
    // Static hint of the live canvas: dot field with a brightened,
    // ember-tinted hot spot to suggest the cursor falloff.
    return (
      <div
        className={`${common} relative bg-background`}
        style={{
          backgroundImage:
            "radial-gradient(hsl(var(--foreground) / 0.16) 1px, transparent 1.5px)",
          backgroundSize: "10px 10px",
        }}
      >
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(circle at 38% 50%, hsl(var(--ember) / 0.45) 0%, transparent 42%)",
            mixBlendMode: "plus-lighter",
          }}
        />
      </div>
    );
  }
  if (variant === "particles") {
    // Static hint: scattered foreground dots with a couple of ember
    // accents floating in the field.
    return (
      <div
        className={`${common} relative bg-background`}
        style={{
          backgroundImage: [
            "radial-gradient(circle at 18% 30%, hsl(var(--foreground) / 0.35) 1px, transparent 2px)",
            "radial-gradient(circle at 62% 22%, hsl(var(--foreground) / 0.25) 1px, transparent 2px)",
            "radial-gradient(circle at 80% 64%, hsl(var(--ember) / 0.7) 1.5px, transparent 3px)",
            "radial-gradient(circle at 44% 72%, hsl(var(--foreground) / 0.3) 1px, transparent 2px)",
            "radial-gradient(circle at 30% 58%, hsl(var(--ember) / 0.6) 1.5px, transparent 3px)",
            "radial-gradient(circle at 90% 34%, hsl(var(--foreground) / 0.2) 1px, transparent 2px)",
          ].join(","),
        }}
      />
    );
  }
  if (variant === "grid") {
    return (
      <div
        className={`${common} bg-background`}
        style={{
          backgroundImage:
            "linear-gradient(to right, hsl(var(--border) / 0.6) 1px, transparent 1px), linear-gradient(to bottom, hsl(var(--border) / 0.6) 1px, transparent 1px)",
          backgroundSize: "12px 12px",
        }}
      />
    );
  }
  if (variant === "dots") {
    return (
      <div
        className={`${common} bg-background`}
        style={{
          backgroundImage:
            "radial-gradient(hsl(var(--foreground) / 0.2) 1px, transparent 1.5px)",
          backgroundSize: "10px 10px",
        }}
      />
    );
  }
  // glow
  return (
    <div
      className={`${common} relative bg-background`}
      style={{
        backgroundImage:
          "radial-gradient(hsl(var(--foreground) / 0.14) 1px, transparent 1.5px)",
        backgroundSize: "11px 11px",
      }}
    >
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at 35% 50%, hsl(var(--ember) / 0.35) 0%, transparent 55%)",
          mixBlendMode: "plus-lighter",
        }}
      />
    </div>
  );
}

function DensitySample({ tight = false }: { tight?: boolean }) {
  // Hard-coded sizes here (rather than the .text-id class) so the
  // preview honestly demonstrates each option regardless of what the
  // user currently has selected at the html level.
  const idCls = tight ? "text-[0.6875rem]" : "text-[0.6875rem]";
  const metaCls = tight ? "text-[0.6875rem]" : "text-xs";
  return (
    <div className="flex w-full items-center gap-2">
      <span
        className={
          "rounded border border-border bg-subtle/60 px-1.5 py-0.5 font-mono text-muted-foreground " +
          idCls
        }
      >
        AXI-12
      </span>
      <span className="truncate text-[0.75rem] text-foreground">Sample issue title</span>
      <span className={"ml-auto text-muted-foreground " + metaCls}>4m ago</span>
    </div>
  );
}
