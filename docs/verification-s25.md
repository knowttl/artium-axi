# S25 local verification

S25 implements T2.5 steps 3 and 4 only.
[azure-token-cache.ts](../src/server/adapters/azure-token-cache.ts) owns resource selection and the in-memory cache.
The caller supplies a manifest command and parsed canonical flags, then a credential ID, revision and validated identity.
The [generated pinned inventory](../tools/inventories/az-axi.json) owns route resource requirements and hashes the reviewed secondary-call sources.
`azureCommandResources` in [azure-token-cache.ts](../src/server/adapters/azure-token-cache.ts) owns conditional selection for help, query display, dynamic API resources and required versus optional secondary calls.
Unknown routes, local configuration/setup and Azure CLI passthrough report an adapter gap as `FLAG_BLOCKED` before token minting.
No Azure adapter is enabled by this slice.

Cache keys include credential ID, revision, tenant, client ID and resource.
Concurrent callers share the same pending mint, and tokens refresh below five minutes remaining.
Each acquisition has a ten-second deadline covering MSAL discovery, token requests and at most three attempts, with 250 ms and 500 ms backoff.
The production network transport receives an abort signal for the whole acquisition.
See the [error reference](errors.md) for acquisition failure categories; optional resource failures omit that resource from the result.
`replace(id, newRevision)` evicts every resource entry for the old revision when the revision increases; equal or older revisions do not change the cache.
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

See [S26 verification](verification-s26.md) for implemented profile preparation, argument validation and local pinned Azure command checks, and [README](../README.md) for current runtime availability.
Live secret/certificate authentication, audience trailing-slash acceptance, real resource reads and native permissions remain unverified captain checks.
The fake transport cannot close those gates.
