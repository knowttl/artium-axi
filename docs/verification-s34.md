# S34 role administration evidence

The [shared API](../src/shared/api.ts) owns methods, paths, strict inputs, public responses, authorization and audit actions for roles, tool grants and user-role assignments.
The [admin implementation](../src/server/admin/api.ts) reuses S33 authorization, transactional revisions and audit error handling.
Migration 009 adds role change time and actor metadata while preserving existing assignments and grants.

Run `pnpm exec vitest run test/integration/admin-users.test.ts test/integration/api.test.ts src/server/store/authentication-schema.test.ts` for local acceptance.
The HTTP checks use real local login tokens and password reauthentication with synthetic accounts.
They cover every endpoint, administrator and recent-auth denial, bounded pagination, role creation, rename, tool replacement and assignment replacement.
Role edits share the role revision, and assignments share the account revision with other account edits.
Concurrent edits accept one revision and return 409 for the stale change.
Missing targets return 404, duplicate names and missing foreign keys return 400, and invalid grant identifiers cannot confer administrator capability.
Failed audit insertion rolls back each mutation, grants, assignments, revisions and change metadata.
The Role change flow removes assignments or tool grants through the API, denies the next tool call with the existing token before credential retrieval, and records both the change and denial.
Restoring the assignment or grant allows the following call with that same token.

See [README.md](../README.md) for local validation commands, mandatory fake-only container checks and private hygiene requirements.
The PR body records command results, published head, hygiene-list digest and pipeline timings.
Any pipeline source or test fix requires renewed final-head validation.
All service checks use fakes and canary credentials.
Real account changes, browser acceptance and live deployment remain deferred.

Local validation passed on implementation commit `bcafe8ee5159e423b72fe9bd05ac5b1dac776ae4`.
`pnpm install --frozen-lockfile` and `pnpm lint` passed.
`pnpm test` passed 40 files and 800 tests, and `pnpm check` passed lint, the same 800 tests and build.
`docker compose -f compose.example.yaml config --quiet`, `pnpm test:fake-services` and `pnpm test:runner-container` passed.
The fake-service probe preserved the existing Azure activation deferral for the pinned tool's ambiguous retry behaviour.
The runner container verified cgroup limits, byte/inode exhaustion, cleanup, successful following calls and synthetic OOM reaping.
The private hygiene scan passed with zero matches and list SHA-256 `bddd1b07500f81245fc34634459368648db992b7127d66ff94330849eda45ad2`.
