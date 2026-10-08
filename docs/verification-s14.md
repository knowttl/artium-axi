# S14 verification

All checks use local SQLite, synthetic identities, canary credentials and fake services.
No live acceptance is claimed and no hosted CI exists.

1. Run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test` and `pnpm check` on the final implementation commit.
   Fake-store unit tests cover embedded retrieval, missing references, tool binding and shared identity selection for different users.
   The unchanged T1.5 Falcon tests cover the existing parser-aware boundary and file-backed compatibility interface.
   The encrypted-store integration test persists an encrypted JSON credential, reopens SQLite, resolves the identity, prepares Falcon, delivers canaries through the real runner and suppresses a leaked canary.
   Tests also cover malformed stored JSON, invalid Falcon fields, wrong-tool identity and blocked arguments before retrieval.
2. Run `pnpm test:runner-container` for the mandatory local Linux resource checks.
3. Run `ARTIUM_AXI_HYGIENE_DENY_LIST_FILE=/external/private/deny-list.txt pnpm hygiene:check` with the real private list outside the checkout, without printing it.
   Bind results and list digest to the exact candidate commit in delivery evidence and the PR body.
   Repeat the scan on the exact published head.

After the committed implementation handoff, run no-mistakes with `--skip ci --verification-plan docs/verification-s14.md`.
Rerun frozen install, lint, tests, aggregate check and private hygiene after pipeline source or test fixes.
Record final-head results in the PR body.
Real credentials, connected services, deployment and destructive maintenance remain deferred.
