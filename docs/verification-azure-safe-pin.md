# Azure safe-pin verification

The published `@knowttl/az-axi` 0.1.6 artifact replaces 0.1.4 and enables Azure in the production server and CLI discovery.
The npm registry supplies the SHA-512 integrity recorded in `tools/integrity.json` and the tools lockfile.
Vectra and Graph pins remain unchanged.

## Verification plan

1. Run `pnpm check` for type-checking, the local suite, build and AXI checks.
2. Run `pnpm test:containers` against synthetic identities, canary credentials and isolated fake services.
3. Confirm the production entry point advertises enabled Azure through `/v1/tools`.
4. Confirm `/v1/tools/az-axi/run` executes a pinned subscription read against the fake service.
5. Make the fake service apply a PATCH and return a gateway timeout with `Retry-After: 0`.
   Confirm exactly one PATCH and one mutation, upstream exit code 1, and caller-visible `UNKNOWN_OUTCOME` with state-check guidance.
   The public-interface [Azure integration tests](../test/integration/azure.test.ts) also hold API and native write responses past the runner deadline, check a single mutation, and retain `TIMEOUT` for reads.
   They execute emitted recovery reads and assert visible tag, alert, comment, incident and network-rule state, including all updated incident fields and supported selectors.
   API runner-timeout and native ambiguous gateway-timeout or connection-loss cases verify complete values longer than 4,000 characters; native cases follow every emitted recovery read in JSON and TOON help.
6. Confirm the existing six-resource reads and native write preview, opt-in, scope, confirmation and durable-log checks still pass.
7. After committing, run `pnpm hygiene:check` with the private external deny list supplied through `ARTIUM_AXI_HYGIENE_DENY_LIST_FILE`.
   Record its hash and result in delivery evidence without exposing its terms or path.

## Container evidence

The initial candidate's recorded `pnpm check` passed: 53 test files and 1,923 tests, type-checking, build and all scripted AXI checks.
These counts and the container evidence below predate the subsequent runner and recovery fixes; final-head validation belongs in delivery status and the PR body.

`pnpm test:containers` passed with exit status 0 in 165,512 ms on Linux x64, host Node v24.17.0 and Docker 29.8.1.
The checks exercised Node v22.23.3 and the clean bundled CLI on Node v22.12.0.
The candidate was built above baseline `fb2e08b7965ca187e15b89495414c966d7b1c626` before the implementation commit.
Its input digest was `58ccc36c4950823dfff3ecfb7e3c83bfd0ae27e8e42e0ffcf5c6700ec250a121` and compiled-output digest was `bd18cf6f0982458f4f93e3388c952745e3545da170e98ec0f402ac94be7a3e88`.
These digests bind the tested source and compiled output; reuse requires matching relevant digests on the delivered candidate.

| Image | SHA-256 |
| --- | --- |
| Runner | `5c6869ffe54eca5312e01eba6bcbb393340d4762552a0316f6f9fe35e4c68b1d` |
| Production server and Falcon probe | `7a18a1326214230f7cf2874566590ca436e0f91f2cb6aa0ebe31faec31819c1a` |
| Clean Node 22.12 client | `1d0274fb8467281ab377b40e1e5442ab8ab69a665ce7b5f85649a925ad5d46ad` |
| Fake-service client | `5b34a45edccbef2f6b5da60598b81702819e9ae16241ce3f60bb192194e660db` |

The container result reported `passed: true` and `cacheRemoved: true` after task-owned resource cleanup.
No live Azure authentication, permissions, tenants or writes were tested.
The private hygiene check remains pending until the external deny-list configuration is supplied.
