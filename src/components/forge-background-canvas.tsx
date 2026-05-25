"use client";
import { useEffect, useRef, useState } from "react";

/**
 * ForgeBackgroundCanvas
 *
 * Real <canvas> ambient backgrounds — the two variants that can't be
 * expressed as a static CSS layer like `.forge-page-bg`:
 *
 *   - "reactive"  — mouse-reactive dot grid. Dots near the cursor scale
 *                   and brighten with a smooth lerp follow; the inner
 *                   core blends toward ember. (Design B1.)
 *   - "particles" — free-floating particles with mouse-magnetism, ambient
 *                   drift, edge-fade and recycling; ~12% ember. (B2.)
 *
 * Ported from the design-system reference
 * (project/js/backgrounds-canvas.jsx) but tuned for a full-viewport
 * ambient layer rather than a 760×460 artboard.
 *
 * Positioning matches `.forge-page-bg`: absolute inset-0 -z-10 and
 * pointer-events-none. Because the layer must NOT eat clicks, mouse
 * reactivity comes from a `window` pointer listener (translated into the
 * canvas's local CSS coordinate space via getBoundingClientRect), not
 * from listeners on the canvas itself.
 *
 * Gating:
 *   - This component is only mounted by the shell when the user's
 *     `data-bg` pref is "reactive"/"particles", but it ALSO reads
 *     `data-bg` off <html> itself and renders inert (clears + stops the
 *     rAF) when the live pref doesn't match its `variant`. That keeps it
 *     correct even if both variants are mounted or the pref flips live.
 *   - Motion is gated on `data-motion="on"` AND
 *     `prefers-reduced-motion: no-preference`. When motion is off/reduced
 *     we paint exactly one static frame (t=0, no cursor) and stop the loop.
 *
 * Tokens (`--foreground`, `--ember`, `--muted-foreground`, `--border`)
 * are read via getComputedStyle on the canvas's OWN element, so the
 * `.dark` scope resolves. A MutationObserver on <html> re-reads them on
 * theme/data-bg changes.
 */

type Variant = "reactive" | "particles";

interface Tokens {
  fg: string;
  ember: string;
  muted: string;
  border: string;
}

const FALLBACK: Tokens = {
  fg: "0 0% 0%",
  ember: "25 80% 50%",
  muted: "0 0% 45%",
  border: "0 0% 80%",
};

const HSL = (triplet: string, alpha: number) => `hsl(${triplet} / ${alpha})`;
const easeOutCubic = (k: number) => 1 - Math.pow(1 - k, 3);

interface Particle {
  x: number;
  y: number;
  tx: number;
  ty: number;
  size: number;
  alpha: number;
  target: number;
  dx: number;
  dy: number;
  mag: number;
  ember: boolean;
}

function spawn(w: number, h: number, minSize: number, emberFrac: number): Particle {
  return {
    x: Math.floor(Math.random() * w),
    y: Math.floor(Math.random() * h),
    tx: 0,
    ty: 0,
    size: Math.floor(Math.random() * 2) + minSize, // ~0.6 – 2.6
    alpha: 0,
    target: parseFloat((Math.random() * 0.45 + 0.12).toFixed(2)), // 0.12 – 0.57
    dx: (Math.random() - 0.5) * 0.12, // slow ambient drift
    dy: (Math.random() - 0.5) * 0.12,
    mag: 0.4 + Math.random() * 4.2, // wide spread → parallax depth
    ember: Math.random() < emberFrac,
  };
}

export function ForgeBackgroundCanvas({ variant }: { variant: Variant }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    let raf = 0;

    // --- Live token cache, re-read on theme/data-bg change -----------
    let tokens: Tokens = FALLBACK;
    function readTokens() {
      const s = getComputedStyle(canvas as Element);
      const read = (n: string) => s.getPropertyValue("--" + n).trim();
      tokens = {
        fg: read("foreground") || FALLBACK.fg,
        ember: read("ember") || FALLBACK.ember,
        muted: read("muted-foreground") || FALLBACK.muted,
        border: read("border") || FALLBACK.border,
      };
    }
    readTokens();

    // --- Sizing ------------------------------------------------------
    function resize() {
      const w = canvas!.clientWidth;
      const h = canvas!.clientHeight;
      canvas!.width = Math.max(1, Math.round(w * dpr));
      canvas!.height = Math.max(1, Math.round(h * dpr));
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // --- Pointer (window-level so the layer stays click-through) -----
    // Stored in the canvas's local CSS coordinate space.
    const pointer = { x: -9999, y: -9999, target: { x: -9999, y: -9999 }, inside: false };
    // Particles use a center-relative mouse vector.
    const mouse = { x: 0, y: 0 };

    function onPointerMove(e: PointerEvent) {
      const r = canvas!.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const inside = x >= 0 && y >= 0 && x <= r.width && y <= r.height;
      if (!inside) {
        pointer.inside = false;
        pointer.target = { x: -9999, y: -9999 };
        mouse.x = 0;
        mouse.y = 0;
        return;
      }
      pointer.inside = true;
      pointer.target = { x, y };
      mouse.x = x;
      mouse.y = y;
    }
    function onPointerLeaveWindow() {
      pointer.inside = false;
      pointer.target = { x: -9999, y: -9999 };
      mouse.x = 0;
      mouse.y = 0;
    }
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerleave", onPointerLeaveWindow);
    document.addEventListener("pointerleave", onPointerLeaveWindow);

    // --- Particle pool state -----------------------------------------
    const PARTICLES = {
      QUANTITY: 160, // scaled up vs the artboard's 110 for a full viewport
      STATICITY: 36, // lower = stronger pull; higher than artboard (full window)
      EASE: 32,
      MIN_SIZE: 0.6,
      EMBER_FRAC: 0.12,
    };
    let particles: Particle[] | null = null;
    let lastW = 0;
    let lastH = 0;

    // --- Draw routines ----------------------------------------------
    function drawReactive(t: number, w: number, h: number) {
      // Lerp pointer toward target for a buttery follow.
      const lerp = 0.18;
      pointer.x += (pointer.target.x - pointer.x) * lerp;
      pointer.y += (pointer.target.y - pointer.y) * lerp;

      const step = 26; // slightly looser than the artboard (22) for big viewports
      const cols = Math.ceil(w / step) + 1;
      const rows = Math.ceil(h / step) + 1;
      const ox = (w - (cols - 1) * step) / 2;
      const oy = (h - (rows - 1) * step) / 2;

      const radius = 130;
      const r2 = radius * radius;

      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          const x = ox + i * step;
          const y = oy + j * step;
          const dx = x - pointer.x;
          const dy = y - pointer.y;
          const d2 = dx * dx + dy * dy;
          const k = pointer.inside ? Math.max(0, 1 - d2 / r2) : 0;
          const ambient = 0.5 + 0.06 * Math.sin(t * 0.6 + (i + j) * 0.18);
          const dotR = 0.9 + k * 2.1;
          const inner = easeOutCubic(k);
          const fgA = 0.1 * ambient + 0.18 * (1 - inner) * k;
          const emA = 0.55 * inner;
          ctx!.beginPath();
          ctx!.fillStyle = HSL(tokens.fg, fgA);
          ctx!.arc(x, y, dotR, 0, Math.PI * 2);
          ctx!.fill();
          if (emA > 0.02) {
            ctx!.beginPath();
            ctx!.fillStyle = HSL(tokens.ember, emA);
            ctx!.arc(x, y, dotR, 0, Math.PI * 2);
            ctx!.fill();
          }
        }
      }
    }

    function drawParticles(t: number, w: number, h: number) {
      if (!w || !h) return;
      const { QUANTITY, STATICITY, EASE, MIN_SIZE, EMBER_FRAC } = PARTICLES;

      const needsReseed =
        !particles ||
        Math.abs(lastW - w) > 48 ||
        Math.abs(lastH - h) > 48;
      if (needsReseed) {
        const arr: Particle[] = [];
        for (let i = 0; i < QUANTITY; i++) arr.push(spawn(w, h, MIN_SIZE, EMBER_FRAC));
        particles = arr;
        lastW = w;
        lastH = h;
      }
      const pool = particles!;

      const cx = w / 2;
      const cy = h / 2;
      const mx = mouse.x ? mouse.x - cx : 0;
      const my = mouse.y ? mouse.y - cy : 0;

      for (let i = 0; i < pool.length; i++) {
        const p = pool[i];

        // 1) Edge-fade
        const edges = [
          p.x + p.tx - p.size,
          w - p.x - p.tx - p.size,
          p.y + p.ty - p.size,
          h - p.y - p.ty - p.size,
        ];
        const closest = Math.min(...edges);
        const k = Math.max(0, Math.min(1, closest / 20));
        if (k > 0.99) {
          p.alpha = Math.min(p.target, p.alpha + 0.02);
        } else {
          p.alpha = p.target * k;
        }

        // 2) Drift + 3) Magnetism (lerped)
        p.x += p.dx;
        p.y += p.dy;
        p.tx += (mx / (STATICITY / p.mag) - p.tx) / EASE;
        p.ty += (my / (STATICITY / p.mag) - p.ty) / EASE;

        // Paint
        ctx!.beginPath();
        ctx!.fillStyle = p.ember
          ? HSL(tokens.ember, p.alpha * 1.15)
          : HSL(tokens.fg, p.alpha);
        ctx!.arc(p.x + p.tx, p.y + p.ty, p.size, 0, Math.PI * 2);
        ctx!.fill();

        // Ember halo bloom
        if (p.ember && p.alpha > 0.08) {
          const haloR = p.size * 6;
          const grad = ctx!.createRadialGradient(
            p.x + p.tx,
            p.y + p.ty,
            0,
            p.x + p.tx,
            p.y + p.ty,
            haloR,
          );
          grad.addColorStop(0, HSL(tokens.ember, p.alpha * 0.35));
          grad.addColorStop(1, HSL(tokens.ember, 0));
          ctx!.fillStyle = grad;
          ctx!.beginPath();
          ctx!.arc(p.x + p.tx, p.y + p.ty, haloR, 0, Math.PI * 2);
          ctx!.fill();
        }

        // 4) Recycle if off-screen
        const xx = p.x + p.tx;
        const yy = p.y + p.ty;
        if (xx < -p.size || xx > w + p.size || yy < -p.size || yy > h + p.size) {
          pool[i] = spawn(w, h, MIN_SIZE, EMBER_FRAC);
        }
      }
    }

    // --- Gating + loop -----------------------------------------------
    const isActive = () =>
      document.documentElement.getAttribute("data-bg") === variant;
    const motionOn = () =>
      document.documentElement.getAttribute("data-motion") !== "off" &&
      (!window.matchMedia ||
        window.matchMedia("(prefers-reduced-motion: no-preference)").matches);

    const t0 = performance.now();
    function paint(t: number) {
      const w = canvas!.clientWidth;
      const h = canvas!.clientHeight;
      ctx!.clearRect(0, 0, w, h);
      if (!isActive()) return; // inert: cleared, nothing drawn
      if (variant === "reactive") drawReactive(t, w, h);
      else drawParticles(t, w, h);
    }

    function frame(now: number) {
      const t = (now - t0) / 1000;
      paint(t);
      if (motionOn() && isActive()) {
        raf = requestAnimationFrame(frame);
      } else {
        raf = 0;
      }
    }

    // Kick the loop, or paint a single static frame when motion is off.
    function start() {
      if (raf) cancelAnimationFrame(raf);
      if (motionOn()) {
        raf = requestAnimationFrame(frame);
      } else {
        // One static frame at rest (no cursor influence).
        pointer.inside = false;
        pointer.target = { x: -9999, y: -9999 };
        pointer.x = -9999;
        pointer.y = -9999;
        mouse.x = 0;
        mouse.y = 0;
        paint(0);
      }
    }
    start();

    // --- React to theme / data-bg / data-motion changes --------------
    const mo = new MutationObserver(() => {
      readTokens();
      start();
    });
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "data-bg", "data-motion"],
    });

    let mql: MediaQueryList | null = null;
    const onMql = () => start();
    if (window.matchMedia) {
      mql = window.matchMedia("(prefers-reduced-motion: no-preference)");
      mql.addEventListener?.("change", onMql);
    }

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerleave", onPointerLeaveWindow);
      document.removeEventListener("pointerleave", onPointerLeaveWindow);
      mql?.removeEventListener?.("change", onMql);
    };
  }, [variant]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 block h-full w-full opacity-40"
    />
  );
}

/**
 * ForgeBackgroundCanvasGate
 *
 * Mounted once in the workspace shell. Reads `data-bg` off <html> and
 * renders the matching canvas variant (or nothing). Listens for live
 * changes via a MutationObserver so flipping the Appearance pref swaps
 * the layer without a reload. The CSS in globals.css hides
 * `.forge-page-bg` whenever data-bg is reactive/particles, so they never
 * double up.
 */
export function ForgeBackgroundCanvasGate() {
  const [bg, setBg] = useState<string | null>(null);

  useEffect(() => {
    const read = () =>
      setBg(document.documentElement.getAttribute("data-bg"));
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-bg"],
    });
    return () => mo.disconnect();
  }, []);

  if (bg === "reactive") return <ForgeBackgroundCanvas variant="reactive" />;
  if (bg === "particles") return <ForgeBackgroundCanvas variant="particles" />;
  return null;
}
