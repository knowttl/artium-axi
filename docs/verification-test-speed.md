# Test speed: controlled request deadline and file profiling

The full local suite remains mandatory.
These measurements use Linux x64, Node v24.17.0, pnpm 10.22.0 and 12 available CPUs, with synthetic identities, canary credentials and local fake services only.
The baseline is main commit `4df8ad226d529fa543eef3c5d1809cec349834cf`.

## Controlled-clock contract

`test/cli.test.ts` still runs both commands against a real HTTPS server that stalls headers or bodies, and asserts exactly four requests, one per case, without retries.
The production bundle remains the subject of every other test in that file.
The stalled cases use the same bundled CLI entry point with `test/cli-clock.ts` injected by esbuild into a separate temporary test bundle.
The production build has no clock injection, environment switch or runtime test hook.
The only production change names the existing 90,000 ms request deadline as `DEFAULT_REQUEST_DEADLINE_MS`.

The parent waits for the server to receive each complete TLS request.
For a body stall, it also waits for the child to receive the response headers.
It checks that the child scheduled the configured default deadline, advances to 89,999 ms, and verifies that the socket remains open and the command has no result.
Advancing the final millisecond invokes the actual scheduled abort callback, with the actual request, response and socket cleanup handlers.
The clock never supplies a successful response or substitutes a network error.
The child remains alive through IPC until the parent observes the stalled socket close, preventing process exit from masking cleanup failures.
The child then exits naturally with `SERVER_UNAVAILABLE` and status 1.
Real watchdogs still fail a stalled harness independently of the controlled clock.

## Measurements

`pnpm install --frozen-lockfile` passed in 1.3 seconds before profiling.
Baseline `pnpm test --reporter=default --reporter=json --outputFile=.test-speed-before.json` passed all 906 tests in all 44 files in 96.84 seconds.
The stalled-request case took 90.35 seconds and the CLI file took 95.12 seconds.
The next largest baseline files were `admin-users.test.ts` (61.03 seconds), `api.test.ts` (57.71 seconds), `admin-tools.test.ts` (46.63 seconds), and `cli-auth.test.ts` (26.77 seconds).

After the clock change, the default full `pnpm check` passed all 906 tests in 67.55 seconds of suite time, followed by a successful build.
The focused CLI file passed all 26 tests in 6.99 seconds including startup and compilation.
The four-worker profile passed all 906 tests in 68.78 seconds, with the CLI file reduced to 4.31 seconds and user, API and tool integration files still taking 58.45, 55.02 and 42.55 seconds respectively.
The eight-worker profile passed all 906 tests in 59.12 seconds, with the stalled case taking 0.34 seconds and user, API and tool integration files taking 57.95, 54.09 and 43.84 seconds respectively.
The profile supports limiting file concurrency to eight workers, bounded by the host's available CPU count, while preserving Vitest's default file isolation and every suite.
Three consecutive full-suite runs after applying the cap passed all 906 tests in all 44 files in 58.91, 60.02 and 59.70 seconds.
The stalled case took 0.29, 0.52 and 0.26 seconds respectively.
Their mean suite time is 59.54 seconds, 38.5% below the 96.84-second baseline, with unchanged test count and no failures across these runs.
Profiling outputs are temporary local evidence and are removed before publication.

## Final candidate verification plan

Run the following against the committed candidate, in dependency order, recording exact head, exit statuses and elapsed times in the PR body.
Repeat applicable checks after any pipeline source or test repair.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:containers
ARTIUM_AXI_HYGIENE_DENY_LIST_FILE=<private-absolute-path> pnpm hygiene:check
```

`pnpm test:containers` includes the runner resource checks, walking skeleton and both fake-service modes, and owns cleanup of only its unique `artium-test-*` resources.
Retain its head/input/output digests, image identities, elapsed times and cleanup result as final candidate evidence.
The real hygiene scan covers the committed candidate tree, generated bundles and HEAD commit messages; never print the private deny-list terms.
Run no-mistakes with this local fake-only plan and `--skip ci`, because the repository declares no hosted CI.
Its PR must target `knowttl/artium-axi`, base `main`, and include before/after suite counts and times, local check and container evidence, hygiene results and per-step pipeline timings.
After publication, confirm the PR is ready and mergeable and repeat hygiene on the exact published head.
No worker merges the PR.
