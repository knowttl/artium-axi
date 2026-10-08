# S41 Audit API and screen evidence

The [API contract](../src/shared/api.ts) defines read-only `GET /v1/admin/audit`, administrator authorization, no successful-read audit event, limits from 1 to 100 (default 50), actor ID `user`, fixed `tool`, exact `outcome` and inclusive UTC ISO `from`/`to` filters.
Bearer callers need the existing session-bound recent password ticket; browser reads require the current administrator capability without recent confirmation.
Authorization denials use the existing audit event pattern.
No audit mutation or deletion route exists.

The [audit store](../src/server/audit/audit.ts) returns timestamp-descending, ID-descending pages.
The bounded cursor carries the initial maximum ID and the last returned timestamp/ID, excluding later inserts even when their timestamps are backdated.
The query fetches at most limit plus one records to detect continuation.
The [screen](../src/server/admin/audit.ts) reuses the shared browser layout, navigation and escaping, retains filters on continuation links, and starts over when the filter form is submitted.
Records show actor, UTC time, event, outcome, tool, action, target, request, redacted arguments, execution metadata and available credential-test or retention evidence.

The [administration API tests](../test/integration/admin-users.test.ts) verify same-time ordering, new and backdated inserts between pages, default and maximum bounds, cursor validation, each filter, combined and empty results, inclusive time boundaries, non-administrator denial, recent-auth enforcement and unavailable mutation routes.
The [browser integration tests](../test/integration/browser-auth.test.ts) verify current administrator access, escaped record and actor fields, filters retained across pages, no-store responses, empty form fields and invalid queries.
The initial focused run passed 123 tests and identified three test requests with an empty JSON body rather than an absent content-type.
After correcting those requests, the targeted audit run passed all 49 selected tests.
Final committed-head validation supersedes those focused results.

Real browser acceptance used the existing fake-only [TLS fixture](../test/fake-service/browser-auth.mjs), named session `CHROME_DEVTOOLS_AXI_SESSION=artium-s41`, `start`, `selectpage 1`, then single `open`, `fillform`, `fill`, `click`, `dialog`, `eval`, `snapshot`, `screenshot` and `console` commands.
Only the fixture certificate public-key digest was trusted.
The fixture ran real credential preparation, encrypted storage, authentication, SQLite and runner, with the upstream executable replaced by the local fake.
The browser completed forced password change and sign-in, created a synthetic user through Users, enabled Falcon through Tools, set a canary credential and tested it through Credentials, and created a role through Roles.
Audit showed those changes and the credential test's start and terminal records newest first.
Filtering by actor, success outcome and UTC interval with a two-record page found the role and credential test on page one, credential replacement and tool update on page two, and user creation on page three.
Changing the form to Falcon and `completed` restarted pagination and found the matching successful run with exit 0, duration, observed byte counts, checked time and credential revision.
Browser evaluation found no injected elements, stored canary secret or horizontal overflow at the checked desktop size.
The screenshot was inspected and Chrome reported no console messages.
The named browser session and fixture were stopped.

README and the existing evidence ledger rows were updated before final validation.
AGENTS.md still points to the correct toolchain, aggregate, mandatory container and private hygiene owners and needs no factual correction.
All verification is local and fake-only.
The final candidate requires `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm test:containers`, `docker compose -f compose.example.yaml config --quiet` and `pnpm hygiene:check` with the real private deny list.
The PR records the exact head, command results, container digests and cleanup; any source or test repair repeats the required checks.
Live account changes, platform calls and production deployment remain captain gates.
