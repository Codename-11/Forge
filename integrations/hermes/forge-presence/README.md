# forge-presence

Deterministic Hermes presence helper for Forge. It is script-only: no model,
Hermes session, prompt, or tool loop is invoked. A cron entry calls the
heartbeat endpoint every minute forever and emits nothing on success.

```bash
cp forge.env.example ~/.hermes/forge.env
$EDITOR ~/.hermes/forge.env
chmod 600 ~/.hermes/forge.env
bash bin/setup.sh victor
```

For an installed profile, `setup.sh <profile>` uses
`~/.hermes/profiles/<profile>/forge.env`. The API key must be an AGENT key with
`linkedAgentId` set. Run `bin/heartbeat.sh` directly to diagnose a failure;
successful calls remain silent. The heartbeat endpoint is self-scoped by that
linked agent identity and does not require broad `READ_USERS` access.
