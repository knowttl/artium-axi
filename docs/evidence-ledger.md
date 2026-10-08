# Build and live evidence ledger

Local implementation and pinned-upstream fake-service evidence are independent of captain live acceptance.
Each completed slice records its exact commit, commands, result and evidence path in the relevant cells.
`pending` means the build evidence has not been collected.
`unverified` means no live acceptance is claimed.
All live checks wait until the full build is complete and require approved identities and destinations.
Real captures, credential details and policy records stay in the private evidence store.
Public conversion and release, deployment, real writes and destructive maintenance require separate approval.

The Phase 2 checkpoint validates Falcon and Vectra through the production server entry point and standalone bundled CLI, and Azure through the internal adapter/fake-service harness under its existing runtime deferral.
Azure runtime enablement stays pending until a safe az-axi release that does not retry ambiguous writes is pinned; that commissioning remains a separate captain item.
At baseline commit `6923549337afe136d0e56429c1d628e9328d771e`, frozen install, lint, the full 619-test suite, aggregate check, walking-skeleton, runner-container, fixed-origin fake-services and Compose configuration validation passed.
The walking-skeleton proves encrypted stored credentials reach pinned Falcon and Vectra reads, Vectra previews send zero mutations, one confirmed canary write reaches only the fake service, and the bundled CLI receives `SECRET_IN_OUTPUT` without captured streams.
The full suite covers unsafe overrides before secret retrieval, offline rotation of three stored credentials, all three adapters running afterwards, old-key refusal, maintenance contention and crash recovery.
Post-rotation Falcon and Azure checks prove credential/token injection through real runner children; only Vectra's rotation test executes a pinned upstream fake-service read, as detailed in [S27 verification](verification-s27.md).
The Azure harness proves six pinned token-mode resource reads, subscription passthrough without an Artium allow-list and native preview, allowWrites, scope and confirmation gates; the ambiguous-write probe still records two mutations and does not close runtime enablement.
All checkpoint Docker resources were removed, and no live acceptance is claimed.
The final published head and real private hygiene result are bound to delivery status and the PR body.

S20+S21 implement T1.7 and local T1.8/T0.6 Falcon acceptance: a standalone esbuild CLI, safe HTTPS requests, exact argument and stream/exit transport, and fake-only container-to-CLI comparison.
[S20+S21 verification](verification-s20-21.md) owns the checks, including actual Linux Node 22.12.0 standalone execution and environment-mode canary withholding.
The production Dockerfile now places the Falcon manifest at the compiled import path and includes the CLI artifact.
Final committed-head frozen install, lint, full tests, aggregate check, walking-skeleton, runner-container and private hygiene results are bound to delivery status and the PR body.
Windows/macOS execution and the owner's first live call stay deferred captain evidence.

S17+S18 implement T3.3: durable paired run events, denials, safe record shapes for later producers, argument redaction, interrupted-start recovery, bounded daily 90-day retention and optional stdout streaming.
Their local verification plan is [verification-s17-18.md](verification-s17-18.md).
Focused verification passed 38 tests, covering real SQLite disk-full admission failure, withheld success on terminal-write failure, safe failure metrics, separate/equals/positional redaction, next-call role revocation, real database reopen, stream parity and fake-clock retention.
The audited execution flow replaces preparation-only execution, preserving token and policy regression coverage through the real runner and synthetic executable boundary.
Final committed-head frozen install, lint, full tests, aggregate check, runner-container and private hygiene results are bound to delivery status and the PR body.
AGENTS.md's existing README pointer remains accurate and unchanged under the project-memory correction rule.
S19 implements the development HTTP endpoints, startup recovery and daily maintenance wiring, with real loopback and local proxy checks in [S19 verification](verification-s19.md).
See the T4.1, T4.2 and T4.3 entries below for password-change, offline recovery and local login producers.
See the administrative task row below for current producers; paginated audit queries and executable backup/restore remain assigned to later slices.

S16 implements T3.1 step 4 and T3.2: hashed expiring access-token verification, test-only fixture issuance and current database tool policy before credential retrieval.
Its local verification plan is [verification-s16.md](verification-s16.md).
Focused verification passed 25 cases covering expiry, revoked/consumed tokens, revoked/expired families, restricted token types, disabled user/tool, missing grants, administrator separation and immediate role changes.
Run preparation tests execute the real Falcon adapter and shared identity resolver with a synthetic secret-source boundary, proving denied calls retrieve no secret.
Final committed-head frozen install, lint, full tests, aggregate check, runner-container and private hygiene results are bound to delivery status and the PR body.

S13 implements the encrypted SQLite store and file/environment master-key provider.
Its local verification plan is [verification-s13.md](verification-s13.md).
Focused tests passed 24 cases covering real database reopen, persisted corruption, wrong-row and wrong-key authentication failure, invalid startup keys and transactional migration rollback.
Final committed-head frozen install, lint, full tests, aggregate check, compiled-store smoke, runner-container and real private hygiene results remain pending with the outer executor for delivery status and the PR body.
See [README.md](../README.md) for current store startup integration and [the runbook](runbook.md) for S27 offline rotation.

S14 implements T2.2-T2.3: embedded SecretSource, shared IdentityResolver, a SQLite-free credential-store boundary and the shared adapter contract with Falcon migrated onto it.
Its local verification plan is [verification-s14.md](verification-s14.md).
Focused verification passed 49 cases, including the unchanged T1.5 Falcon suite, fake-store secret and identity tests and real SQLite reopen followed by Falcon preparation and runner canary suppression.
Final committed-head frozen install, lint, full tests, aggregate check, runner-container and private hygiene results are bound to the delivery status and PR body.
See [README.md](../README.md) for the current credential interfaces and supported identity model.

S12 implements plain-function Falcon preparation and its generated parser-aware manifest.
Its local verification plan is [verification-s12.md](verification-s12.md).
The [generated Falcon manifest](../tools/inventories/falcon-axi.json) owns the reviewed command and credential boundary.
Focused review verification executed the HTTPS fixture with trusted synthetic certificates and passed distinct pages at offsets 0 and 1, hydration, canary receipt, token and API redirect responses, zero mutations, and syntax checks for the three changed harness modules.
The production image was absent in the review worktree, so this focused result does not claim pinned-binary cursor or redirect acceptance.
Renewed pinned-binary harness and final-head validation evidence remain pending with the outer executor after this review correction.
The outer executor records final-head results in delivery status and the PR body.

S11 implements the shared run schemas, error catalogue and bounded runner input transport.
Its local verification plan is [verification-s11.md](verification-s11.md).
Final committed-head frozen install, lint, tests, aggregate check, runner-container checks and real private hygiene results are recorded by the delivery status and PR body.
See [README.md](../README.md) for current usage and remaining integration work.

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

S05/06 verification is described in [verification-s05-06.md](verification-s05-06.md).
The image results below describe the prior candidate; final-head validation remains pending with the outer executor, which records the commit, command results and private hygiene result in the delivery status and PR body.
The local image built as `sha256:6ace4e0386cc3457d9b8d1cd5fea18639646960790382f978bd6f8865b597a85` with Node 22.23.3 and Debian Python 3.11.
The build's separate hashed Python installs, Falcon wheel build and no-dependency wheel install ran with BuildKit networking disabled.
`pip check` passed.
All four tool versions matched their pins and `id` reported UID/GID 10001 (`artium`).
The fixed config paths were executed by the version check.
The clean builder and final read-only runtime passed SQLite open/write/reopen, Argon2id correct/wrong password verification and an esbuild TypeScript bundle executed by Node.
The Falcon runtime refused an unknown origin before sending a request, then delivered one canary OAuth request to a trusted loopback TLS fake when explicitly opted in.
The fake's synthetic 401 became `AUTH_FAILED`.
Non-default ports were separately observed to remain refused even with the unknown-origin flag.
The Compose document passed the real Compose parser.
The private BuildKit worker, tmpfs cache, image archive and local image were removed, with filtered container and image inventories empty.

The S09/10 review revision based on `d2b36767402fd32ca6629a28560ced064319f6c5` removes the ineffective Node runtime selector and leaves Docker operation deadlines with the image builder so its finalizer can run.
In the review worktree with these uncommitted fixes, `pnpm install --frozen-lockfile` completed successfully, including the tools install.
`pnpm exec vitest run src/server/runner/runner.test.ts src/server/runner/lifecycle.test.ts test/fake-service-cleanup.test.ts` passed all 58 tests across three files.
Renewed frozen install, full lint/tests/check, runner-container and real private hygiene results remain pending with the outer executor for the final committed candidate.

The S08 runner environment contract is documented in [README.md](../README.md).
Focused verification is described in [verification-s08.md](verification-s08.md).
Final committed-head frozen install, lint, tests, aggregate check and private hygiene results remain pending with the outer executor for the delivery status and PR body.

The review revision adds native profile write-setting inventories with pinned source hashes and retains only the upstream synthetic stream fixtures and fixed `artium-test-node22` harness image.
Focused review verification covers these inventories and synthetic executable behavior.
Route inventories now keep Azure canonical and alias inputs separate, record accepted short flags and Graph positional/help contracts, and distinguish native environment defaults from profile-selected credential variables.
`test/upstream-parser-inventory.test.ts` exercises the pinned routers and synthetic federated assertion files without contacting a service.
Frozen install, full lint/tests/check, private hygiene and revised container evidence remain pending with the outer validation executor for the final candidate.
The Falcon pin retains its repository, tag, full commit and version; Dockerfile alone owns the wheel build and install recipe after removal of unused recipe metadata.
Earlier image results above describe the prior candidate; the outer executor must bind renewed validation and container results to the final published head in the PR body.

| Gate (task IDs) | Local implementation | Pinned-upstream against fake services | Captain live acceptance |
|---|---|---|---|
| Deployment prerequisites and harmless-read requests (T0.1) | This ledger records deferred prerequisites | pending | unverified: supply dedicated identities, Linux host, proxy and certificate |
| Exact tool pins and clean installation (T0.2) | Node pins and integrity in `tools/`; [Falcon source pin](../tools/falcon-source.json), wheel recipe in [Dockerfile](../Dockerfile) and separately hashed build/runtime locks; prior-candidate Python no-network installs and pip check passed in Node 22/Python 3.11 image | Prior-candidate image version/help checks matched the tool pins; final-head results pending | not applicable: local build only, registry publication excluded |
| Falcon region, harmless read and search duration (T0.3) | Global flags, source environment names and region precedence recorded in verification-s05-06.md | Unknown-origin refusal and explicit canary TLS delivery checked by scripts/falcon-smoke.mjs in an isolated image; non-default ports remain refused even with the override | unverified: measure region/read/time before increasing timeouts |
| Vectra API version, token/OAuth and CA (T0.4) | See T2.4 below for current profile and CA preparation | See T2.4 below for pinned fake-service authentication and native-gate evidence | unverified: approve appliance and authentication combination |
| Azure secret/certificate auth and six resource audiences (T0.5) | S24 authentication and S26 reviewed global flags, environment and input manifest; see T2.5 below | [S26 verification](verification-s26.md): pinned six-resource token-mode reads at isolated fixed origins, ARM-only acquisition, vault names/properties and blob metadata only | unverified: both live auth forms, exact successful scopes, real reads and separately approved resource creation/writes |
| Tool output, permission and suggestion captures (T0.6) | Synthetic empty/error/suggestion stream fixtures and generated parser inventories in `test/fake-tool/fixtures/` and `tools/inventories/`; S11 input transport implemented, local checks in [verification-s11.md](verification-s11.md) | Offline pinned CLI version/help/usage checks; az-axi redirects and pagination observed, duplicate uncertain mutation reproduced in Docker; Azure writes unavailable, parser dispositions provisional | unverified: capture safe real outcomes privately |
| Probe reconciliation and design decisions (T0.7) | This ledger separates evidence status | pending | unverified: approve actual design changes |
| Whole-tree hygiene and publication (T1.1) | Synthetic CLI tests and private candidate scan required before delivery | not applicable | unverified: public conversion and release require approval, ordinary private delivery settled |
| Pinned container image (T1.2) | Digest-pinned Node 22 bookworm image, Python 3.11, UID 10001, fixed tool paths and validated Compose example; native build approval pinned in package.json; current API startup requirements in [README.md](../README.md) | Prior-candidate clean builder and read-only non-root runtime execute SQLite open/write/reopen, Argon2id hash/verify and esbuild bundle execution; final-head image results pending with the outer executor | not applicable: local image only, registry push excluded |
| Deterministic fake executable (T1.3) | Executable modes and runner-test descriptor in `test/fake-tool/`; CLI tests in `test/fake-tool.test.ts` | not applicable | not applicable: local build only |
| Process cleanup and container resource limits (T1.4) | S09/10 lifecycle, admission, flood and runtime limits implemented; [README.md](../README.md) owns the runner contract; [verification-s09-10.md](verification-s09-10.md) owns local checks and escaped-session limitation; final-head results pending with the outer executor for delivery status and PR body | Synthetic resource-limit checks in verification-s09-10.md; pinned Falcon runner comparison defined in [S20+S21 verification](verification-s20-21.md), final-head results recorded by the outer executor | unverified: verify production host behaviour and whether pinned tools require escaped-session containment |
| Falcon adapter boundary (T1.5) | Current preparation interfaces documented in [README.md](../README.md); reviewed boundary and resource requirements owned by the [generated manifest](../tools/inventories/falcon-axi.json) | [S12 verification](verification-s12.md) defines pinned-binary pagination, cursor-origin replay and redirect checks; final-head results pending with the outer executor | unverified: verify real adapter behaviour, harmless read and region selection; measure 24-hour search before increasing timeout |
| Server readiness, audit and proxy addresses (T1.6) | S19 development HTTP integration implemented; current usage in [README.md](../README.md); [S19 verification](verification-s19.md) owns real loopback, synthetic executable and local proxy checks | Pinned Falcon HTTP comparison defined in [S20+S21 verification](verification-s20-21.md), final-head results recorded by the outer executor | unverified: verify actual deployed trusted proxy addresses |
| Bundled CLI on supported operating systems (T1.7) | S20 minimal standalone bundle and executable HTTPS/stream/token tests; [verification-s20-21.md](verification-s20-21.md) defines actual Linux Node 22.12.0 smoke | not applicable | unverified: actual Windows and macOS smoke checks |
| First container-to-CLI call (T1.8) | S21 real entry point, encrypted synthetic credential, trusted local HTTPS proxy and environment-mode canary withholding; final-head results bound to delivery status and PR body | Pinned Falcon 0.3.0 fake-service read, pagination and usage-error comparison through the container | unverified: captain runs live first call |
| Credential store, data ownership and master key (T2.1-T2.3) | S13 encrypted store and key provider; S14 embedded secret source, shared identity resolver and adapter contract implemented; [S13 verification](verification-s13.md) and [S14 verification](verification-s14.md) own local checks, including encrypted-store reopen and synthetic runner canary delivery | Phase 2 checkpoint: encrypted stored Falcon credentials run pinned 0.3.0 reads through the real container server and bundled CLI; S14's narrower Node-snippet checks remain separate evidence | unverified: real secrets remain outside the build environment |
| Vectra read, preview, native write policy and logs (T2.4) | S22+S23 schema, private generated profile/CA, reviewed inputs and native write log retention; [verification](verification-s22-23.md) owns acceptance | Pinned 0.1.3 QUX token/OAuth and RUX OAuth against fake HTTPS appliance, native preview/denial, one confirmed tag write, uncertain-result single send and durable log; final-head results recorded in delivery status and PR body | unverified: real appliance/API-version/auth combination, live read, native profile permissions, grants and other write families |
| Azure authentication, resource reads and write families (T2.5) | S24 MSAL authentication, S25 lazy cache and S26 token-mode profile, revision-bound credential reads, inputs and scan set; [S26 verification](verification-s26.md) owns adapter acceptance | Pinned 0.1.4 six-resource reads, subscription passthrough, denial, uploaded/stdin queries and bodies, native opt-in/scope/preview/confirmation gates, one successful fake write and durable log; runtime activation deferred for ambiguous retry; final-head results belong in delivery status and PR body | unverified: [S24 captain checklist](verification-s24.md) for authentication and audiences; all live reads/permissions/write families and safe-pin commissioning remain pending |
| Upstream token and output redaction (T2.6) | S07 scanner and S08 runner integration, extended CLI and audit evidence in [S22+S23 verification](verification-s22-23.md); final-head checks recorded in delivery status and PR body | Vectra raw injected/minted canaries redacted, base64 minted token remains visible; Falcon container probe reports raw minted token visibility | unverified: safe real-output checks and later Graph re-probes, unknown-token claims remain limited |
| Master-key rotation and maintenance (T2.7) | S27 maintenance executable, shared lifetime lock, transactional re-encryption and key-ID receipt with audit; [verification](verification-s27.md) covers real server contention, rollback and post-commit crash recovery; final-head validation belongs in the PR body | Three persisted synthetic credentials run after rotation: pinned Vectra 0.1.3 against fake HTTPS, Falcon environment canary and Azure fake MSAL transport/profile runner checks | unverified: production rotation requires separate approval |
| Identity, role and administrative transactions (T3.1-T3.4) | S15 schema, S16 current policy, S17+S18 durable audit and S19 HTTP wiring; S33 user administration, S34 role/grant/assignment administration and S35 fixed-tool native settings, encrypted credential replacement and manual health tests with recent-auth tickets, optimistic revisions, change metadata and atomic audit; [S33 verification](verification-s33.md), [S34 verification](verification-s34.md) and [S35 verification](verification-s35.md) own local login, denial, rollback, stale-edit, current-policy, cache invalidation and quota checks; audit queries remain pending | Synthetic executables and fake token transport through real adapter preparation, SQLite and runner; real local sign-in and HTTP; role removal immediately denies the next fake call, credential replacement evicts old and pending Azure tokens, and manual tests share administrator/global runner slots; no platform audit acceptance claimed | unverified: real account and credential changes require authorization |
| Local accounts and password hashing capacity (T4.1) | S28 local provider and S30 single-use restricted password change with transactional CLI/browser revocation are implemented; [S28](verification-s28.md) and [S30](verification-s30.md) own local checks; final-head results and local benchmark belong in the PR body | not applicable | unverified: benchmark production host capacity |
| Bootstrap and offline administrator recovery (T4.2) | S29 one-time startup, atomic marker, inconsistent-state refusal, transactional last-admin guards and audited existing-account recovery; [verification](verification-s29.md) owns real startup, rollback and copied-store executable checks; final-head validation belongs in the PR body | not applicable | unverified: real recovery and administrator reset require authorization |
| CLI tokens and session families (T4.3) | S30 local login, distinct hashed token types, restricted token denial and session revocation; S31 atomic refresh consumption, fixed family deadline, preserved older access expiry, audited reuse revocation and logout after expiry; [S30 verification](verification-s30.md) and [S31 verification](verification-s31.md) own local checks | Real local sign-in through Fastify, fake upstream tools and the container walking skeleton; final-head results belong in the PR body | unverified: production session acceptance |
| Login limits, lockout and proxy verification (T4.4) | S32 shared canonical-username/address limits, capped expiring counters and audited 15-minute account lockout; [verification](verification-s32.md) covers API failures, expiry, successful reset and audit rollback | not applicable | unverified: production limits and proxy acceptance |
| Secure CLI storage and cross-process refresh (T4.5) | S36+S37 bundled login/passwd/whoami/logout, URL-bound atomic session storage, POSIX modes, injected Windows path/ACL failure checks, six simultaneous Linux processes sharing one refresh rotation and single safe retry; persisted login generations prevent tool and password-change identity replacement; leading-dash and option-name usernames are accepted; [verification](verification-s36-37.md) owns the local checks; final committed-head results are bound to delivery status and the PR body | Container journey uses the real bundle for restricted first login, password change, new login and identity before pinned fake-service tool calls; no live credentials used | unverified: actual Windows ACLs, cross-process locking and clean Windows/macOS installation remain captain checks |
| Browser sessions over TLS and proxy (T4.6) | S38 server-side sessions, opaque secure cookies, same-origin CSRF-protected sign-in/sign-out/password/reauth forms and cookie-authenticated admin mutations; [verification](verification-s38.md) covers forced change, 10-minute restricted expiry, 30-minute idle/12-hour absolute expiry, 15-minute admin challenge, current capability, revocation and escaped HTML; S32 bearer tickets remain supported | Real named Chrome session through a local TLS proxy with synthetic users and fake time; no platform calls | unverified: production URL, cookies and proxy path |
| Administration Users screen (T5.1) | S39 escaped server-rendered layout, paginated accounts, complete role choices, create/disable/enable/unlock/reset/assign forms using the existing API, CSRF, recent-auth redirects, revision conflicts and change actor/time; [verification](verification-s39.md) owns local evidence | Named Chrome session against the real local TLS fixture, synthetic users and canary passwords; no platform calls | unverified: owner acceptance and production browser deployment |
| Administration Tools and Credentials screens (T5.2) | S40 pinned versions, enable/disable, cached health, validated native settings editor, blank complete-replacement credential editor and harmless Test button with pass/fail, cached status/time/error refresh and existing quota; change actor/time/revision, CSRF, recent-auth and confirmation reuse; [verification](verification-s40.md) owns evidence | Real named Chrome session through local TLS, real adapter preparation and runner with fake executables, successful and failing Falcon/Vectra canaries; rendered-page integration tests exclude stored secrets; Azure runtime stays disabled | unverified: live credential test and owner acceptance, real changes require approval |
| Administration Roles screen (T5.3) | S40 bounded role pagination, create/rename and fixed-registry grant replacement, escaped names, change actor/time/revision and existing mutation gates; [verification](verification-s40.md) owns evidence | Real named Chrome session creates/renames/grants and assigns a synthetic role through the page; removing it denies the next run with the same token (403 TOOL_NOT_GRANTED); existing API tests prove both assignment and grant removal audit the change and denial | unverified: owner acceptance and real role changes require approval |
| Administration Audit screen (T5.4) | pending | pending | unverified: owner acceptance, real changes require approval |
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
