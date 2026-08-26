# forge-provision

Scheduled wrapper for Forge's canonical provider-neutral provisioning script.
It deliberately does not duplicate credential or repository logic: each run
downloads `/api/integrations/provision-script` from the configured Forge
instance and executes that version.

```bash
cp forge.env.example ~/.hermes/forge.env
$EDITOR ~/.hermes/forge.env
chmod 600 ~/.hermes/forge.env
bash bin/setup.sh victor
```

The installed hourly cron refreshes short-lived GitHub App credentials and
fast-forwards clean runtime checkouts. Failures are written to stderr.
