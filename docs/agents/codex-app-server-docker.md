# Codex App-Server Docker Bridge

Forge reaches Codex app-server over WebSocket, but `codex app-server` itself
speaks stdio JSON-RPC. The supported production pattern is a small
stdio-to-WebSocket bridge running in Docker.

Docker is the hard boundary:

- mount only `~/.codex/auth.json` read-only from the host;
- copy/refresh auth into a container-local `CODEX_HOME` volume;
- mount one scoped workspace at `/work`;
- publish the bridge on a private `ws://HOST:4505` endpoint, or `wss://` for a
  public host.

Forge runtime config still controls per-turn sandbox mode, approval policy, and
workspace root. The Docker boundary limits what full-access turns can see on the
host.

## Compose Contract

The live deployment keeps the reference bridge in `~/docker/codex-bridge/`.
A portable compose file follows the same contract:

```yaml
services:
  codex-bridge:
    build: .
    restart: unless-stopped
    ports:
      - "4505:4505"
    environment:
      BRIDGE_HOST: 0.0.0.0
      BRIDGE_PORT: "4505"
      CODEX_HOME: /codex-home
      CODEX_WORKSPACE: /work
      FORGE_WORKSPACE_DIR: /work/forge
      FORGE_MCP_BASE_URL: https://forge.example.com
    env_file:
      - ./forge.env
    volumes:
      - ${CODEX_AUTH_FILE:-/home/you/.codex/auth.json}:/auth/auth.json:ro
      - ./workspace:/work
      - codex-home:/codex-home

volumes:
  codex-home:
```

`forge.env` should contain the Codex agent's Forge API key:

```sh
FORGE_API_KEY=forge_sk_...
```

That key must be linked to the Forge Agent attached to the Codex runtime. It is
used for provisioning, Forge MCP calls from inside Codex, and runtime metadata
reporting.

## Start And Verify

```sh
cd ~/docker/codex-bridge
docker compose up -d --build
docker compose logs -f
```

Create or edit the Forge runtime:

- adapter: `Codex (app server)`;
- endpoint: `ws://<private-host>:4505` or `wss://<public-host>`;
- workspace root: `/work/forge` or the repo path inside the mounted workspace.

Then run **Test connection** and **Run self-test** from Settings -> Runtimes.

## Version Reporting

Runtime hosts should report their environment on boot with MCP
`runtimes.reportInfo`. Forge stores a sanitized whitelist and shows it in
Settings -> Runtimes.

Example:

```sh
curl -fsS "$FORGE_MCP_BASE_URL/api/mcp/runtimes.reportInfo" \
  -H "Authorization: Bearer $FORGE_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "info": {
      "adapterKey": "codex-app-server",
      "bridgeName": "codex-bridge",
      "bridgeVersion": "1.0.0",
      "codexVersion": "0.133.0",
      "containerImage": "codex-bridge:local",
      "hostname": "codex-bridge",
      "os": "linux",
      "arch": "x64",
      "nodeVersion": "v22.0.0",
      "workspaceRoot": "/work/forge",
      "authMode": "codex auth.json mounted read-only"
    }
  }'
```

Forge also harvests `serverInfo` / `runtimeInfo` from the Codex WebSocket
`initialize` response when a bridge exposes those fields.

## Auth Notes

Forge's runtime secret, when configured, only authenticates Forge to the bridge
socket. It does not log Codex into OpenAI. Codex auth comes from the bridge
container's `CODEX_HOME/auth.json`, usually seeded from the host's
`~/.codex/auth.json` mount.

If Codex auth breaks, refresh login on the host, restart the bridge, or remove
the `codex-home` volume so the container re-seeds from the host auth file.
