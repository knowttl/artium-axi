# Build and live evidence ledger

Local implementation and pinned-upstream fake-service evidence are independent of captain live acceptance.
Each completed slice records its exact commit, commands, result and evidence path in the relevant cells.
`pending` means the build evidence has not been collected.
`unverified` means no live acceptance is claimed.
All live checks wait until the full build is complete and require approved identities and destinations.
Real captures, credential details and policy records stay in the private evidence store.
Public conversion and release, deployment, real writes and destructive maintenance require separate approval.

S03/04 implementation is recorded at commit `6e2b22e5ba8edc3b72c0c6f8c918fd552f772d13`.
Its verification plan is [verification-s03-04.md](verification-s03-04.md).
The final delivery head and results of frozen install, lint, tests, aggregate check and the private hygiene scan are bound together in the delivery status and PR body.
The private deny-list SHA-256 is `bddd1b07500f81245fc34634459368648db992b7127d66ff94330849eda45ad2`.
`pnpm test:build-image` built the slice-owned image from the official Node 22 base index digest `sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392`.
The image ran Node `v22.23.3` and had image ID `sha256:5b34a45edccbef2f6b5da60598b81702819e9ae16241ce3f60bb192194e660db`.
`pnpm test:fake-services` passed with trusted test TLS, eight fixed/synthetic DNS aliases and denied TCP access to a second synthetic internal network.
The client had no default IPv4 route and both networks were inspected as internal.
The pinned az-axi client followed a same-origin redirect, a cross-origin redirect without forwarding the bearer token, and a two-page response.
It sent exactly two PATCH requests after the fake service recorded each mutation then returned 503 with Retry-After.
The test builder, its private tmpfs cache, exported archive, test image, service/client containers, internal networks and temporary certificates were removed.
Filtered Docker container, network and image inventories showed no remaining slice resources.
Loopback TLS and pinned Vectra gate tests also run in the mandatory local suite.
Azure write capability remains unavailable pending executable commissioning of a safe pin.

The review revision adds native profile write-setting inventories with pinned source hashes and retains only the upstream synthetic stream fixtures and fixed `artium-test-node22` harness image.
Focused review verification covers these inventories and synthetic executable behavior.
Route inventories now keep Azure canonical and alias inputs separate, record accepted short flags and Graph positional/help contracts, and distinguish native environment defaults from profile-selected credential variables.
`test/upstream-parser-inventory.test.ts` exercises the pinned routers and synthetic federated assertion files without contacting a service.
Frozen install, full lint/tests/check, private hygiene and revised container evidence remain pending with the outer validation executor for the final candidate.

| Gate (task IDs) | Local implementation | Pinned-upstream against fake services | Captain live acceptance |
|---|---|---|---|
| Deployment prerequisites and harmless-read requests (T0.1) | This ledger records deferred prerequisites | pending | unverified: supply dedicated identities, Linux host, proxy and certificate |
| Exact tool pins and clean installation (T0.2) | Exact Node pins, npm SHA-512 records and frozen tools lockfile in `tools/`; clean production installation and Falcon packaging pending next slice | Local version/help/parser checks for az-axi 0.1.4, vectra-axi 0.1.3 and mg-axi 0.1.4; az-axi client executed under Node 22.23.3 in isolated Docker services | not applicable: local build only, registry publication excluded |
| Falcon region, harmless read and search duration (T0.3) | pending | pending | unverified: measure region/read/time before increasing timeouts |
| Vectra API version, token/OAuth and CA (T0.4) | Ephemeral CA and QUX v2.5 token-profile loopback fixtures, isolated TLS/DNS harness | Pinned 0.1.3 native default write refusal, preview, confirmed mutation and single-send ambiguous 503 checked by `test/fake-service.test.ts`; isolated DNS/TLS/outbound checks passed; OAuth/RUX unverified | unverified: approve appliance and authentication combination |
| Azure secret/certificate auth and six resource audiences (T0.5) | pending | pending | unverified: supply permitted resources, separately approve test resource creation and writes |
| Tool output, permission and suggestion captures (T0.6) | Synthetic empty/error/suggestion stream fixtures and generated parser inventories in `test/fake-tool/fixtures/` and `tools/inventories/` | Offline pinned CLI version/help/usage checks; az-axi redirects and pagination observed, duplicate uncertain mutation reproduced in Docker; Azure writes unavailable, parser dispositions provisional | unverified: capture safe real outcomes privately |
| Probe reconciliation and design decisions (T0.7) | This ledger separates evidence status | pending | unverified: approve actual design changes |
| Whole-tree hygiene and publication (T1.1) | Synthetic CLI tests and private candidate scan required before delivery | not applicable | unverified: public conversion and release require approval, ordinary private delivery settled |
| Pinned container image (T1.2) | pending | pending | not applicable: local image only, registry push excluded |
| Deterministic fake executable (T1.3) | Executable modes and runner-test descriptor in `test/fake-tool/`; CLI tests in `test/fake-tool.test.ts` | not applicable | not applicable: local build only |
| Process cleanup and container resource limits (T1.4) | pending | pending | unverified: verify production host behaviour |
| Falcon adapter boundary (T1.5) | pending | pending | unverified: verify real adapter behaviour |
| Server readiness, audit and proxy addresses (T1.6) | pending | pending | unverified: verify actual trusted proxy addresses |
| Bundled CLI on supported operating systems (T1.7) | pending | not applicable | unverified: actual Windows and macOS smoke checks |
| First container-to-CLI call (T1.8) | pending | pending | unverified: captain runs live first call |
| Credential store, data ownership and master key (T2.1-T2.3) | pending | pending | unverified: real secrets remain outside the build environment |
| Vectra read, preview, native write policy and logs (T2.4) | pending | pending | unverified: verify live read and native profile permissions |
| Azure authentication, resource reads and write families (T2.5) | pending | pending | unverified: both auth forms and every enabled resource/write family |
| Upstream token and output redaction (T2.6) | pending | pending | unverified: safe real-output checks, unknown-token claims remain limited |
| Master-key rotation and maintenance (T2.7) | pending | pending | unverified: production rotation requires separate approval |
| Identity, role and administrative transactions (T3.1-T3.4) | pending | pending | unverified: real account and credential changes require authorization |
| Password hashing capacity (T4.1) | pending | not applicable | unverified: benchmark production host capacity |
| Bootstrap, recovery, sessions and proxy verification (T4.2-T4.4) | pending | not applicable | unverified: real recovery and administrator reset require authorization |
| Secure CLI storage and cross-process refresh (T4.5) | pending | not applicable | unverified: actual Windows ACLs and clean installation |
| Browser sessions over TLS and proxy (T4.6) | pending | not applicable | unverified: production URL, cookies and proxy path |
| Administration browser flows and credential testing (T5.1-T5.4) | pending | pending | unverified: live credential test and owner acceptance, real changes require approval |
| CLI flows and captured output formats (T6.1-T6.5) | pending | pending | unverified: live output parity and unsupported capture formats |
| Supported agent skill and hook installation (T6.6) | pending | not applicable | unverified: real hook installation is opt-in and preserves settings |
| Human-only AXI principles (T6.7) | pending | not applicable | unverified: captain reviews principles beyond automated checks |
| Host proxy, firewall, egress and endpoint inventory (T7.1) | pending | pending | unverified: authorize and verify production network changes |
| Backup, restore, rollback and key escrow (T7.2) | pending | not applicable | unverified: choose escrow and backup owner, separately approve real restore/key upload |
| Security review and live findings (T7.3) | pending | pending | unverified: close host and tenant findings before release |
| Embedded-store policy exception (T7.4) | pending: private checklist only | not applicable | unverified: determine applicability and obtain required approval, draft insufficient |
| Runbook on actual hosts and clean clients (T7.5) | pending | pending | unverified: exercise actual host and client instructions |
| Deployment and new user's first call (T7.6) | pending | pending | unverified: explicit deployment approval and live acceptance |
| Graph application grants and headless authentication (T8.1) | pending | pending | unverified: approved application permissions and both real auth forms |
| Graph adapter and repeated release gates (T8.2) | pending | pending | unverified: separate Graph live and release acceptance, no inherited approval |

The final live checklist must also verify metadata-only vault/storage commands, deployed forwarding-header spoof protection and egress, native permission denials and previews, separately approved single sandbox writes with native logs and user audit, clean-client download digests and refresh locks, restored-session revocation and rollback.
Record timestamps, exact image and CLI digests, upstream pins and safe evidence paths privately.
Keep production adapters disabled or unconfigured until their required live gates pass.
