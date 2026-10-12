# S31 atomic refresh families and logout

The [shared API contract](../src/shared/api.ts) owns strict refresh input and the authenticated pair response.
The [token module](../src/server/auth/tokens.ts) owns transactional consumption, fixed family deadlines and family revocation.
The existing [AGENTS.md](../AGENTS.md) package and README pointers remain accurate and need no correction.
See [S32 verification](verification-s32.md) for bearer reauthentication checks, and [README.md](../README.md) for current authentication usage and remaining work.
All verification uses synthetic identities, canary passwords, temporary stores and fake upstream tools.

1. Run `pnpm exec vitest run test/integration/api.test.ts src/server/auth/tokens.test.ts`.
   Concurrent real HTTP refresh requests consume one proof exactly once, and the reuse revokes both old and replacement tokens with a durable audit event.
   Fake time verifies old access expiry, the fixed 12-hour family deadline and the capped final access expiry.
   Real sign-in covers current role removal, restart persistence, denied credential retrieval and production rejection of development authentication.
   Logout accepts expired access and refresh proofs, revokes only their family and writes a sign-out event.
   Reuse audit failure rolls back revocation and permits an audited retry.
2. After the final implementation commit, run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test`, `pnpm check`, `pnpm test:walking-skeleton` and `pnpm test:runner-container`.
   Run the real private hygiene scan against the final committed tree and generated assets without printing the deny list.
   Record exact candidate SHA, command results and list digest in the PR body.
3. Drive no-mistakes with `--skip ci` and this fake-only verification plan.
   Any source or test fix reruns frozen install, lint, tests, aggregate check and private hygiene against the final candidate before delivery.
   Confirm the published head is ready and mergeable, scan that exact head again and record per-step timings in the PR body.
