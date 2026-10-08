# S43 CLI discovery, errors and help verification

The [CLI](../src/cli/main.ts) owns dispatch, authenticated discovery and preserved upstream streams.
The [views](../src/cli/views.ts) render home, counted tools and manifest-backed detail.
The [help catalogue](../src/cli/help.ts) owns the common usage, purpose, flags and example layout for available Artium client commands.
The pinned manifests in `tools/inventories/` own vetted upstream help, example arguments and available top-level commands.
The [error catalogue](../src/shared/errors.ts) owns HTTP status, source, CLI exit and next steps.
The [reference generator](../scripts/errors-reference.mjs) produces [errors.md](errors.md) and refuses stale output at the start of `pnpm check`.
The existing AGENTS.md toolchain and mandatory-check pointers remain factually correct and need no change.

## Local fake-only verification plan

Run `pnpm install --frozen-lockfile`, then `pnpm check` on the final implementation commit.
Run `pnpm test:containers` after compilation with only task-owned canary resources and fake-service networks.
Run `pnpm hygiene:check` using the external private deny list against the final candidate tree and generated assets.
Do not print or copy the deny list.
Record final head, command results, timings, container input/output digests, image identities and cleanup in the PR body.
Any pipeline repair changing source, tests, scripts or pins requires these checks again.
Hosted CI stays disabled.
All application probes use fakes, synthetic users and canary credentials.
Live services, production deployment, registry publication and real credentials are excluded.

## Acceptance evidence

`test/integration/cli-auth.test.ts` signs in through the real server and runs the standalone bundle with no arguments.
The home view shows the synthetic user, assigned role, tool status and pinned version, then suggests the implemented detail command and manifest example.
Tool detail does not retrieve a credential.
The suggested example runs through real adapter preparation and the runner, preserving the fake executable's local output.
Removing the role makes the same signed-in user's home show `tools: 0 available`, a reason and administrator contact.
Detail and execution then fail with `TOOL_NOT_GRANTED`.

`test/cli.test.ts` exercises every catalogue error through synthetic HTTPS, checking exact code, source, message, next step, request ID and CLI exit.
It also checks every client command's help layout without server configuration or network traffic, inaccessible detail, manifest-version mismatch and upstream help passthrough.
Existing tests cover upstream nonzero exits, separate streams, truncation diagnostics, malformed responses and usage failures before network traffic.
`test/integration/api.test.ts` exercises the real server error handler for every catalogue entry and checks the HTTP status and complete envelope.
`test/errors-reference.test.ts` executes the generator, compares its generated public reference with the committed reference, then proves the actual `pnpm check` command rejects a stale copy.

`test/walking-skeleton/probe.mjs` exercises authenticated home and tool detail in the standalone Node 22.12.0 container journey.
Pinned Falcon and Vectra run against isolated fake HTTPS services.
Their bare home, upstream help, command help and manifest example reads are compared with local pinned output through the adapter boundary.
The existing read, pagination, empty output, upstream usage-error, native write-gate and redaction checks remain in the container block.

Final validation results are bound to the implementation and published head in the PR body.
Live owner acceptance, real upstream output parity and clean Windows/macOS installation remain captain checks after the full build.
