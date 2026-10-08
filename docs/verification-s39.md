# S39 Users screen evidence

The [Users screen](../src/server/admin/users.ts) renders account and role data from the existing paginated admin API.
It uses the [shared escaping helper](../src/server/admin/escape.ts) also used by authentication pages and safe error pages.
The [browser assets](../src/server/admin/assets.ts) provide the layout and one small script for confirmations and JSON form submission.
The server renders every account value as escaped text, including usernames, display names, role names, actor names, timestamps and revisions.
The page lists enabled state, administrator capability, password-change requirement and lockout state.
Each form uses session-bound CSRF proof and the existing recent-auth contract.
Enable/disable and role replacement include the displayed optimistic revision.
Reset and unlock retain their existing API contracts without a revision input.
The script follows password-confirmation and session-expiry redirects, shows safe API errors as text and reloads account metadata after success.

The [browser integration suite](../test/integration/browser-auth.test.ts) verifies rendered HTML usernames and role names, actor/time/revision, bounded account pagination and roles beyond the first API page.
Existing S33, S34 and S38 suites cover atomic audit, optimistic conflicts, revocation, lockout clearing, CSRF and recent-auth gates through the real API.
The real browser acceptance uses [the TLS fixture](../test/fake-service/browser-auth.mjs), a named `CHROME_DEVTOOLS_AXI_SESSION=artium-s39` and `selectpage 1` before `open`.
Only the fixture certificate public-key digest is trusted by this Chrome session.
Acceptance creates an HTML-containing username, disables and enables it, resets its password, clears lockout and assigns the synthetic role through actual page forms and confirmation dialogs.
The browser also checks confirmation cancellation, validation errors, stale revisions and the recent-auth redirect.
The browser and fixture stop after acceptance.
The recorded local flow created `<b>canary</b>` with display name `<img src=x>` and found zero injected HTML elements.
An invalid temporary password showed the password-rule message while preserving the username.
Cancelled enable confirmation preserved revision 4, reset advanced to revision 6, unlock cleared five failed attempts and assignment persisted `synthetic-role` at revision 8.
A stale revision 7 disable showed the conflict message without mutation.
After a 900000 ms fake-clock advance, disable redirected to `/reauth`, then succeeded at revision 9 after password confirmation.
Chrome reported no JavaScript errors, and the screenshot was reviewed for layout and escaped text.

README and the existing administration ledger entry were updated before final validation.
AGENTS.md still points to the correct package, aggregate, container and hygiene owners and requires no factual correction.
Final committed-head verification is `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm test:containers`, Compose configuration validation and the real private deny-list scan.
The PR body records the final head, results, container input/output digests and no-mistakes step timings.
Any pipeline source or test repair repeats the required checks.
All evidence uses local fakes, synthetic accounts and canary passwords.
Production deployment and live-service acceptance remain captain checks.
