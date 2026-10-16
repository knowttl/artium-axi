# S42 health and CLI diagnostics verification

The [health service](../src/server/health/health.ts) owns per-tool exclusion, scheduled harmless reads, manual tests and revision-bound cached results.
The [app](../src/server/app.ts) owns scheduling lifetime, stored tool listing and the CLI version gate.
The [package version](../package.json) is shared by the bundled request header and server's minimum accepted release.
The [doctor command](../src/cli/doctor.ts) checks local HTTPS and authenticated API responses, then reports stored tool status.
The existing AGENTS.md command pointers remain correct and need no factual change.

## Local fake-only verification plan

Run `pnpm install --frozen-lockfile` and `pnpm check` against the final implementation commit.
Run the mandatory `pnpm test:containers` after compilation, with only task-owned canary resources and fake-service networks.
Run `pnpm hygiene:check` with the external private deny list against the final candidate tree and generated assets.
Do not print or copy the deny list.
Record final head, exit statuses, container input/output digests, cleanup and timings in the delivery PR body.
Any pipeline source or test repair invalidates the previous evidence and requires these checks again.
Hosted CI stays disabled.
No live credentials, tenant, appliance, deployment, release or registry publication is part of this verification.

Run `pnpm exec vitest run test/integration/health.test.ts test/integration/admin-tools.test.ts test/cli.test.ts test/integration/cli-auth.test.ts` for focused acceptance.
Fake-time tests hold one scheduled check across multiple intervals, reject overlapping manual tests and prove repeated scheduling, shutdown and disabled/unconfigured skips.
Replacement during a held check schedules one fresh revision check without storing stale results.
Listing reads a failed cached check without preparing or running a platform call.
The current CLI version-header contract and login exemptions are documented in the [API contract](../src/shared/api.ts).
S42 checked the reserved download path's `NOT_FOUND` response, and S46 now implements the bundle and checksum downloads.
Bundled diagnostics verify trusted synthetic HTTPS and report each cached tool on its own pass/fail line.
The real local app's manual credential test uses a wrong canary credential, stores a safe failure and makes the bundled doctor print `fail: falcon-axi (error)`.
Existing manual-test tests continue to verify audit atomicity, runner quotas, current administrator authorization, stale references, safe errors and output withholding.

Live platform health, production certificate/proxy configuration and clean Windows/macOS installation remain captain acceptance checks after the full build.
