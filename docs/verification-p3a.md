# Invitation management verification

This is P3a of three sequential Entra browser sign-in slices.
It added administrator invitation preparation and management before provider activation was available.
See [Sign-in settings](../README.md#sign-in-settings) for current availability and [P3 activation verification](verification-p3c2b.md) for complete fake-provider browser acceptance.

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
The body must state the problem, consequence, fix and P3a scope, and link to the subsequent slices above.
The P3a browser suite proves invitation preparation only; see [P3 live acceptance](verification-p3c2b.md#live-acceptance) for the pending maintainer check.
No real provider, tenant, client or credential is used for these checks.
Stop at a ready, mergeable PR; do not merge.
