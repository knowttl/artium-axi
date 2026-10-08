# S29 administrator bootstrap and recovery

All verification uses local disposable SQLite stores, synthetic accounts and canary password and key files.
No live service, production credential, deployment or real administrator recovery is included.

Run `pnpm exec vitest run test/integration/bootstrap.test.ts src/server/store/db.test.ts src/server/store/authentication-schema.test.ts src/server/store/rotate-key.test.ts` for focused evidence.
The real server entry point starts twice, admitting local health traffic after bootstrap and ignoring invalid bootstrap settings on the second start.
The store tests cover first creation, canonical lookup, must-change, no tool grants, missing-marker inconsistency, invalid settings, password rejection and rollback at both administrator and marker insertion.
Last-administrator tests execute real SQLite updates and deletes, including a disabled second administrator and a valid handoff to another enabled administrator.
A marked store with no administrator never recreates an account.

The recovery executable operates on a SQLite backup copy, resets the password with must-change, clears lockout, revokes tokens and browser sessions, and records only safe audit metadata.
The original store still accepts its old password and token and has no recovery event.
Additional checks cover an existing disabled account, missing store/user/marker, maintenance contention and full rollback on audit failure.
Wrong-key recovery on a fresh bootstrapped store must fail with `MASTER_KEY_INVALID` without changing the account, marker or audit.
Store checks cover creation-key binding and transactional legacy migration with credential authentication or a matching rotation receipt, refusing legacy stores without key evidence.
Rotation checks cover metadata-update failure rollback and new-key reopen with old-key refusal, including stores with no credentials.
The existing server-versus-rotation test and container walking-skeleton fixture now seed a bootstrapped synthetic store before configuring tools.

Final committed-head verification requires `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test`, `pnpm check`, `pnpm test:runner-container` and `pnpm test:walking-skeleton`.
Run the real private hygiene scan after the build with the deny list outside the repository.
Record final-head results and pipeline timings in the PR body and delivery status.
Review the existing AGENTS.md pointers without adding project-memory content when they remain factually correct.
Captain acceptance still owns production-host bootstrap, login/password-change flows and separately authorized real recovery.
