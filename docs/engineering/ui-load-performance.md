# UI load performance

Forge keeps local UI performance evidence reproducible with the Playwright-based
`scripts/benchmark-ui-load.mjs` harness. Run it only against a synthetic issue
in the isolated local stack:

```bash
pnpm dev:local
node scripts/benchmark-ui-load.mjs \
  --issue-id <local-synthetic-issue-id> \
  --label local \
  --output output/playwright/ui-load-local.json
```

The harness signs in with the local bootstrap account, visits the same issue
twice, and records primary-content readiness, navigation and paint timings,
script resources and transfer bytes, API request counts, tRPC procedure names,
and console activity. The first navigation includes development route
compilation; use the second navigation to compare already-compiled behavior.
Development timings vary with filesystem cache, Fast Refresh, database jobs,
and host load, so request, procedure, and resource deltas are the more stable
regression signals.

## AXI-125 evidence

Captured on 2026-07-17 against the same synthetic local issue and local
Postgres, Redis, and MinIO services. Raw evidence is retained under the ignored
`output/playwright/axi-125-*.json` paths in the originating worktree.

| Already-compiled reload signal | Before | After | Change |
| ------------------------------ | -----: | ----: | -----: |
| tRPC procedures                |     42 |    29 |   -31% |
| API/tRPC batches               |      4 |     4 |      0 |
| Script resources               |     38 |    37 |     -1 |
| Script transfer bytes          | 1,358,771 | 1,269,739 | -6.6% |
| Verbose successful tRPC logs   |     82 |     0 |  opt-in |
| Primary content ready          | 2,395 ms | 2,590 ms | +8.1% |
| DOM content loaded             |   812 ms | 1,007 ms | +24.0% |

The wall-clock reload timings were noisy and did not improve in that sample;
they are recorded rather than hidden. The deterministic work performed during
the initial issue load did improve: closed global surfaces stayed out of the
critical bundle, picker-only datasets were not requested until opened, and 13
initial procedures were removed. A clean development output directory compiled
the issue route in 6.4 seconds and served its first request in 15.9 seconds,
versus the original run's 2.7-second route compile and 5.3-second request. That
cold comparison is dominated by a different filesystem/build-cache state and
is retained as compile behavior, not claimed as a product speedup.

Successful tRPC operation logging is disabled by default. Set
`NEXT_PUBLIC_TRPC_VERBOSE=1` before starting Next when verbose client success
logs are needed; failed operations continue to log regardless.

Realtime correctness is event-first. Issue, comment, cycle, notification, and
workspace events invalidate exact cache targets where identifiers are
available. The open issue remains subscribed through workspace SSE. Only while
the SSE connection is reconnecting does that exact issue use a
visibility-aware 30-second fallback refresh; it never polls in the background.

The focused browser contract is:

```bash
E2E_FORCE_FRESH_SERVER=1 E2E_RESET_DB=1 E2E_FORCE_BUILD=1 \
  pnpm exec playwright test tests/e2e/ui-load-realtime.spec.ts --workers=1
```

It verifies on-demand Command Palette and Quick Create mounting, absence of
closed picker requests, picker fetch on open, and a cross-tab issue status
change reaching the original page through SSE.
