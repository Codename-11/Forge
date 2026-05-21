"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

// Full-screen presentation overlay. Frames act as slides; the parent owns
// the slide index + camera moves (eased fit-to-frame), while this overlay
// handles navigation input, the slide HUD, and a laser pointer with a
// fading trail. The canvas renders underneath — the overlay is transparent
// except for the HUD and laser, and `cursor: none` lets the laser dot stand
// in for the pointer.

type TrailPoint = { x: number; y: number; t: number };

const TRAIL_FADE_MS = 480;

export function CanvasPresentation({
  total,
  index,
  slideName,
  onPrev,
  onNext,
  onExit,
  onGoto,
}: {
  total: number;
  index: number;
  slideName?: string | null;
  onPrev: () => void;
  onNext: () => void;
  onExit: () => void;
  onGoto: (i: number) => void;
}) {
  const [laser, setLaser] = useState<{ x: number; y: number } | null>(null);
  const trailRef = useRef<TrailPoint[]>([]);
  const [, setTick] = useState(0);

  // Track the pointer for the laser + trail.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      setLaser({ x: e.clientX, y: e.clientY });
      const trail = trailRef.current;
      trail.push({ x: e.clientX, y: e.clientY, t: performance.now() });
      if (trail.length > 24) trail.shift();
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  // Keyboard navigation. Capture phase so it wins over the canvas' own
  // keymap while presenting.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onExit();
      } else if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") {
        e.preventDefault();
        onNext();
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        onPrev();
      } else if (e.key === "Home") {
        e.preventDefault();
        onGoto(0);
      } else if (e.key === "End") {
        e.preventDefault();
        onGoto(total - 1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onExit, onNext, onPrev, onGoto, total]);

  // Repaint loop to age out the laser trail.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const now = performance.now();
      trailRef.current = trailRef.current.filter((p) => now - p.t < TRAIL_FADE_MS);
      setTick((t) => t + 1);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const onBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onNext();
    },
    [onNext],
  );

  const now = performance.now();
  const trail = trailRef.current;

  return (
    <div
      className="fixed inset-0 z-[60] select-none"
      style={{ cursor: "none" }}
      onClick={onBackdropClick}
      role="presentation"
    >
      {/* Laser trail. */}
      {trail.length > 1 ? (
        <svg className="pointer-events-none fixed inset-0 h-full w-full">
          {trail.slice(1).map((p, i) => {
            const prev = trail[i];
            const age = now - p.t;
            const opacity = Math.max(0, 1 - age / TRAIL_FADE_MS) * 0.5;
            return (
              <line
                key={p.t + "-" + i}
                x1={prev.x}
                y1={prev.y}
                x2={p.x}
                y2={p.y}
                stroke="#ef4444"
                strokeWidth={4}
                strokeLinecap="round"
                opacity={opacity}
              />
            );
          })}
        </svg>
      ) : null}

      {/* Laser dot. */}
      {laser ? (
        <div
          className="pointer-events-none fixed h-3 w-3 rounded-full"
          style={{
            left: laser.x - 6,
            top: laser.y - 6,
            background: "radial-gradient(circle, #fca5a5 0%, #ef4444 60%, rgba(239,68,68,0) 100%)",
            boxShadow: "0 0 12px 4px rgba(239,68,68,0.6)",
          }}
        />
      ) : null}

      {/* HUD — bottom center. Buttons stop propagation so they don't advance. */}
      <div
        className="pointer-events-auto fixed bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-card/90 px-2 py-1.5 shadow-lg backdrop-blur-md"
        style={{ cursor: "default" }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          title="Previous (←)"
          aria-label="Previous slide"
          disabled={index <= 0}
          onClick={onPrev}
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-subtle hover:text-foreground disabled:opacity-40"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="min-w-[5.5rem] text-center text-xs text-muted-foreground">
          <span className="font-mono text-foreground">
            {index + 1}/{total}
          </span>
          {slideName ? <span className="ml-1.5 truncate">· {slideName}</span> : null}
        </span>
        <button
          type="button"
          title="Next (→ / Space)"
          aria-label="Next slide"
          disabled={index >= total - 1}
          onClick={onNext}
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-subtle hover:text-foreground disabled:opacity-40"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        <div className="mx-1 h-6 w-px bg-border" />
        <button
          type="button"
          title="Exit presentation (Esc)"
          aria-label="Exit presentation"
          onClick={onExit}
          className="flex h-8 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-subtle hover:text-foreground"
        >
          <X className="h-4 w-4" /> Exit
        </button>
      </div>
    </div>
  );
}
