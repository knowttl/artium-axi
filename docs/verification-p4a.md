# CLI SSO sign-in and bearer reauthentication (P4)

This change delivers all of P4: device creation, polling, approval and denial, the browser approval page, `login --sso`, the 8-hour SSO CLI family cap, bearer reauthentication through device approval, CLI help and account instructions.
The initial P4a/P4b split was withdrawn with firstmate approval on 2026-10-15.

The README owns [CLI sign-in and bearer reauthentication usage](../README.md#sign-in-settings), [audit fields](../README.md#audit-screen-and-api) and [session limits](../README.md#security-and-acceptance-boundaries).
The [shared API contracts](../src/shared/api.ts), [configured defaults](../src/server/config.ts) and [device approval implementation](../src/server/auth/device.ts) own the protocol, limits and approval invariants.

## Verification

`pnpm exec vitest run test/integration/browser-sso.test.ts` passed 58 tests, including fresh-auth enforcement, request details, single collection, family cap and refresh, denial, expiry, polling and address limits, failed audit and revocation.
`pnpm exec vitest run test/integration/cli-auth.test.ts src/server/auth/tokens.test.ts` passed 52 tests, including refusal of mixed SSO/password flags and the existing local login, refresh and revocation contracts.
`pnpm build && node --test test/browser/sso-protocol.mjs` passed all 21 browser tests in 121 seconds, including bundled CLI approval, denial, expiry, consumed-code refusal, creation rate limits and account instructions against the fake provider.
The browser cases run the bundled CLI with a synthetic CA and drive the real `/device` and provider pages through `chrome-devtools-axi`.
The existing P3 browser journeys also passed, including Strict-cookie callback hops, pending-form SSO reauthentication, invitation claims, role synchronization and provider activation.
These recorded worker runs cover P4a device sign-in, rather than the later bearer reauthentication additions.
Bearer reauthentication coverage in [the integration suite](../test/integration/browser-sso.test.ts) exercises same-user approval, family-bound tickets, single collection, token binding, polling limits, denial, expiry, revocation, disabled users and providers, and audit failure.
The no-mistakes pipeline owns final-candidate baseline and container verification; its results are recorded with delivery evidence.
The shared Account help now follows the signed-in user's source: SSO users receive `login --sso` guidance without local password-change instructions; local users retain their existing guidance.
The browser regression reproduced the stale SSO help before correction and checks both SSO and local Account help through the real pages.
`pnpm build && node --test --test-name-pattern='bundled CLI device sign-in: approve|ordinary account shows role tools' test/browser/sso-protocol.mjs test/browser/admin-shell.mjs` passed both browser checks after correction.

Live acceptance: **PENDING (maintainer live Entra check)**.
The maintainer's real Entra sign-in and invitation claim happen after the build and do not hold this merge.
All implementation checks use local fakes, synthetic identities and canary credentials.
The private deny-list check is owned by firstmate before merge; this worker does not possess the list.
