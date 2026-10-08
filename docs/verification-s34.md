# S34 role administration evidence

The [shared API](../src/shared/api.ts) owns methods, paths, strict inputs, public responses, authorization and audit actions for roles, tool grants and user-role assignments.
The [admin implementation](../src/server/admin/api.ts) reuses S33 authorization, transactional revisions and audit error handling.
Migration 009 adds role change time and actor metadata while preserving existing assignments and grants.
AGENTS.md's toolchain and README pointers remain accurate and require no correction.

Run `pnpm exec vitest run test/integration/admin-users.test.ts test/integration/api.test.ts src/server/store/authentication-schema.test.ts` for local acceptance.
The HTTP checks use real local login tokens and password reauthentication with synthetic accounts.
They cover every endpoint, administrator and recent-auth denial, bounded pagination, role creation, rename, tool replacement and assignment replacement.
Role edits share the role revision, and assignments share the account revision with other account edits.
Concurrent edits accept one revision and return 409 for the stale change.
Missing targets return 404, duplicate names and missing foreign keys return 400, and invalid grant identifiers cannot confer administrator capability.
Failed audit insertion rolls back each mutation, grants, assignments, revisions and change metadata.
The Role change flow removes assignments or tool grants through the API, denies the next tool call with the existing token before credential retrieval, and records both the change and denial.
Restoring the assignment or grant allows the following call with that same token.

Before delivery, run frozen install, lint, test, aggregate checks, Compose validation, fake-service and runner container checks and the real private hygiene scan against the final implementation commit.
The PR body records command results, published head, hygiene-list digest and pipeline timings.
Any pipeline source or test fix requires renewed final-head validation.
All service checks use fakes and canary credentials.
Real account changes, browser acceptance and live deployment remain deferred.
