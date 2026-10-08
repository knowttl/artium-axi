# S28 local accounts

`AuthProvider.signIn` returns the internal user ID and must-change state.
Roles and audit continue to use the internal user ID.
`LocalAuthProvider` looks up usernames after trimming and lowercasing, while display names remain separate.
Future creation and reset producers must use `canonicalUsername` and `hashPassword`.

Passwords preserve spaces and Unicode without normalization or trimming.
The bounds are 15 to 128 Unicode code points and at most 512 UTF-8 bytes.
`common-passwords.v1.json` is the versioned bundled list of exact common-password matches.
TypeScript copies the imported JSON into the build output, including the runtime image.

Argon2id uses 65536 KiB, three iterations and parallelism one.
Unknown usernames verify a precomputed dummy hash at those same costs and return `SIGN_IN_FAILED`, as incorrect passwords do.
Hash creation and verification share two process-wide slots, rejecting excess requests with `AUTH_BUSY`.
There is no hashing queue.

`POST /v1/auth/password` accepts a normal access token and a strict JSON body containing `newPassword` and `currentPassword`.
Success returns 204 and requires another sign-in.
The password update, must-change clear, revision increment, all CLI/browser session revocations and audit record commit together.
Concurrent password replacements cannot overwrite a password changed during hashing.
Static development tokens cannot change passwords.
Login issuance and restricted single-use password-change tokens remain S30 work.

Run `pnpm exec vitest run src/server/auth/local.test.ts test/integration/api.test.ts` for boundary, sign-in, admission, successful change, rejection, revocation and audit rollback evidence.
The local benchmark uses canary passwords with the production costs.
Run the built image without networking and import the local provider to verify that the bundled list actually rejects a listed password.
Final committed-head install, lint, test, aggregate, private hygiene and container results belong in the delivery status and PR body.
Production-host hashing capacity remains unverified until captain acceptance.
