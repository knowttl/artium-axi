# S13 verification

All credential values are synthetic canaries.
These checks use local SQLite files and fake services only.
No live acceptance is claimed and no hosted CI exists.

1. Run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test` and `pnpm check` on the final implementation commit.
   Store tests prove AES-GCM round trip, fresh nonces, ciphertext/tag/nonce corruption, row and schema binding, wrong-key refusal, raw-file and base64 key loading, safe startup failures and real SQLite reopen.
   Failed migrations roll back schema and version records, and successful migrations are idempotent.
2. Run `pnpm test:runner-container` for the mandatory local Linux resource checks.
3. Verify the compiled store opens and reopens a disposable database with a synthetic 32-byte key.
   This proves numbered SQL migrations are present in the built layout and the native SQLite module executes.
4. Run `ARTIUM_AXI_HYGIENE_DENY_LIST_FILE=/external/private/deny-list.txt pnpm hygiene:check` using the actual private list path without printing it.
   Record the exact implementation head, result and list digest in delivery evidence.
   Repeat on the exact published head after no-mistakes delivery.

Run no-mistakes with `--skip ci --verification-plan docs/verification-s13.md` after the committed implementation handoff.
Rerun frozen install, lint, tests, aggregate checks and private hygiene after pipeline source or test fixes.
The pipeline PR body must record the command results against the final candidate.
Live credentials, connected services, deployment and destructive maintenance remain deferred.
