# S17+S18 local verification

T3.3 is verified locally with synthetic identities, canary credentials, temporary SQLite databases and the existing deterministic executable.
No real tenant, appliance or credential is used.
Hosted CI is disabled and the pipeline uses `--skip ci` with the repository's `no_ci: true` declaration.

Run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test` and `pnpm check` against the final implementation commit.
Run the separate mandatory `pnpm test:runner-container` check with the owned disposable offline harness.
Run the real private whole-tree hygiene scan after building, with `ARTIUM_AXI_HYGIENE_DENY_LIST_FILE` naming the external private deny list.
Record command results, final head SHA and deny-list digest in delivery status and the PR body.
Any pipeline source or test fix requires those final-head checks again before delivery.
Scan the exact published head once more before reporting checks green.

The focused command is `pnpm exec vitest run src/server/audit test/integration`.
The audit tests execute real SQLite persistence and reopen, rather than reading implementation source.
Run tests use the production token verifier, policy, shared identity resolver, Falcon credential preparation and runner, substituting only the external executable boundary.

- A persisted start precedes secret retrieval and child execution.
- Every completed or failed admitted run gets a terminal event with the same request ID.
- Upstream nonzero exits remain completed results with the original exit code.
- SQLite's real `max_page_count` failure produces `SQLITE_FULL` and prevents admission, secret retrieval and child creation.
- Terminal-write failure withholds completed output and leaves a start recoverable as interrupted.
- Denials retain only safe identity metadata and stable codes.
- Store startup inserts missing supported tools disabled and preserves existing settings; valid-user and invalid-token denials retain the unconfigured tool name.
- Known-secret output retains only terminal metadata, including observed byte counts.
- Separate flags, equals flags and adapter-identified positional values are redacted before persistence and streaming.
- Repeated or overlapping sensitive separate-form flags still redact the following value, including when the flag itself is hidden.
- Argument count and length are bounded and control characters are escaped.
- Request bodies, stdin, uploaded contents, credentials, tokens and output fields are excluded by the stored record projection.
- Every required event shape persists and streams with identical fields, even when its producer belongs to a later slice.
- Reopening marks unmatched starts interrupted once without replaying a command.
- A fake clock proves the strict 90-day boundary, complete cutoff drainage and a maximum 500-row batch, including repeated maintenance on the same day.
- Each retention batch commits separately; a failed maintenance event rolls back its batch while earlier committed batches remain durable.
- Admin mutation and audit commit together, mutation errors remain intact and failed writes publish no stream event.
- The environment opt-in emits one persisted JSON line on stdout, while default operation emits none.
- A failed optional stream leaves SQLite persistence intact.

See [README.md](../README.md) for current server startup and maintenance integration and [S19 verification](verification-s19.md) for its HTTP checks.
Later producers must use metadata-only event shapes and `audit.change` for transactional database mutations.
Native upstream logs and SQLite cannot share a transaction.
These checks establish Artium audit persistence only, not cross-system atomicity or live platform acceptance.
Export/backup guidance is in README.md, with executable backup and restore assigned to later slices.
