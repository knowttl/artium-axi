# S19 local verification

T1.6 uses real Fastify loopback requests, temporary SQLite stores, one synthetic development identity, canary credentials and the existing fake executable.
No real platform or credential is used.
The development server is intentionally unavailable without `ARTIUM_AXI_DEV=1` and a readable token file.
Production sign-in, remote health scheduling and actual deployed proxy acceptance remain later gates.

Run `pnpm exec vitest run test/integration/api.test.ts` for the focused HTTP checks.

- Both protected endpoints use current tool policy and accept only the static development identity.
- Listing makes no credential retrieval or remote health call and omits unavailable grants.
- A real child preserves streams, observed byte counts, truncation metadata and nonzero exit code in the exact HTTP 200 envelope.
- Shared strict schemas reject caller environment fields, invalid base64, duplicate names, traversal and oversized stdin before credential retrieval.
- Malformed JSON, content type, unsupported tool names and the 16 MiB body bound produce safe error envelopes.
- Admission persists before secret retrieval and child creation, with paired terminal request IDs and the verified socket address.
- Audit failure refuses admission or withholds completed output.
- A synthetic development identity has no administrator capability or admin route access.
- Public liveness and readiness use local storage only, including unavailable-storage readiness.
- Spoofed forwarding headers from untrusted sockets fail before execution.
- A real local proxy replaces a supplied address and the trusted server audits the replacement address.
- Strict startup gates reject every value other than `1`, including a real server-process exit before opening storage.

Run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test` and `pnpm check` on the final implementation commit.
Run the mandatory separate `pnpm test:runner-container` and the real private whole-tree hygiene scan after building.
Run no-mistakes with `--skip ci`, the repository's `no_ci: true` declaration and this fake-only verification plan.
Record final-head results and published-head hygiene evidence in the PR body and delivery status.
Source or test changes made by validation require these checks again before delivery.
