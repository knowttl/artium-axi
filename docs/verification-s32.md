# S32 authentication limits, lockout and recent-auth evidence

The [attempt boundary](../src/server/auth/attempts.ts) owns canonical-username and verified-address limits for login and reauthentication.
The [defaults](../src/server/config.ts) set 5 username attempts, 30 address attempts and a 15-minute window, with at most 4096 hashed keys in each counter map.
Fresh keys are refused at capacity without evicting active counters; expired entries are removed on the next attempt.
Known-user failed-password counts and lock deadlines are persisted, with the fifth failure and its audit event committed together.
An account unlock API is part of the later user-administration slice.

The [API](../src/server/app.ts) exposes bearer password confirmation through `POST /v1/auth/reauth`.
The [ticket verifier](../src/server/auth/tokens.ts) checks the current access token, session family and hashed ticket with an exact 15-minute expiry capped by the family deadline.
Tickets survive refresh within their own family, replace prior tickets and cannot bypass logout, reuse revocation, password change or user disable.
Browser forms, cookies, CSRF and browser-session idle expiry remain later work.

Run `pnpm exec vitest run src/server/auth/attempts.test.ts src/server/auth/tokens.test.ts test/integration/api.test.ts` for real local HTTP and SQLite checks with synthetic users, canary passwords and fake time.
The checks cover wrong-password/unknown-user parity, both limit keys, exact expiry, persisted lockout, successful reset, audit rollback, capped counter admission and session-bound tickets.
Run frozen install, lint, test, aggregate checks and the private hygiene scan against the final implementation commit.
Run the mandatory fake-only walking-skeleton and runner-container checks from [README](../README.md).
Pipeline fix rounds changing source or tests must rerun those checks before delivery.
Final head, command outcomes and pipeline step timings belong in the PR body and delivery status.
Real credentials, production proxy checks and live tenant acceptance remain on the captain checklist.
