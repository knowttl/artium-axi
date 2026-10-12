# S07 verification plan

All verification is local and uses synthetic canaries and the fake executable.
No live service, real credential, deployment, publication outside the private repository or destructive action is part of this slice.

See [scan.ts](../src/server/runner/scan.ts) for the scanner interface, [runner.ts](../src/server/runner/runner.ts) for integration and [README.md](../README.md) for user-facing limitations.

`pnpm exec vitest run src/server/runner/scan.test.ts` checks raw and encoded values at every byte boundary in both streams, one-byte UTF-8 chunks, independent interleaved stream state, latched matches, overlapping prefixes, near matches, multiple and short values, and empty-value rejection.
It feeds more than 4 MiB per stream before a canary and tests canaries crossing the cap.
The real fake executable supplies all four leak encodings and split-output cases on both streams.
Inspection of [the scanner implementation](../src/server/runner/scan.ts) verifies that retained state is bounded by the known secret patterns, independent of output size.

Follow [README.md](../README.md) for local validation commands and mandatory private hygiene checks, and [`.no-mistakes.yaml`](../.no-mistakes.yaml) for pipeline commands and the absence of hosted CI.
Record exact HEAD and command results in the PR body.
If a pipeline fix changes source or tests, repeat those final-head checks before delivery.
Scan the exact published head once more before reporting the PR ready.

Existing container checks remain documented in README.
This slice changes no container recipe, tool pin, native dependency or fake-service network behaviour.
See [the evidence ledger](evidence-ledger.md) for deferred captain live acceptance.
