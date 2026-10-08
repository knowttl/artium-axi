# S30 local login and restricted password change

The [shared API contract](../src/shared/api.ts) owns strict login requests and the two success shapes.
The [token module](../src/server/auth/tokens.ts) owns random issuance, hash lookup, token types, deadlines and user session revocation.
The [local provider](../src/server/auth/local.ts) checks password proofs and rechecks token validity inside the audited password-change transaction after hashing.
See [README.md](../README.md) for current sign-in usage and CLI session storage.
The existing [AGENTS.md](../AGENTS.md) pointers to package commands and README verification remain current.

Use only synthetic accounts, canary passwords, temporary stores and fake upstream services.
No live service acceptance is claimed.
See [S31 verification](verification-s31.md) for refresh rotation and logout checks.
See [S32 verification](verification-s32.md) for rate-limit, lockout and bearer reauthentication checks, and [README.md](../README.md) for current authentication usage and remaining work.
See [S33 verification](verification-s33.md) for user administration checks; the HTTP checks below also verify restricted-token rejection by the admin access verifier.

1. Run `pnpm exec vitest run test/integration/api.test.ts test/integration/audited-run.test.ts src/server/auth/tokens.test.ts src/server/auth/local.test.ts`.
   Verify real HTTP local sign-in, canonical usernames, distinct 32-byte random access and refresh values, hash-only persistence, one-hour access and fixed 12-hour family deadlines.
   Verify wrong-password and unknown-user failures have the same safe response, with no issued session.
   Verify strict JSON input, disabled users, expired and revoked proofs, and refresh tokens denied as access.
   Verify expiry and password-change revocation during controlled filesystem setup each prevent child creation and remove prepared files, using fake time and the real audited execution boundary.
   Verify must-change sign-in issues only a restricted 10-minute proof, denying listing, execution and ordinary administration authentication before credential retrieval.
   Verify password change succeeds once, concurrent consumes commit once, all CLI families/tokens and browser sessions are revoked, and fresh login is required.
   Verify audit failures roll back issuance and password replacement, leaving the restricted proof usable for a retry.
2. Run `pnpm test:walking-skeleton`.
   Its disposable internal fake network exercises bootstrap, restricted password change, fresh login and standalone CLI calls using real stored-token verification.
   Compare pinned upstream output and native canary write gates, without contacting live endpoints.
3. After the final implementation commit, run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test`, `pnpm check` and `pnpm test:runner-container`.
   Scan the final candidate tree, generated bundles and reachable commit messages with the real private deny list through `pnpm hygiene:check`.
   Record commands, counts, results, list digest and exact implementation SHA in the PR body.
4. Start no-mistakes with this local fake-only verification plan and `--skip ci` under `no_ci: true`.
   Any pipeline source or test fix reruns the mandatory install, lint, test, aggregate and real hygiene checks before delivery.
   Confirm the published PR is ready and mergeable, scan its exact head again, and report step timings to firstmate.
