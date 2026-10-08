# S32 authentication limits, lockout and recent-auth evidence

See [README.md](../README.md) for current authentication usage, limits, lockout and ticket behavior.
The [attempt boundary](../src/server/auth/attempts.ts) owns attempt admission and audited lockout; [server configuration](../src/server/config.ts) owns executable defaults.
The [counter tests](../src/server/auth/attempts.test.ts) verify canonical keys, exact expiry and capacity refusal without evicting active counters.

The [HTTP checks](../test/integration/api.test.ts) exercise password confirmation, persisted lockout and audit rollback through the real API.
The [ticket checks](../src/server/auth/tokens.test.ts) exercise replacement, refresh, family deadlines and revocation through the token module.

Run `pnpm exec vitest run src/server/auth/attempts.test.ts src/server/auth/tokens.test.ts test/integration/api.test.ts` for real local HTTP and SQLite checks with synthetic users, canary passwords and fake time.
The checks cover wrong-password/unknown-user parity, both limit keys, exact expiry, persisted lockout, successful reset, audit rollback, capped counter admission and session-bound tickets.
Run frozen install, lint, test, aggregate checks and the private hygiene scan against the final implementation commit.
Run the mandatory fake-only walking-skeleton and runner-container checks from [README](../README.md).
Pipeline fix rounds changing source or tests must rerun those checks before delivery.
Final head, command outcomes and pipeline step timings belong in the PR body and delivery status.
Real credentials, production proxy checks and live tenant acceptance remain on the captain checklist.
