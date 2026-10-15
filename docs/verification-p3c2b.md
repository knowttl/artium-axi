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

## Live acceptance

**PENDING (maintainer live Entra check)**: one real Entra sign-in and one invitation claim on the test copy.
The maintainer deferred these checks until after the build; they do not hold merge.
Local activation validates stored configuration and usable emergency access, not Entra application registration, upstream credential acceptance or Conditional Access.
The fake-provider browser suite provides local acceptance evidence.

## Publication

The PR body must state the problem, consequence, fix and this final P3 slice's scope, with the live check pending as above.
Create the PR through `gh-axi` with `--repo knowttl/artium-axi -B main` and supply this file as the verification plan.
Stop at a ready, mergeable PR and do not merge.
