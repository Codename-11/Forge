# Runtime credentials & repo provisioning

A runtime (the compute environment that hosts agents — the Codex bridge, a
Hermes host, a `forge daemon`) can now carry **encrypted secrets** and **repo
bindings**, and **self-provision** from them on startup. The point: a dispatched
agent should land in a ready, up-to-date checkout with the credentials it needs
to do real work — clone private repos, push branches, open PRs — without an
operator hand-placing files or keys into the runtime.

Manage all of it at **Settings → Runtimes → (a runtime)**.

## GitHub App (recommended for git)

Instead of minting a `GH_TOKEN` PAT and re-scoping it every time the agent needs
a new repo, **link one GitHub App** to the runtime. You install the app once on
your account/org and choose which repos it can touch in GitHub's own UI; Forge
mints a short-lived (~1h) **installation access token** from the app at provision
time and injects it as `GH_TOKEN`. Adding a repo later is a checkbox on GitHub —
Forge needs no change, and there's no long-lived token to rotate.

Why it's better than a PAT:

- **No per-repo key.** GitHub's install settings are the scoping surface.
- **Short-lived tokens.** Forge re-mints on each provision; nothing long-lived
  is stored or shipped.
- **Bot identity + higher rate limits.** Commits/PRs are attributed to the app,
  not a person's account.

One-time setup (the UI walks you through it):

1. **Create a GitHub App** (`https://github.com/settings/apps/new`) with repo
   permissions **Contents: Read & write**, **Pull requests: Read & write**,
   **Metadata: Read**. Generate and download a private key (PEM).
2. **Install** it on your account/org and pick the repos. The install URL ends
   in `/installations/<id>` — that number is the **Installation ID**.
3. In Forge, paste the **App ID**, **Installation ID**, and **private key**,
   then hit **Test connection** — it signs as the app, mints a token, and reports
   the account + repo count so you know it works.

The private key (PEM) is AES-256-GCM-encrypted at rest and **never returned** to
any client; the minted token never touches the DB. App ID / Installation ID /
slug are non-secret and shown in the UI. When an app is configured, the minted
`GH_TOKEN` **supersedes** any static `GH_TOKEN` secret — so you don't need both.

> The minted token lasts ~1h. Ephemeral dispatches always start with a fresh
> one; a long-running session re-mints when it re-provisions. Token expiry is
> reported to the runtime (`githubAppTokenExpiresAt`) and logged by the bridge.

## Secrets

Named, AES-256-GCM-encrypted values injected into the runtime's environment when
it provisions (`src/server/crypto.ts`, keyed off `AUTH_SECRET`). Typical use:

- `GH_TOKEN` — a GitHub token (fine-grained PAT). The provisioner wires it into
  a git credential helper **and** `gh` (which reads `GH_TOKEN` from the env), so
  the agent can clone private repos, `git push`, and `gh pr create`. **Prefer
  the GitHub App above** — it supplies `GH_TOKEN` automatically with no per-repo
  scoping; a static `GH_TOKEN` here is the manual fallback.
- Any other env the agent needs (deploy creds, registry tokens, …).

Values are **write-only**: the API and UI never return them after saving — the
list shows only the key + description. The runtime reads its own decrypted
values through the `runtimes.provisioning` MCP tool.

Secrets are **per-runtime** and admin-gated. A key for agent A resolves only to
A's runtime — it can never read another runtime's secrets.

## Repositories

A repo binding is `{ url, branch?, path }`. On provision the runtime
clone-or-pulls each into `<workspaceRoot>/<path>`:

- **absent →** `git clone [--branch <branch>] <url> <path>`
- **present →** `git remote set-url origin <url>` + `fetch` + (optional)
  `checkout <branch>` + `pull --ff-only` (a dirty/diverged tree is left as-is)

Auth comes from the secrets above (the `GH_TOKEN` credential helper). `path` is
a validated relative path (no leading `/`, no `..`).

## How provisioning works

1. The runtime authenticates to Forge with its **agent-linked** API key (a
   bootstrap credential) and calls the MCP tool **`runtimes.provisioning`**,
   which returns the decrypted secrets + repo bindings for *that agent's
   runtime* (linked-agent-required; strictly scoped). If a GitHub App is bound,
   Forge mints a fresh installation token server-side and includes it as
   `GH_TOKEN` (with `githubAppTokenExpiresAt`) — the PEM never leaves Forge.
2. It writes the secrets to an env file, exports them, configures git/gh auth
   from `GH_TOKEN`, and clone-or-pulls the bound repos.
3. It hands control to the agent — which now starts in a ready checkout with
   working credentials.

For the containerised Codex bridge this is `provision.cjs`, run by the
entrypoint before the bridge starts (`~/docker/codex-bridge/`). The single
bootstrap secret (`FORGE_API_KEY`, the runtime's agent key) stays in the
container env; everything else (gh token, repos, deploy creds) is managed
in-app and fetched at startup.

## Security notes

- Secret values are encrypted at rest and never leave the server except to the
  owning runtime via `runtimes.provisioning`.
- Rotating `AUTH_SECRET` invalidates stored secrets — re-enter them.
- The agent already operates with these credentials, so it can read its own
  secrets by design; the guarantee is that *other* runtimes/keys cannot.

## Security notes (GitHub App)

- The PEM private key is encrypted at rest and **never** returned to a client or
  shipped to the runtime — only Forge holds it, and it mints tokens server-side.
- The minted installation token is short-lived (~1h) and never persisted.
- A mint failure is recorded (`lastError`, shown in the UI) and does **not**
  break the rest of provisioning — other secrets and repos still flow.

## Not yet (follow-ons)

- **Per-project repo selection at dispatch.** Today repos are bound to the
  runtime; a future step is selecting the repo from the dispatched issue's
  project so one runtime can serve many codebases. (A GitHub App already grants
  access to *all* its installed repos, so this is mostly a UI/wiring step.)
- **Workspace-level GitHub App.** Today an app is per-runtime; sharing one app
  across runtimes would remove even that repetition.
- **Manifest-flow app creation.** A guided "Create app" callback (GitHub
  generates and returns the private key) would remove the manual PEM paste.
- **SSH-key git auth** beyond token-based `GH_TOKEN` (the secret store already
  holds arbitrary values; the credential-helper wiring is token-first).
