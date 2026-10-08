# S38 browser authentication evidence

The [browser routes](../src/server/auth/browser.ts) own sign-in, sign-out, password change, password confirmation, same-origin checks and CSRF protection.
The [session module](../src/server/auth/sessions.ts) owns SQLite session issuance and verification.
The [configuration](../src/server/config.ts) owns the 30-minute idle, 12-hour absolute and 15-minute recent-auth defaults.
The shared password provider owns validation, hashing and atomic password/session revocation for both browser and CLI callers.
Existing administrator routes use current account capability and browser recent-auth checks on mutations, including credential tests.
Bearer authentication and its session-bound tickets retain their existing contract.

The [integration tests](../test/integration/browser-auth.test.ts) exercise the real application, SQLite, password hashing and form parser against synthetic users.
They verify opaque cookie attributes, no CLI tokens issued to browsers, audited sign-in/sign-out, missing and cross-browser CSRF denial, same-origin checks, every admin mutation method, credential-test gates, idle/absolute expiry, idle extension without absolute extension, forced change, restricted expiry, revocation, stale/recent password-change proof, current capability and escaped account data.
Time-dependent checks control `Date.now` without sleeps.
Run `pnpm exec vitest run test/integration/browser-auth.test.ts` for focused acceptance.

The [local browser fixture](../test/fake-service/browser-auth.mjs) starts the compiled real server behind a loopback-only TLS proxy with an ephemeral certificate and synthetic administrator requiring a password change.
Run `pnpm build`, then `node test/fake-service/browser-auth.mjs` in a harness-tracked session.
It prints the TLS URL, certificate public-key digest and loopback fake-clock control URL.
Use a named `CHROME_DEVTOOLS_AXI_SESSION` and bind Chrome test trust to only the printed certificate digest with `--ignore-certificate-errors-spki-list=<digest>`.
Run `chrome-devtools-axi selectpage 1` before opening its `/login` URL.
Exercise the actual sign-in, forced-change, new-login, reauthentication and sign-out forms.
Advance the fixture's clock through its loopback-only `/test/clock` endpoint to exercise the 15-minute administration challenge and session expiry.
The fake-clock route exists only in this fixture and is never registered by production `createApp`.
Stop the named Chrome session and the fixture after acceptance.

Before validation, README and the existing T4.6 ledger row were updated.
AGENTS.md already points to the correct package, aggregate, container and hygiene owners and needs no factual correction.
Final candidate validation uses `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm test:containers` and the real external private hygiene scan.
The PR body records the exact candidate SHA, results, timings and container evidence.
Any pipeline repair that changes source or tests repeats those checks on the final candidate.
All evidence uses local fakes, synthetic users and canary credentials.
Production TLS, public URL, cookie/proxy deployment and live-service acceptance remain captain checks.
