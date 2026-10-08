# S15 verification

All accounts, hashes, credentials and tools in these checks are synthetic.
Verification is local and fake-only, with no hosted CI or live acceptance.

1. Run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test` and `pnpm check` against the final implementation commit.
   The authentication schema tests exercise `openStore` with a real empty SQLite database, persist identity relationships and reopen it.
   The prior-store test applies only migration 001, stores an encrypted canary and tool settings, then opens it with the current migrations and proves both rows are unchanged and the credential still decrypts.
   Tests reject duplicate canonical usernames, invalid foreign keys, mismatched token/browser family owners, unsupported sources/token types and invalid revisions.
   Administrator capability is independent of tool grants.
2. Run `pnpm test:runner-container` for the mandatory local Linux checks.
3. Run the real private hygiene checker after compilation and commit, using `ARTIUM_AXI_HYGIENE_DENY_LIST_FILE` set to the external private list.
   Record the candidate SHA, result and list digest without printing or copying list contents.
   Repeat once against the exact published head.

Start no-mistakes with `--skip ci --verification-plan docs/verification-s15.md`.
Rerun frozen install, lint, tests, aggregate checks and hygiene after any pipeline source or test fix.
The PR body records results against the final implementation head.
See [S16 verification](verification-s16.md) for token verification and the test fixture issuer.
Login, refresh, browser authentication, bootstrap execution, audit writing and administrator safeguards belong to later slices.
