# Invitation management verification

This is P3a of three sequential Entra browser sign-in slices.
It adds administrator invitation preparation and management while providers remain disabled.
P3b adds the browser protocol, invitation claim and identity linking, role synchronization, authentication audit and rate limits.
P3c adds safe activation, break-glass policy, SSO reauthentication, sign-out, the setup guide and complete browser acceptance.

## Local checks

Use only the repository's fake services, synthetic identities and canary credentials.
Run `pnpm exec vitest run test/integration/admin-providers.test.ts` for invitation creation, hashed link storage, unchanged local accounts, token rotation, expiry, revision checks, terminal states, pagination, role references, access control and audit rollback.
Run `pnpm build` before browser probes.
Run `node --test --test-name-pattern=invitations test/browser/admin-shell.mjs` for the real create/resend/revoke forms, one-time link display and local-link preparation through inline recent-auth confirmation.
Run `pnpm check` and `pnpm test:browser` for the aggregate and existing browser regressions.
Run the mandatory fake-only `pnpm test:containers` when the host permits the private privileged BuildKit builder, retaining its digest-bound evidence and cleanup result.
Record an unsupported container host as unverified rather than a pass.
The supervising maintainer owns the private deny-list check before merge; workers must not seek that list.

## Publication and live acceptance

Create the pull request through `gh-axi` with `--repo knowttl/artium-axi -B main`.
The body must state the problem, consequence, fix and P3a scope, and name the P3b and P3c follow-ups above.
Keep the live gate recorded as **PENDING (maintainer live Entra check)**: one real sign-in and one invitation claim on the test copy after the complete browser flow is PR-ready.
The P3a browser suite proves invitation preparation only; it cannot establish sign-in or claim acceptance before P3b and P3c.
No real provider, tenant, client or credential is used for these checks.
Stop at a ready, mergeable PR; do not merge.
