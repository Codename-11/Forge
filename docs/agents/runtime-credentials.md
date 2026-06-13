# Runtime credentials & repo provisioning

A runtime (the compute environment that hosts agents — the Codex bridge, a
Hermes host, a `forge daemon`) can now carry **encrypted secrets** and **repo
bindings**, and **self-provision** from them on startup. The point: a dispatched
agent should land in a ready, up-to-date checkout with the credentials it needs
to do real work — clone private repos, push branches, open PRs — without an
operator hand-placing files or keys into the runtime.

Manage both at **Settings → Runtimes → (a runtime)**.

## Secrets

Named, AES-256-GCM-encrypted values injected into the runtime's environment when
it provisions (`src/server/crypto.ts`, keyed off `AUTH_SECRET`). Typical use:

- `GH_TOKEN` — a GitHub token (fine-grained PAT recommended). The provisioner
  wires it into a git credential helper **and** `gh` (which reads `GH_TOKEN`
  from the env), so the agent can clone private repos, `git push`, and
  `gh pr create`.
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
   runtime* (linked-agent-required; strictly scoped).
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

## Not yet (follow-ons)

- **Per-project repo selection at dispatch.** Today repos are bound to the
  runtime; a future step is selecting the repo from the dispatched issue's
  project so one runtime can serve many codebases.
- **SSH-key git auth** beyond token-based `GH_TOKEN` (the secret store already
  holds arbitrary values; the credential-helper wiring is token-first).
