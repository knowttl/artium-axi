# S25 local verification

S25 implements T2.5 steps 3 and 4 only.
[azure-token-cache.ts](../src/server/adapters/azure-token-cache.ts) owns resource selection and the in-memory cache.
The caller supplies a manifest command and parsed canonical flags, then a credential ID, revision and validated identity.
The generated pinned inventory records resource requirements and hashes the reviewed secondary-call sources.
Azure Resource Graph uses ARM, analytics queries use Logs, and metadata commands use their own Storage, Vault or Registry audience.
Dynamic API calls use their parsed ARM, Logs or Graph resource.
RBAC name lookup requires Graph for a non-GUID principal, while best-effort display-name resolution remains optional.
Unknown routes and Azure CLI passthrough report an adapter gap before token minting.
No Azure adapter is enabled by this slice.

Cache keys include credential ID, revision, tenant, client ID and resource.
Concurrent callers share the same pending mint, and tokens refresh below five minutes remaining.
Each acquisition has a ten-second deadline covering MSAL discovery, token requests and at most three attempts, with 250 ms and 500 ms backoff.
The production network transport receives an abort signal for the whole acquisition.
Errors remain safe `CREDENTIAL_UNAVAILABLE` catalogue errors.
`replace(id, newRevision)` evicts every resource entry for the old revision.
Acquiring a newer revision also performs this eviction, and stale callers and late completions cannot return or repopulate old tokens.
The future credential-replacement producer must call `replace` when it commits replacement.
Tokens and assertions remain in memory and are returned for scanning.

The fake-clock tests execute MSAL through the fake token transport.
They cover concurrent lifetime reuse, ARM-only acquisition, canonical and alias resources, RBAC secondary calls and optional failure, dynamic API resources, local calls, adapter gaps, refresh boundaries, credential identity separation, replacement eviction and the pending replacement race.
Failure checks cover deadline abort, a late result after timeout, coalesced bounded retries and recovery after failure.

Verification is local and fake-only.
Run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test` and `pnpm check` on the final implementation commit.
Run the mandatory `pnpm test:walking-skeleton` and `pnpm test:runner-container` container checks.
Run the real private hygiene scan on that committed and built candidate using the outside-checkout deny list, and repeat it on the exact published head.
Quote the commit, command results and per-step pipeline timings in the PR body and delivery status.
Any pipeline fix that changes source or tests requires renewed frozen install, lint, test, check and private hygiene validation before delivery.
AGENTS.md's existing package, README and validation pointers remain accurate and were reviewed without adding project memory.

Profile preparation, argument validation and pinned Azure command execution remain S26.
Live secret/certificate authentication, audience trailing-slash acceptance, real resource reads and native permissions remain unverified captain checks.
The fake transport cannot close those gates.
