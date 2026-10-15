# CLI device sign-in (P4a)

P4 is split into independently reviewable changes with firstmate approval on 2026-10-15.
P4a implements device creation, polling, approval and denial, the browser approval page, `login --sso`, the 8-hour SSO CLI family cap, CLI help and account instructions.
P4b follows separately for bearer reauthentication through device approval and its mismatch, expiry and revocation checks.

The approval page uses the existing server-rendered shell, same-origin CSRF protection and strict CSP.
It shows the requesting IP and UTC time, a warning against approving another person's request, and an explicit “This wasn't me” denial action.
Each request requires a new provider round trip with `prompt=login` and a fresh validated `auth_time`, followed by explicit approval.
An unrelated or older browser session cannot approve it.
Approval and denial audit records retain the requesting address in `arguments.requestingAddress` and the approving address in `client_address`.
Device secrets are random 32-byte values stored only as hashes in a bounded process-local map.
Requests expire in ten minutes; a server restart invalidates them.
Creation and code entry have independent address limits using the existing authentication defaults.
Polling enforces the advertised five-second interval per device secret.
Collection rechecks the approving browser session and enabled provider, issues normal artium tokens and consumes the request.
Refresh preserves the original 8-hour family expiry; local CLI families remain 12 hours and browser sessions retain their existing limits.

## Verification

`pnpm exec vitest run test/integration/browser-sso.test.ts` passed 58 tests, including fresh-auth enforcement, request details, single collection, family cap and refresh, denial, expiry, polling and address limits, failed audit and revocation.
`pnpm exec vitest run test/integration/cli-auth.test.ts src/server/auth/tokens.test.ts` passed 52 tests, including refusal of mixed SSO/password flags and the existing local login, refresh and revocation contracts.
`pnpm build && node --test test/browser/sso-protocol.mjs` passed all 21 browser tests in 121 seconds, including bundled CLI approval, denial, expiry, consumed-code refusal, creation rate limits and account instructions against the fake provider.
The browser cases run the bundled CLI with a synthetic CA and drive the real `/device` and provider pages through `chrome-devtools-axi`.
The existing P3 browser journeys also passed, including Strict-cookie callback hops, pending-form SSO reauthentication, invitation claims, role synchronization and provider activation.
The worker browser run used the final source, test and build inputs with only documentation and commit metadata changed afterwards.
The no-mistakes pipeline owns final-candidate baseline and container verification; its results are recorded with delivery evidence.

Live acceptance: **PENDING (maintainer live Entra check)**.
The maintainer's real Entra sign-in and invitation claim happen after the build and do not hold this merge.
All implementation checks use local fakes, synthetic identities and canary credentials.
The private deny-list check is owned by firstmate before merge; this worker does not possess the list.
