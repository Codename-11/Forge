export type RenderableHrefKind = "external" | "internal";

export interface RenderableHref {
  href: string;
  kind: RenderableHrefKind;
}

const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

export function isSafeExternalUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return SAFE_EXTERNAL_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

export function assertSafeExternalUrl(value: string): string {
  const trimmed = value.trim();
  if (!isSafeExternalUrl(trimmed)) {
    throw new Error("External links must use http or https URLs.");
  }
  return trimmed;
}

export function safeExternalUrlMessage(): string {
  return "External links must use http or https URLs.";
}

export function isSafeInternalAppPath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) return false;
  // Avoid protocol-relative URLs (`//example.com`) and backslash variants
  // that browsers can treat as host-relative navigations.
  if (trimmed.startsWith("//") || trimmed.startsWith("/\\")) return false;
  if (/^\/%5c/i.test(trimmed)) return false;
  return true;
}

export function toRenderableHref(value: string): RenderableHref | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (isSafeInternalAppPath(trimmed)) return { href: trimmed, kind: "internal" };
  if (isSafeExternalUrl(trimmed)) return { href: trimmed, kind: "external" };
  return null;
}
