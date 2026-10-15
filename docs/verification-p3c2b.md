# P3 safe activation and browser acceptance

This slice completes P3 with locally validated, audited provider activation, the in-app Entra setup guide, copy buttons and per-rule match counts.
Fresh installations keep providers disabled and designate no break-glass accounts automatically.
CLI SSO/device approval and generic OIDC remain later phases.

## Verification plan

Run `pnpm exec vitest run test/integration/admin-providers.test.ts test/integration/browser-sso.test.ts src/server/store/sso-schema.test.ts src/server/store/provider-credentials.test.ts src/server/store/authentication-schema.test.ts`.
Activation must reject incomplete or invalid credentials and unavailable emergency accounts, require recent administrator authentication, enforce revisions and roll back with failed audit persistence.
Saving a credential disables an activated provider again.
Existing API contracts and migration tests remain green.

Build before browser checks with `pnpm build`.
Run `node --test test/browser/admin-shell.mjs test/browser/sso-protocol.mjs` using `chrome-devtools-axi` against the local fake provider and synthetic identities only.
The protocol suite covers the Strict-cookie callback hop, a CSP-compatible start link, refused uninvited users, wrong-username claims, reused and expired invitation links, tampered tokens, wrong issuer and replayed state.
It also covers identity linking, rule synchronization, fresh SSO confirmation, optional provider sign-out and break-glass password admission and audit flags.
New journeys exercise activation and deactivation through real administrator forms, exact setup URI values, clipboard success and denied-permission fallback, and new-rule previews from last validated claims followed by count refresh at sign-in.
Match counts are local observations of enabled, unarchived users, not live directory membership.
Migration 018 defaults existing identities to unknown sign-in claims until their next successful sign-in.

Run `pnpm check` and mandatory fake-only `pnpm test:containers` when the host permits its task-owned privileged BuildKit worker.
Record unsupported container acceptance as not run, with its cause.
Retain head, input and compiled-output digests and cleanup evidence for successful container acceptance.
Firstmate owns the private deny-list check; workers must not seek the list.

## Implementation evidence

The full Vitest baseline passed 2,712 tests across 62 files.
The final focused five-file run passed all 142 tests, including unavailable emergency accounts and migration defaults for existing identities.
TypeScript, the generated error reference, compilation and AXI distribution checks passed.
The first aggregate check's build rejected changing inputs during implementation; a clean build and the remaining lint/distribution checks subsequently passed against the stable candidate.

The combined real-browser run passed 62 of 63 cases, including all 17 SSO cases and the complete P3 protocol checklist.
Its sole failure was an older assertion requiring the removed sign-in-unavailable message.
The corrected case passed separately, including certificate persistence, secret non-disclosure, disabled setup and the 420-pixel overflow check.
Together these runs cover all 63 unique browser cases successfully.

`pnpm test:containers` exited 0 in 182,308 ms on Linux x64 with Node v24.14.0 and Docker 29.8.1.
The host permitted the task-owned privileged BuildKit worker.
Runner limits and exhaustion, the walking skeleton, fake-service probes, production package execution, backup and restore passed.
`cacheRemoved: true` confirms cleanup of the private builder/cache and task-owned test resources.
The container run exercised source commit `404bb987678deb53a260ba5999493c52a174e09b`; the delivery follow-up adds only this verification evidence.
Its relevant input digest was `dc9a9d542deb90c6258d8354df47697b847ad7667cbf00d494286f041e798fa4` and compiled-output digest was `a1c0db642ad2b8e5ea1c54070f6d7483e4bd116ff1f6cb83e31d2d4c64b91557`.
Recorded image identities were `sha256:72c7dee7a4b9a1c418d548664931649aaac593821db3366fd22d5bf13c824130`, `sha256:b91b2bcf7f3d9a5ebcbf99c70c87f640ea82aa5743980fc65a822e07fa3cbc6b` and `sha256:470015c1ab1577c19efce2e80cdad4afd9c682cf8f4dcf3dccae5abfd9113397`.
Reuse container evidence only while both digests match; pipeline source changes require fresh container acceptance.

## Live acceptance

**PENDING (maintainer live Entra check)**: one real Entra sign-in and one invitation claim on the test copy.
The maintainer deferred these checks until after the build; they do not hold merge.
Local activation validates stored configuration and usable emergency access, not Entra application registration, upstream credential acceptance or Conditional Access.
The fake-provider browser suite provides local acceptance evidence.

## Publication

The PR body must state the problem, consequence, fix and this final P3 slice's scope, with the live check pending as above.
Create the PR through `gh-axi` with `--repo knowttl/artium-axi -B main` and supply this file as the verification plan.
Stop at a ready, mergeable PR and do not merge.
