# S33 user administration evidence

The [shared API](../src/shared/api.ts) defines each user route's method, path, input, public response, authorization and audit action.
The [HTTP implementation](../src/server/admin/users.ts) uses current administrator capability and session-bound bearer reauthentication, the existing atomic audit boundary and SQLite last-administrator triggers.
See [README.md](../README.md) for current user administration usage and remaining work, and [the recovery runbook](runbook.md#first-administrator-and-offline-recovery) for offline recovery.

Run `pnpm exec vitest run test/integration/admin-users.test.ts` for the [HTTP integration checks](../test/integration/admin-users.test.ts).
Authorization checks use real local sign-in and password reauthentication, with synthetic identities and canary passwords.
Checks cover all five routes, current capability denial despite tool grants, missing/expired/other-session tickets, capped stable pagination, canonical usernames, temporary passwords and role assignment.
They verify enable/disable, capability changes, unlock, reset, unknown accounts, invalid passwords, invalid foreign keys and duplicate usernames.
Unlock and reset checks exhaust the username counter with five real wrong-password logins, then verify immediate sign-in after the administrator action.
Audit failure checks verify that the exhausted username counter remains in force.
The [counter tests](../src/server/auth/attempts.test.ts) verify that clearing a canonical username preserves other username counters and the per-address limit.
Stale and concurrent edits preserve the committed revision.
Disable and reset revoke prior CLI and browser sessions.
Audit insertion failure rolls back each mutation, assignments, password hashes, revisions, metadata and session revocations.
Concurrent self-disables through separate servers and database connections leave exactly one enabled administrator and one successful audit event.
The last administrator cannot be demoted either.

Before delivery, run frozen install, lint, test, aggregate checks and the real private hygiene scan against the final implementation commit.
Run the mandatory fake-only container checks documented in [README](../README.md).
The PR body records the exact head, command results, hygiene-list digest and no-mistakes step timings.
Source or test changes during the pipeline require renewed validation.
Browser authentication, real account changes and live deployment remain deferred captain acceptance.
