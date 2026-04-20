/**
 * Chromeless passthrough layout for `/w/[slug]/focus/[id]`. The workspace
 * layout at `/w/[slug]/layout.tsx` still wraps this tree (so tRPC +
 * workspace context work), but the focus page itself renders fullscreen —
 * it replaces the normal shell with its own minimal header. Adding a
 * leaf layout here gives the focus page a clean `main` slot without the
 * sidebar chrome being re-applied further up.
 *
 * In practice the workspace layout already renders the sidebar inside its
 * shell; to truly escape that, the focus page uses `position: fixed` +
 * `inset-0` on mount to overlay the shell. This layout just exists to
 * document intent.
 */
export default function FocusLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
