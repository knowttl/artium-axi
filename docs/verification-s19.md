# S19 local verification

T1.6 uses real Fastify loopback requests, temporary SQLite stores, synthetic local identities, canary credentials and the existing fake executable.
No real platform or credential is used.
See [README.md](../README.md) for current server startup and authentication settings and [S30 verification](verification-s30.md) for local sign-in checks.
Remote health scheduling and actual deployed proxy acceptance remain later gates.

Run `pnpm exec vitest run test/integration/api.test.ts` for the focused HTTP checks.

- Both protected endpoints use current tool policy with ordinary access tokens obtained through local sign-in.
- Listing makes no credential retrieval or remote health call and omits unavailable grants.
- A real child preserves streams, observed byte counts, truncation metadata and nonzero exit code in the exact HTTP 200 envelope.
- Shared strict schemas reject caller environment fields, invalid base64, duplicate names, traversal and oversized stdin before credential retrieval.
- Malformed JSON, content type, unsupported tool names and the 16 MiB body bound produce safe error envelopes.
- Admission persists before secret retrieval and child creation, with paired terminal request IDs and the verified socket address.
- Audit failure refuses admission or withholds completed output.
- Administrator capability does not bypass tool grants; admin routes remain unimplemented.
- Public liveness and readiness use local storage only, including unavailable-storage readiness.
- Spoofed forwarding headers from untrusted sockets fail before execution.
- A real local proxy replaces a supplied address and the trusted server audits the replacement address.
- Unsupported development authentication settings cause a real server-process exit before opening storage.

Run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test` and `pnpm check` on the final implementation commit.
Run the mandatory separate `pnpm test:runner-container` and the real private whole-tree hygiene scan after building.
Run no-mistakes with `--skip ci`, the repository's `no_ci: true` declaration and this fake-only verification plan.
Record final-head results and published-head hygiene evidence in the PR body and delivery status.
Source or test changes made by validation require these checks again before delivery.
