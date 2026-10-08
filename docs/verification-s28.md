# S28 local accounts

The [AuthProvider contract](../src/server/auth/auth-provider.ts) owns the sign-in identity result.
The [local provider](../src/server/auth/local.ts) owns canonical username lookup, dummy-hash comparison, shared hashing admission and transactional password replacement.
See [S33 verification](verification-s33.md) for creation and reset checks using these boundaries.

See [README.md](../README.md) for password rules and own-password change usage, the [shared API contract](../src/shared/api.ts) for request schemas and the [error catalogue](../src/shared/errors.ts) for rejection responses.
The [versioned common-password list](../src/server/auth/common-passwords.v1.json) owns the exact rejected values.
TypeScript copies the imported JSON into the build output, including the runtime image.

The [server configuration](../src/server/config.ts) owns Argon2id costs and concurrency defaults.

Run `pnpm exec vitest run src/server/auth/local.test.ts test/integration/api.test.ts` for boundary, sign-in, admission, successful change, rejection, revocation and audit rollback evidence.
The local benchmark uses canary passwords with the configured costs.
Run the built image without networking and import the local provider to verify that the bundled list actually rejects a listed password.
Final committed-head install, lint, test, aggregate, private hygiene and container results belong in the delivery status and PR body.
Production-host hashing capacity remains unverified until captain acceptance.
