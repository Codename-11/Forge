# Runtime credentials & repo provisioning

A runtime (the compute environment that hosts agents — the Codex bridge, a
Hermes host, a `forge daemon`) can carry **git auth** (a GitHub App or static
secrets), **secrets**, and **repo bindings**, and **self-provision** from them
on startup. The point: a dispatched agent should land in a ready, up-to-date
checkout with the credentials it needs to do real work — clone private repos,
push branches, open PRs — without an operator hand-placing files or keys.

Manage GitHub Apps at **Settings → GitHub Apps** (workspace-wide). Manage a
runtime's app link, secrets, and repos at **Settings → Runtimes → (a runtime)**.

## GitHub App (recommended for git)

Instead of minting a `GH_TOKEN` PAT and re-scoping it per repo, **install one
GitHub App** and share it across runtimes. You manage which repos it can touch
in GitHub's own UI; Forge mints a short-lived (~1h) **installation access token**
at provision time and injects it as `GH_TOKEN`. Adding a repo later is a checkbox
on GitHub — Forge needs no change, and there's no long-lived token to rotate.

Apps are **workspace-scoped** and shared: create one at **Settings → GitHub
Apps**, then point any number of runtimes at it (Settings → Runtimes → a runtime
→ GitHub App). Two ways to create one:

### Create with GitHub (manifest flow — no key to paste)

Click **Create with GitHub**. Forge sends an app *manifest* to GitHub; you
confirm, and GitHub creates the app and hands the credentials (App ID, slug, and
a freshly-generated private key) straight back to Forge — **you never copy-paste
a PEM**. Forge then walks you to the install page to pick repos; on completion
the installation ID is captured automatically. Implemented by the routes under
`src/app/api/integrations/github-app/*` with a tamper-proof, self-expiring state
token (`src/server/integrations/github-app-manifest.ts`).

### Add manually

If you already have an app, click **Add manually** and paste its App ID,
installation ID, and a generated private key (PEM).

Either way, hit **Test connection** — Forge signs as the app, mints a token, and
reports the account + repo count so you know it works.

The private key is AES-256-GCM-encrypted at rest (`src/server/crypto.ts`,
keyed off `AUTH_SECRET`) and **never returned** to a client or shipped to the
runtime — only Forge holds it, minting tokens server-side. App ID / installation
ID / slug are non-secret and shown in the UI. When an app is linked, the minted
`GH_TOKEN` **supersedes** any static `GH_TOKEN` secret on that runtime.

> This is distinct from the **instance** GitHub App (env-var creds) used for
> inbound *issue sync* — see `src/server/services/github/app-auth.ts`. The
> runtime-auth app is per-workspace, DB-backed, and only mints git tokens.

## Secrets

Named, AES-256-GCM-encrypted values injected into the runtime's environment when
it provisions. Typical use:

- `GH_TOKEN` — a GitHub token (fine-grained PAT). Wired into a git credential
  helper **and** `gh`. **Prefer the GitHub App above** — it supplies `GH_TOKEN`
  automatically with no per-repo scoping; a static `GH_TOKEN` here is the manual
  fallback.
- `GIT_SSH_KEY` — an SSH private key for git over SSH (see below).
- Any other env the agent needs (deploy creds, registry tokens, …).

Values are **write-only**: the API and UI never return them after saving. The
runtime reads its own decrypted values through the `runtimes.provisioning` MCP
tool. Secrets are **per-runtime** and admin-gated.

## SSH-key git auth

For deploy keys or non-GitHub hosts, add a `GIT_SSH_KEY` secret (an OpenSSH/PEM
private key). On provision the runtime writes it to `~/.ssh` (mode 600) and wires
it into git via `core.sshCommand`, so `git@github.com:org/repo.git`-style remotes
work. An optional `GIT_SSH_KNOWN_HOSTS` secret pins host keys (otherwise the
runtime accepts-new on first use). Token (`GH_TOKEN`/App) and SSH can coexist —
each repo uses whichever its remote URL implies.

## Repositories

A repo binding is `{ url, branch?, path }`. On provision the runtime
clone-or-pulls each into `<workspaceRoot>/<path>`:

- **absent →** `git clone [--branch <branch>] <url> <path>`
- **present →** `git remote set-url origin <url>` + `fetch` + (optional)
  `checkout <branch>` + `pull --ff-only` (a dirty/diverged tree is left as-is)

Two sources, materialized together (runtime bindings win on a path collision):

- **Runtime-wide repos** — bound at Settings → Runtimes → a runtime. For repos
  every dispatch on that runtime needs.
- **Per-project repos** — bound on a Project (Project → Edit → Repository). One
  runtime can serve **many codebases**: each project's repo is cloned at a path
  derived from its name, and a dispatched agent is told which checkout to work in
  (the dispatch message names the project's repo + path). See
  `src/server/services/repo-path.ts` for the path derivation.

`path` is a validated relative path (no leading `/`, no `..`). Auth comes from
the GitHub App / secrets above.

## How provisioning works

1. The runtime authenticates to Forge with its **agent-linked** API key (a
   bootstrap credential) and calls the MCP tool **`runtimes.provisioning`**,
   which returns the decrypted secrets + repo bindings (runtime + project) for
   *that agent's runtime* (linked-agent-required; strictly scoped). If a GitHub
   App is linked **and installed**, Forge mints a fresh installation token
   server-side and includes it as `GH_TOKEN` (with `githubAppTokenExpiresAt`) —
   the PEM never leaves Forge.
2. It writes the secrets to an env file, exports them, configures git/gh auth
   (token credential helper and/or `GIT_SSH_KEY`), and clone-or-pulls the bound
   repos.
3. It hands control to the agent — which now starts in a ready checkout with
   working credentials.

For the containerised Codex bridge this is `provision.cjs`, run by the entrypoint
before the bridge starts (`~/docker/codex-bridge/`). The single bootstrap secret
(`FORGE_API_KEY`, the runtime's agent key) stays in the container env; everything
else is managed in-app and fetched at startup.

The same bootstrap key can call `runtimes.reportInfo` after provisioning to
publish sanitized runtime metadata (bridge version, Codex version, container
image, host, OS/arch, workspace root). Forge shows this on the runtime list and
detail page so operators can tell what is actually running without shelling into
the host.

## Running it on any runtime (Hermes, ephemeral agents)

The provisioning logic is **provider-agnostic** — `runtimes.provisioning` gates
on an agent-linked key, not the agent's provider, so the same flow works for
Hermes, Claude, Codex, or any custom runtime. Forge serves one **canonical
script** so each host runs identical logic (single source of truth):

```
GET /api/integrations/provision-script    # instance origin baked in as the default base
```

It's plain Node (≥18), dependency-free, and idempotent. Run it with the host's
agent-linked `FORGE_API_KEY`:

```sh
curl -fsSL https://<forge>/api/integrations/provision-script -o forge-provision.cjs
FORGE_API_KEY=forge_sk_… node forge-provision.cjs
```

It clones into the current directory (override with `FORGE_WORKSPACE_ROOT`) and
writes secrets to `<root>/.forge-runtime.env`. Re-run any time to refresh the
~1h GitHub App token and pull latest. Source `src/server/integrations/provision-script.ts`.

Where to run it:

- **Ephemeral agents (Claude Code, Codex CLI):** copy the one-liner from
  **Settings → Runtimes → (a runtime) → Provisioning** (download button + ready
  bootstrap), or wire it as a session-start step.
- **Persistent Hermes host:** install the `forge-provision` Hermes skill
  (`~/.hermes/skills/forge-provision/`) — `bin/setup.sh <profile>` installs an
  hourly cron that fetches + runs the script, keeping the token + checkouts
  fresh. Companion to the `forge-presence` heartbeat skill; shares the same
  `forge.env` (`FORGE_URL` + `FORGE_API_KEY`).
- **Codex bridge:** already runs `provision.cjs` (the same logic) at startup.

## Security notes

- Secret values + the GitHub App private key are encrypted at rest and never
  leave the server except (for non-App secrets) to the owning runtime via
  `runtimes.provisioning`. The App PEM never leaves Forge at all.
- The minted installation token is short-lived (~1h) and never persisted.
- A mint failure is recorded (`lastError`, shown in the UI) and does **not**
  break the rest of provisioning — other secrets and repos still flow.
- Rotating `AUTH_SECRET` invalidates stored secrets/keys — re-enter them.
- An agent already operates with these credentials, so it can read its own
  runtime's secrets by design; the guarantee is that *other* runtimes/keys
  cannot, and that workspace GitHub Apps are isolated per workspace.

## Not yet (follow-ons)

- **App-level webhooks** for the runtime-auth app (today inactive; the instance
  issue-sync app handles inbound events).
- **Multiple installations per app** (one app installed on several orgs).
