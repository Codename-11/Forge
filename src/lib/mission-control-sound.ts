"use client";

let audioCtx: AudioContext | null = null;
let userInteracted = false;

if (typeof window !== "undefined") {
  const markInteract = () => { userInteracted = true; };
  window.addEventListener("pointerdown", markInteract, { once: true, passive: true });
  window.addEventListener("keydown", markInteract, { once: true, passive: true });
}

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!userInteracted) return null;
  if (audioCtx) return audioCtx;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  audioCtx = new Ctor();
  return audioCtx;
}

function playTone(freq: number, durationMs: number, volume = 0.08): void {
  const ctx = getCtx();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.value = volume;
  // Quick fade-out so it's pleasant and not a click
  gain.gain.setValueAtTime(volume, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durationMs / 1000);
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + durationMs / 1000);
}

const lastPlayed = new Map<string, number>();
const THROTTLE_MS = 60_000;

function shouldPlay(key: string): boolean {
  const now = Date.now();
  const prev = lastPlayed.get(key) ?? 0;
  if (now - prev < THROTTLE_MS) return false;
  lastPlayed.set(key, now);
  return true;
}

export function playRunCompletedSound(agentId?: string): void {
  if (!shouldPlay(`completed:${agentId ?? "_"}`)) return;
  // Pleasant ascending pair.
  playTone(660, 120);
  setTimeout(() => playTone(880, 160), 90);
}

export function playRunStalledSound(agentId?: string): void {
  if (!shouldPlay(`stalled:${agentId ?? "_"}`)) return;
  // Lower descending pair.
  playTone(330, 140);
  setTimeout(() => playTone(247, 200), 120);
}
