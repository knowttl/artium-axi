# Break-glass local authentication verification

This is P3c-2a, following P3c-1's SSO reauthentication and optional provider sign-out.
Firstmate approved the P3c-2 split before implementation under the maintainer's standing rule for smaller independently testable slices.
P3c-2a delivers break-glass designation, shared local-password enforcement, browser and bearer confirmation, recovery and audit.
P3c-2b will add safe activation, the Entra setup guide, copy buttons, match counts and full P3 fake-provider browser acceptance.
Production provider settings still cannot activate SSO; a fresh installation keeps providers disabled and designates no accounts.
CLI SSO/device approval and generic OIDC remain later phases.

## Behaviour

Only local administrators can be designated break-glass, using the user detail page or the revision-checked user patch API.
Database constraints also prevent invalid designations.
Designation changes require administrator capability and recent identity confirmation and commit with `designate-break-glass` or `remove-break-glass` audit actions.
Removing designation revokes every browser session and CLI token family for that account atomically with its audit record.
Demoting an administrator clears designation and revokes their sessions; linking to SSO clears designation as part of the existing audited identity conversion.
Disabled accounts still cannot sign in.
Offline recovery designates the recovered local administrator, resets their password with must-change and revokes prior sessions in its existing audited transaction.

Local password sign-in, confirmation and changes share one policy boundary.
While every provider is disabled, existing local accounts can continue using passwords.
When any provider is enabled, only designated local administrators can authenticate with a password, including an existing session attempting confirmation or a password change.
The policy is rechecked after asynchronous password verification or hashing before success is committed.
This slice exercises enabled providers through fake-only test fixtures; no production activation control is exposed.

Successful local sign-in and confirmation events carry `authentication_method` as `local` or `break-glass`.
Designation is flagged on the users table and signed-in header, and break-glass events are highlighted on the Audit page.
Audit exports and the JSON stdout stream carry the same structured method field for alerting.
The Overview page remains a later-phase feature.

## Verification plan

Use only synthetic identities, canary credentials and the local fake provider.
Run `pnpm exec vitest run src/server/auth/local.test.ts src/server/store/sso-schema.test.ts test/integration/admin-users.test.ts test/integration/browser-auth.test.ts test/integration/browser-sso.test.ts test/integration/bootstrap.test.ts test/integration/cli-auth.test.ts`.
These cover admission, asynchronous policy changes, browser/bearer confirmation, designation validity and revisions, revocation, audit rollback, linking, migration and executable offline recovery with SSO enabled.
Build with `pnpm build` before browser checks.
Run `node --test test/browser/admin-shell.mjs test/browser/sso-protocol.mjs` to exercise designation and removal through real forms, refused undesignated local login, and break-glass login and confirmation with visible Audit flags.
The existing SSO protocol cases remain regression coverage; complete P3 acceptance belongs to P3c-2b.
Run `pnpm check` through delivery and the mandatory fake-only `pnpm test:containers` when the host permits its task-owned privileged BuildKit worker.
Record unsupported container acceptance as not run, with its cause.
Retain head, input and compiled-output digests and cleanup evidence for any successful container gate.
Firstmate owns the private deny-list check and workers must not seek that list.

### Implementation evidence

The focused seven-file Vitest run passed 342 tests with one incorrect new redirect assertion; correcting the assertion to verify the login destination and rerunning affected cases passed all 30 selected tests.
The real-browser suite passed all 61 cases with zero failures, including the three new break-glass journeys.
TypeScript, build, AXI distribution checks and the generated error reference passed.
The delivery pipeline runs the configured full Vitest baseline and lint gates.

`pnpm test:containers` exited 0 in 134,992 ms on Linux x64 with Node v24.14.0.
The host permitted the task-owned privileged BuildKit worker, and `cacheRemoved: true` confirms cleanup.
Runner limits and exhaustion, walking skeleton, fake services, production package execution, backup and restore passed.
The container run used the complete implementation working tree atop parent `79525a50f23e808312a445951cd2b2f3e86a264f`; the delivery commit records those same source inputs plus verification documentation.
Its input digest was `d26fc15368bbcbb6d257e1c36358ae6ba305dba028443ea9d00eaadf5d6ba2a5` and compiled-output digest was `de4e8cdfc6a0852b67dcb9db74c9d0ce2761b60f4a042117ae415cdb411f1b2b`.
Recorded image identities were `sha256:8787ca22bd9028170d76b7a99c72013c199211c1dc16d4f0be4f6840eefe96ce`, `sha256:cdacf7dcd538021e252d13e2c80189a3215f72bf717648c3017e718806327069` and `sha256:470015c1ab1577c19efce2e80cdad4afd9c682cf8f4dcf3dccae5abfd9113397`.
Reuse this evidence only while both digests match; pipeline source changes require fresh container acceptance.

## Publication and live acceptance

The PR body must explain the problem, consequence, fix and P3c-2a scope, including the approved P3c-2b follow-up.
Create it through `gh-axi` with `--repo knowttl/artium-axi -B main`.
Stop at a ready, mergeable PR and do not merge.
Live acceptance remains **PENDING (maintainer live Entra check)**: one real Entra sign-in and one invitation claim on the test copy.
The maintainer deferred those checks until after the build; fake-provider browser evidence supplies local acceptance and the live check does not hold this merge.
