# S52 repeated local acceptance (T8.2 and local T0.7)

All four adapters have repeated local evidence using fakes, synthetic identities and canary credentials.
The [evidence ledger](evidence-ledger.md) records local status separately from captain live acceptance.
No approved design decision, adapter pin or runtime activation policy changed.
No application account was requested, live probe reconciled, production deployment started or captain-run live checklist executed.
Live Graph consent remains unverified.

## Candidate and commands

The checks ran on 2026-10-09 against clean `origin/main` commit `732316b739c78e56529953cf4d8a9c856220db19`, containing the merged Graph adapter.
S52 adds only documentation on top of that tested implementation.
The environment was Linux x64, host Node `v24.17.0`, pnpm `10.22.0` and Docker `29.8.1`.
The clean bundle client actually executed with Node `v22.12.0`; the fake-service image used Node `v22.23.3`.

| Command | Exit | Elapsed | Result |
|---|---|---|---|
| `CI=true pnpm install --frozen-lockfile` | 0 | 1.3 s | Root and tools frozen installs; existing native build approvals retained |
| `pnpm check` | 0 | 103.09 s | Error-reference freshness, strict types, 52 files / 1,888 tests, build and AXI/distribution checklist |
| `docker compose -f compose.example.yaml config --quiet` | 0 | 0.07 s | Actual Compose parser accepted the example |
| `pnpm test:containers` | 0 | 148.85 s wall; 148,496 ms harness | All probes passed; `passed: true`, `cacheRemoved: true` |

Vitest completed in 78.08 seconds.
The full suite includes adapter preparation, authentication and current-role denials, trusted heap behavior, streaming secret rejection, session and CSRF boundaries, key rotation, maintenance contention, backup failure cases, migration rehearsal and rollback.
The local hardening regression does not establish completion of a separate full-code security review; the approved [S48 substitution](verification-s48.md) remains unchanged.

## Adapter evidence and limits

| Adapter / pin | Repeated local evidence | Limit retained |
|---|---|---|
| Falcon `0.3.0` | Encrypted stored credential through production server and bundle; read, pagination, empty/error/help parity; cursor-origin replay and token/API redirect refusal; unsafe overrides refused before secrets | Synthetic minted raw token remains visible in the pinned upstream display-field probe; unknown-token redaction and live region/read acceptance are not proven |
| Vectra `0.1.3` | Stored profile through production server and bundle; fake token/OAuth and API-version cases; preview sends zero mutations; confirmed canary write and durable 0600 intent/outcome log; stream/exit parity | Existing encoded minted-token visibility limitation and live appliance/authentication acceptance remain open |
| Azure `0.1.4` | Internal adapter with fake MSAL and pinned token-mode client; six resource audiences, metadata-only listings, subscription passthrough, uploaded/stdin queries and bodies, permission/scope/confirmation/allowWrites gates and durable logs | Production runtime stays disabled; the ambiguous-write upstream probe still records two mutation requests after a synthetic uncertain response |
| Graph `0.1.4` | Fake MSAL secret/key headless acquisition; real runner and pinned native session/mutation coordinator; read, role/override denial before credential access, preview, confirmation/allowWrites/operation gates, one confirmed fake send, journal, paired audit and encoded canary refusal; production image version is `0.1.4` | External transport and credential acquisition are fake boundaries; real signing/authentication, application permissions, consent and minted-token redaction remain unverified |

Falcon and Vectra run through the production server and downloaded standalone client.
Azure and Graph ran through their existing internal adapter harnesses in this slice; these historical checks do not claim production activation or a clean-client first call for those then-deferred adapters.
See [README](../README.md) for current runtime availability and [Azure safe-pin verification](verification-azure-safe-pin.md) for subsequent Azure evidence.
The Graph adapter probe uses the non-root read-only, no-network container and bounded resources described in [S51 verification](verification-s51.md).

## Clean image, hardening and restore

The clean Node-only Linux client downloaded the CLI over local trusted HTTPS, verified the served SHA-256, installed the executable without sibling assets or `node_modules`, exercised all supported setup-host installers in synthetic homes, changed its temporary password and made its first pinned fake Falcon call.
The downloaded bundle digest was `f917e92cef7efbfcca3e505b3c7d0e14e67f958e43523db184e057de8ce283aa`.
This is Linux installer evidence, not actual Windows/macOS execution or host agent loading.
The canary journey separately withheld both captured streams with `SECRET_IN_OUTPUT`.

The runner container repeated byte and inode exhaustion in a 256 MiB tmpfs, cleanup and successful next-call execution, and resident-memory OOM termination with leader reaping at a synthetic 256 MiB cgroup bound.
Fake-service networks were internal, had no default IPv4 route and denied the synthetic outside TCP destination.
Application probes contacted only fake endpoints; pinned image dependency fetches were build inputs.

The non-root production-image rehearsal made an online SQLite backup, revoked its access token afterwards and restored into a separate empty volume using the same synthetic key.
The restored store retained encrypted credentials, role grants and audit, issued and accepted a fresh session through the token API and refused the old access token.
The full suite additionally repeated copied-store migration and pre-upgrade rollback; actual deployment image selection, recovery ownership and key escrow remain captain decisions under [S47 verification](verification-s47.md).

## Container evidence and cleanup

The emitted `container-inputs` and `container-evidence` records identify checked head `732316b739c78e56529953cf4d8a9c856220db19`, input digest `a4237ae1f07f03aa5e63c77b0ed1aad45bbddf8bdf60fe3a65cc183b5e435bb5` and compiled-output digest `0d61cdeba6223b136cf7a61a5a31658ddfbe18e8ed089bbb3f54def28a202f54`.
The [build-input contract](../scripts/build-inputs.mjs) excludes `README.md`, `docs/` and `.build-evidence.json` from these digests.
Delivery must confirm both digests still match the final documentation-only candidate; a relevant source, test, toolchain or image-input change requires renewed checks.

| Image purpose | Image ID | Build elapsed |
|---|---|---|
| Runner resource probe | `sha256:a252393e1af2abfab7d41cbe81803abaae168ba4f5ca093e5b67ae1c1dfc5ce6` | 11,859 ms |
| Production walking skeleton and restore | `sha256:eb6e3c3459bf3243c9a7c7bcb81a98ef7d7fbe9b3c71cc019ba6e00bd468203c` | 51,107 ms initial; 2,608 ms later same-worker build |
| Clean Node 22.12 client | `sha256:1d0274fb8467281ab377b40e1e5442ab8ab69a665ce7b5f85649a925ad5d46ad` | 2,540 ms |
| Fake services and Graph probe | `sha256:5b34a45edccbef2f6b5da60598b81702819e9ae16241ce3f60bb192194e660db` | 1,327 ms |

All emitted subcommands exited 0.
The runner probe took 16,215 ms, walking skeleton 91,794 ms, Graph headless/adapter block 10,568 ms, Azure/fake services 8,191 ms and Falcon fake services 6,198 ms.
The production backup and restore probes took 494 ms and 509 ms respectively.
The private BuildKit worker was `artium-test-build-6c8a3ddb-3fb3-490f-8e2f-43da53fe22e6`, with task-owned tmpfs cache.
The finalizers removed its cache and all task-owned images, containers, networks, volumes, archives, certificates and call directories.
No development stack was created.

The final committed-head private deny-list scan and no-mistakes publication record belong in delivery status and the PR body, without exposing the list.
T0.7 is complete only for this local evidence-status update; live probe reconciliation, design changes, production deployment and the captain-run checklist remain outside S52.
