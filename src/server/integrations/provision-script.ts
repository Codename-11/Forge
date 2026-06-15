/**
 * The canonical, portable **runtime provisioning script**, served at
 * `GET /api/integrations/provision-script`. Any runtime host — the Codex
 * bridge, a Hermes profile, an ephemeral Claude Code / Codex CLI session —
 * fetches and runs this one script to self-provision: it calls
 * `runtimes.provisioning` with the host's agent-linked `FORGE_API_KEY`, writes
 * the secrets to an env file, sets up git auth (GH_TOKEN credential helper
 * and/or a GIT_SSH_KEY), and clone-or-pulls the runtime + per-project repos.
 *
 * It is plain Node (>=18, for global `fetch`), dependency-free, idempotent, and
 * best-effort. Configured entirely by env:
 *   FORGE_API_KEY        (required) agent-linked Forge API key
 *   FORGE_BASE_URL       (default: baked at download) Forge instance URL
 *   FORGE_WORKSPACE_ROOT (default: cwd) where repos are cloned
 *   FORGE_ENV_FILE       (default: <root>/.forge-runtime.env) where secrets land
 *
 * Authoring note: the body below uses **string concatenation only** (no
 * backticks, no `${}`) so it can be embedded verbatim in a TS template literal
 * with a single `__FORGE_BASE_DEFAULT__` placeholder — the route bakes the
 * instance origin in as the FORGE_BASE_URL default so a download is
 * pre-pointed and the operator only needs to supply FORGE_API_KEY.
 */

export const PROVISION_SCRIPT_VERSION = "1.0.0";

const SCRIPT_BODY = `#!/usr/bin/env node
"use strict";
// Forge runtime provisioning (portable) — v${PROVISION_SCRIPT_VERSION}.
// Fetches THIS runtime's secrets + repo bindings from Forge and sets up the
// environment so an agent lands in a ready, authenticated checkout. Safe to
// re-run (idempotent). See Forge docs: "Runtime credentials & repo provisioning".
//
// Required: FORGE_API_KEY (an agent-linked Forge API key, attached to a runtime)
// Optional: FORGE_BASE_URL, FORGE_WORKSPACE_ROOT, FORGE_ENV_FILE
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const BASE = (process.env.FORGE_BASE_URL || __FORGE_BASE_DEFAULT__).replace(/\\/+$/, "");
const KEY = process.env.FORGE_API_KEY;
const ROOT = process.env.FORGE_WORKSPACE_ROOT || process.cwd();
const ENV_FILE = process.env.FORGE_ENV_FILE || path.join(ROOT, ".forge-runtime.env");
const HOME = process.env.HOME || os.homedir();

const ts = () => new Date().toISOString();
const log = (m) => process.stderr.write("[forge-provision " + ts() + "] " + m + "\\n");

function sh(cmd, args, opts) {
  return execFileSync(cmd, args, Object.assign({ stdio: ["ignore", "pipe", "pipe"] }, opts || {}))
    .toString()
    .trim();
}
function shOk(cmd, args, opts) {
  try { sh(cmd, args, opts); return true; } catch { return false; }
}
function shellQuote(v) {
  return "'" + String(v).replace(/'/g, "'\\\\''") + "'";
}
function redactUrl(u) {
  return String(u).replace(/\\/\\/[^@]+@/, "//***@");
}

async function main() {
  if (!KEY) {
    log("FORGE_API_KEY is required (an agent-linked key attached to a runtime). Set it and re-run.");
    process.exit(1);
  }

  let data;
  try {
    const res = await fetch(BASE + "/api/mcp/runtimes.provisioning", {
      method: "POST",
      headers: { authorization: "Bearer " + KEY, "content-type": "application/json" },
      body: "{}",
    });
    if (!res.ok) {
      log("provisioning fetch HTTP " + res.status + " — is FORGE_API_KEY an agent-linked key whose agent has a runtime?");
      process.exit(1);
    }
    const json = await res.json();
    data = json.data || json;
  } catch (e) {
    log("provisioning fetch failed: " + e.message);
    process.exit(1);
  }

  const secrets = Array.isArray(data.secrets) ? data.secrets : [];
  const repos = Array.isArray(data.repos) ? data.repos : [];
  if (data.githubAppTokenExpiresAt) {
    log("GH_TOKEN minted from GitHub App (expires " + data.githubAppTokenExpiresAt + ").");
  }

  fs.mkdirSync(ROOT, { recursive: true });

  // 1) Secrets -> env file (mode 600) + this process env.
  const lines = secrets
    .filter((s) => s && typeof s.key === "string")
    .map((s) => "export " + s.key + "=" + shellQuote(s.value == null ? "" : s.value));
  fs.writeFileSync(ENV_FILE, lines.length ? lines.join("\\n") + "\\n" : "", { mode: 0o600 });
  for (const s of secrets) if (s && s.key) process.env[s.key] = s.value == null ? "" : s.value;
  log("wrote " + lines.length + " secret(s) to " + ENV_FILE);

  // 2a) Token git auth (gh reads GH_TOKEN; git needs a credential helper).
  const ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (ghToken) {
    try {
      shOk("git", ["config", "--global", "credential.helper", "store"]);
      const credPath = path.join(HOME, ".git-credentials");
      fs.writeFileSync(credPath, "https://x-access-token:" + ghToken + "@github.com\\n", { mode: 0o600 });
      if (!shOk("git", ["config", "--global", "--get", "user.email"])) {
        shOk("git", ["config", "--global", "user.email", "agent@forge.local"]);
      }
      if (!shOk("git", ["config", "--global", "--get", "user.name"])) {
        shOk("git", ["config", "--global", "user.name", "Forge Agent"]);
      }
      log("configured git credential helper + author from GH_TOKEN");
    } catch (e) {
      log("git/gh auth setup failed: " + e.message);
    }
  }

  // 2b) SSH git auth from a GIT_SSH_KEY secret (deploy keys / non-GitHub hosts).
  const sshKey = process.env.GIT_SSH_KEY;
  if (sshKey) {
    try {
      const sshDir = path.join(HOME, ".ssh");
      fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
      const keyPath = path.join(sshDir, "forge_provisioned");
      fs.writeFileSync(keyPath, sshKey.endsWith("\\n") ? sshKey : sshKey + "\\n", { mode: 0o600 });
      const known = process.env.GIT_SSH_KNOWN_HOSTS;
      let sshCmd = "ssh -i " + keyPath + " -o IdentitiesOnly=yes";
      if (known) {
        const kh = path.join(sshDir, "known_hosts");
        fs.writeFileSync(kh, known.endsWith("\\n") ? known : known + "\\n", { mode: 0o644 });
        sshCmd += " -o UserKnownHostsFile=" + kh + " -o StrictHostKeyChecking=yes";
      } else {
        sshCmd += " -o StrictHostKeyChecking=accept-new";
      }
      shOk("git", ["config", "--global", "core.sshCommand", sshCmd]);
      if (!shOk("git", ["config", "--global", "--get", "user.email"])) {
        shOk("git", ["config", "--global", "user.email", "agent@forge.local"]);
      }
      if (!shOk("git", ["config", "--global", "--get", "user.name"])) {
        shOk("git", ["config", "--global", "user.name", "Forge Agent"]);
      }
      log("configured git ssh auth from GIT_SSH_KEY" + (known ? " (pinned host keys)" : ""));
    } catch (e) {
      log("git ssh auth setup failed: " + e.message);
    }
  }

  // 3) Clone-or-pull each bound repo (runtime-wide + per-project) into ROOT.
  for (const r of repos) {
    if (!r || !r.url || !r.path) continue;
    const dest = path.join(ROOT, r.path);
    try {
      if (fs.existsSync(path.join(dest, ".git"))) {
        shOk("git", ["-C", dest, "remote", "set-url", "origin", r.url]);
        shOk("git", ["-C", dest, "fetch", "--quiet", "origin"]);
        if (r.branch) shOk("git", ["-C", dest, "checkout", "--quiet", r.branch]);
        const pulled = shOk("git", ["-C", dest, "pull", "--ff-only", "--quiet"]);
        log("repo " + r.path + ": " + (pulled ? "pulled latest" : "fetched (pull skipped — dirty/diverged)"));
      } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const args = ["clone", "--quiet"];
        if (r.branch) { args.push("--branch", r.branch); }
        args.push(r.url, dest);
        sh("git", args);
        log("repo " + r.path + ": cloned from " + redactUrl(r.url));
      }
    } catch (e) {
      log("repo " + r.path + ": failed (" + String(e.message).slice(0, 160) + ")");
    }
  }

  log("provisioning complete (" + secrets.length + " secret(s), " + repos.length + " repo(s)). Source env: . " + ENV_FILE);
}

main().catch((e) => { log("provision error: " + e.message); process.exit(1); });
`;

/** Compose the script with the instance origin baked in as the default base. */
export function buildProvisionScript(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return SCRIPT_BODY.replace(/__FORGE_BASE_DEFAULT__/g, JSON.stringify(base));
}
