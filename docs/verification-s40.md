# S40 Tools, Credentials and Roles evidence

This document records historical S40 evidence, including the former separate Credentials screen and blank complete-replacement editor.
See [browser administration](../README.md#browser-administration) for current pages and editor behavior, and the [tool administration integration suite](../test/integration/admin-tools.test.ts) for current rendered-page checks.
The initial focused browser/tool suites passed 86 tests before the dual-revision regression additions; this result is not final-head validation.

Real browser acceptance used [the TLS fixture](../test/fake-service/browser-auth.mjs), named session `CHROME_DEVTOOLS_AXI_SESSION=artium-s40`, `start`, `selectpage 1`, then individual `open`, `fill`, `click`, `dialog`, `snapshot` and `eval` commands.
Only the fixture certificate public-key digest was trusted.
The fixture uses real Falcon and Vectra credential preparation, encrypted storage and the runner, replacing only the upstream executable with the local fake.
Initial detached fixture launches were terminated by the command harness, so the successful run kept the fixture as a tracked foreground process.
The CLI's multi-step `run` command lost its bridge with `socket hang up` and reset to an unselected blank page.
Individual commands completed acceptance successfully.

Browser acceptance set and replaced Falcon and Vectra canaries.
Both Test buttons displayed `Test passed.` with status `ok` for valid canaries and `Test failed.` with status `error` for the invalid canary.
See the [runbook](runbook.md#scripted-administrator-sessions) for current credential diagnostic behavior.
After replacement, browser evaluation found no stored canary in rendered HTML and all credential editors blank.
The Vectra native settings editor rejected malformed JSON locally and empty operations through the API, then saved and displayed `writes: { allowWrites: true, operations: ["notes.set"] }` at revision 5.
The browser confirmed no Azure enable control.
The Roles screen created `Browser Role`, renamed it to `<b>Browser Role</b>` and granted Falcon at revision 3.
The name rendered as text with zero injected elements.
The Users screen assigned that role to a synthetic ordinary user, whose next run returned 200.
Removing the role through Users advanced the user revision to 3 and immediately denied the next run with the same token: 403 `TOOL_NOT_GRANTED`.
Screenshots of Tools, Credentials and Roles were inspected for layout, and Chrome reported no JavaScript errors.
The browser session and fixture were stopped after acceptance.

README and the existing evidence ledger entry were updated before final validation, with one row per task.
AGENTS.md still points to the correct toolchain, aggregate, container and hygiene owners and needs no factual correction.
All verification is local and fake-only, using synthetic identities and canary credentials.
Final committed-head checks are `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm test:containers`, `docker compose -f compose.example.yaml config --quiet` and the real private deny-list scan through `pnpm hygiene:check`.
The PR body must record the checked head, command results, container input/output digests, cleanup and no-mistakes per-step timings.
Any pipeline source or test repair repeats these required checks before delivery.
Live credential checks, real changes and production deployment remain separate captain gates.
