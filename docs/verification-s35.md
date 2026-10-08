# S35 tool and credential administration evidence

The [shared API](../src/shared/api.ts) owns tool routes, strict inputs, native setting schemas, safe public responses, administrator authorization and audit actions.
The [tool admin implementation](../src/server/admin/tools.ts) reuses S33/S34 current-capability and password-ticket authorization.
The [README](../README.md) owns credential storage, cache invalidation and manual-test audit guidance.
Migrations [010](../src/server/store/migrations/010-tool-admin.sql) and [011](../src/server/store/migrations/011-credential-test-audit.sql) own the health-cache and durable audit fields.

Run `pnpm exec vitest run test/integration/admin-tools.test.ts src/server/store/authentication-schema.test.ts src/server/store/db.test.ts` for targeted local acceptance.
HTTP tests use real local login tokens and password reauthentication with synthetic administrators and ordinary users.
They cover every route's capability and recent-auth checks, fixed tools and pinned versions, safe credential reads/replacement, first-use revision zero, stale and concurrent edits, validated native profile settings and audit rollback.
Credential metadata never includes token values, client secrets, private keys or Falcon client IDs.
Cache tests prove immediate old-token eviction, pending-acquisition rejection and refusal of an old credential reference after replacement.
Manual tests run fixed harmless reads through real adapter preparation and a real runner with a synthetic child executable.
They prove per-tool exclusion, administrator runner quota, safe health success/failure, secret-output blocking, replacement during preparation, audit-before-child and atomic health/audit commit.
The [integration tests](../test/integration/admin-tools.test.ts) also verify legacy native-setting reconciliation and durable audit evidence after credential replacement clears cached health, for both successful and failed tests.
An Azure adapter is injected only in tests with fake token transport; production runtime Azure enable and test remain unavailable.
Tool listing makes no remote call and replacement clears cached health.
Automatic health scheduling and post-replacement background checks are implemented in [S42 verification](verification-s42.md).
See [S41 verification](verification-s41.md) for paginated audit query evidence.

Before validation, update README and the existing task row in the evidence ledger.
AGENTS.md already points to the correct command and validation owners and requires no factual correction for this slice.
Commit the implementation on the isolated feature branch.
Against that final implementation commit, run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test` and `pnpm check`.
Run `docker compose -f compose.example.yaml config --quiet`, `pnpm test:fake-services` and `pnpm test:runner-container` for the mandatory local container checks described in README.
Run `pnpm hygiene:check` with the external private deny-list path, recording only its digest, candidate commit and pass/fail result.
Repeat these checks after any pipeline source or test fix and quote the final results in the PR body.
Run no-mistakes with local validation and no hosted CI.
All verification uses fakes, synthetic identities and canary credentials.
No live platform, appliance, account change, deployment or captain acceptance is performed.
