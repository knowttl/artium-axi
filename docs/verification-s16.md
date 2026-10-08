# S16 verification

Scope: T3.1 step 4 and T3.2, production hashed access-token verification and current tool policy before secret retrieval.
All verification is local, fake-only and uses synthetic identities and canary credentials.
No live service, deployment, real credential or account change is authorized.

1. Execute token unit tests against migrated SQLite databases.
   Verify SHA-256-only storage, one-hour access expiry, fixed 12-hour family deadline, token/family revocation, consumption and rejection of refresh/password-change tokens.
   Verify fixture issuance refuses non-test environments without writing rows.
2. Execute policy unit tests against current database state.
   Verify disabled user, disabled tool, absent grant and removed assignment produce distinct denials.
   Verify reserved administrator capability does not bypass tool grants and role removal/restoration applies on the next call.
3. Follow [S17+S18 verification](verification-s17-18.md) for the audited execution tests that replace the former run-preparation suite.
4. After committing the final candidate, run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test`, `pnpm check` and `pnpm test:runner-container`.
   Run `pnpm hygiene:check` with the private external deny-list path in `ARTIUM_AXI_HYGIENE_DENY_LIST_FILE`, without printing its contents.
   Bind results to the implementation commit and published PR head.
5. Drive no-mistakes with local verification and CI skipped under the trusted repository `no_ci: true` declaration.
   Revalidate source/test changes from any pipeline fix round, then scan the exact published head again.

See [README.md](../README.md) for current development HTTP usage and [S19 verification](verification-s19.md) for its checks; [S17+S18 verification](verification-s17-18.md) owns durable run audit checks.
No live acceptance is claimed.
