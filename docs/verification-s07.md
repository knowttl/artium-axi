# S07 verification plan

All verification is local and uses synthetic canaries and the fake executable.
No live service, real credential, deployment, publication outside the private repository or destructive action is part of this slice.

The scanner's public interface is `SecretScanner.scan(stream, bytes)`.
The caller must scan before truncation and discard both streams when the result is true.
Process execution, output retention, `SECRET_IN_OUTPUT` response mapping and audit events belong to subsequent runner and API slices.

`pnpm exec vitest run src/server/runner/scan.test.ts` checks raw and encoded values at every byte boundary in both streams, one-byte UTF-8 chunks, independent interleaved stream state, latched matches, overlapping prefixes, near matches, multiple and short values, and empty-value rejection.
It feeds more than 4 MiB per stream before a canary and tests canaries crossing the cap.
The real fake executable supplies all four leak encodings and split-output cases on both streams.
The scanner retains only patterns, prefix tables and per-stream match positions, with no accumulation of output bytes.
Its memory is bounded by the known secret patterns, independent of output size.

Before starting no-mistakes, run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test`, `pnpm check`, then the private hygiene scan on the committed candidate.
Set `ARTIUM_AXI_HYGIENE_DENY_LIST_FILE` to the supervisor-provided private path without copying or printing its contents.
Record exact HEAD and command results in the PR body.
If a pipeline fix changes source or tests, repeat those final-head checks before delivery.
Use no-mistakes with `--skip ci --verification-plan docs/verification-s07.md` because the repository has no hosted CI.
Scan the exact published head once more before reporting the PR ready.

Existing container checks remain documented in README.
This slice changes no container recipe, tool pin, native dependency or fake-service network behaviour.
Live upstream redaction for unknown minted tokens remains unverified.
