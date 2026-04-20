// Stub for @/server/auth during vitest runs. The real auth module imports
// next-auth, which transitively pulls `next/server` — that fails to resolve
// under vitest ESM without a Next.js build pipeline. Router tests only
// need `auth` to exist as an importable shape; they build their own
// session context via helpers and never execute this function.
export async function auth() {
  return null;
}
