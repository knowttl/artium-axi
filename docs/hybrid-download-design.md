# Hosted Hybrid Analysis downloads

Status: transfer contracts, owner/session scope checks and typed audit metadata are implemented; artifact storage, delivery and final enablement remain pending.
See the [Hybrid Analysis capability boundary](../README.md#safety) for current availability.
This design specifies a hosted path for sample archives, dropped-file archives and process-memory dumps without turning Artium into a malware analysis service.

## Evidence and boundaries

Reviewed Artium `origin/main` at `124958d266cdbf383b5397ced2c9a270dd06a051` and hybrid-axi `origin/main` at `be4ec9b050c3f7576319afeda2f463ea2696fbd2`.
Artium's current documentation lives in `docs/`; earlier internal design records are on `archive/internal-docs`, as described by [CONTRIBUTING.md](../CONTRIBUTING.md#historical-verification-records).

- [src/server/runner/run.ts](../src/server/runner/run.ts) authenticates, checks tool policy, prepares managed credentials and journals, runs the child and records outcomes.
- [src/server/runner/runner.ts](../src/server/runner/runner.ts) owns private per-call directories, process termination, admission and cleanup; its stdout/stderr are text with secret scanning.
  [src/server/runner/input.ts](../src/server/runner/input.ts) materializes reviewed uploads, while [src/shared/api.ts](../src/shared/api.ts) defines base64 input and text-only run responses.
  It also owns the transfer contracts; preparation and execution routes remain unregistered until artifact ownership and delivery exist.
- [src/server/adapters/write-policy.ts](../src/server/adapters/write-policy.ts), [src/server/admin/tools.ts](../src/server/admin/tools.ts) and `toolWriteStateSchema` in `src/shared/api.ts` own normalized per-tool capability, enabled state, operation allowlists and revision-checked administrator changes.
  Use this model rather than a second download permission switch.
- [src/server/adapters/run-journal.ts](../src/server/adapters/run-journal.ts) connects native mutation evidence to hosted outcomes.
  [src/server/audit/audit.ts](../src/server/audit/audit.ts) persists metadata in SQLite, recovers interrupted runs and retains audit records for 90 days.
- [src/server/config.ts](../src/server/config.ts), [Dockerfile](../Dockerfile), [compose.example.yaml](../compose.example.yaml) and [docs/runbook.md](runbook.md) define the non-root container, tool installations, persistent `/data` and temporary runner storage.
  Artifact bytes must never enter `/data`, backups or the image.
- The shipped T13 adapter, `src/server/adapters/hybrid.ts`, refuses `hash file` and `report file`, maps uploads to isolated managed leaves and uses the existing native journal integration.
  `tools/inventories/hybrid-axi.json` owns the reviewed command and operation boundaries; downloads stay refused until the final slice below.
- Upstream [docs/design.md](https://github.com/knowttl/hybrid-axi/blob/be4ec9b050c3f7576319afeda2f463ea2696fbd2/docs/design.md), T8 and T13, requires native preview, execute, exact confirmation, unchanged bytes and managed write gating.
  Its `src/download-catalogue.ts` binds four operations: `hash-download-bin`, `report-download-bin`, `report-download-dropped-files` and `report-download-memory`.
  Its `src/writes-core.ts` binds confirmation to profile, operation, ID, type and output path, records intent before sending, and never retries downloads.
  Its `src/report-file.ts` atomically publishes a new private file; `src/transport-core.ts` caps downloads at 250 MiB and rejects content encoding that would alter artifact bytes.

The requested password-protected archive is an expectation, not a verified API guarantee.
Upstream's confirmed safety decision allows the provided gzip/ZIP bytes with a warning that password protection is unverified.
Artium must preserve that warning and never inspect encryption, extract, decrypt, encrypt, recompress, repackage, content-scan or execute the artifact.
Reading opaque bytes for transport, byte counting and SHA-256 is the only Artium byte handling proposed here; there is no archive parser, preview renderer or malware scanner.

## Proposed transit and storage

Use the approved strictly bounded temporary store because the released native CLI requires a completed output file and confirms its exact path.
Pure stream-through would require a new upstream sink contract and would risk sending a partial response before native success and audit completion.

1. An authenticated preparation request validates a closed operation/type allowlist, tool access and selected administrator-enabled write operation.
   It reserves an opaque transfer ID and a private directory with a fixed, service-generated output leaf.
   Neither the client destination nor upstream `Vx-Filename` becomes a server path.
2. Run native preview using that reserved output path, with no artifact request.
   Return native warnings and the exact native confirmation string, plus transfer ID, expiry and the client's chosen new destination.
   Keep the server path stable between preview and execution; native confirmation is never regenerated or silently substituted.
3. The execute request supplies the transfer ID, original exact `--confirm`, explicit `--execute` and recent identity confirmation.
   Bind the reservation to user, session family, credential revision, operation, selector, type, client destination and native output path.
   Reject changed scope, expired reservation or duplicate execution; recheck authentication and current tool/write policy immediately before spawn.
   Build a fresh native managed profile permitting only this operation for this request.
   Pass execute and confirmation unchanged through hybrid-axi's own guards and durable journal; Artium never downloads directly or bypasses native policy.
4. The child downloads unchanged API archive bytes into its private native temporary file and publishes the reserved file atomically.
   Keep binary bytes out of stdout/stderr, JSON/base64 run results, secret scanning and audit logs.
   Extend the runner with explicit artifact ownership beyond child exit, instead of placing the artifact in the current call directory that is always removed in `finally`.
   Verify a regular, non-symlink file at the reserved leaf, size and native success/journal evidence, then hash opaque bytes and commit ready metadata before making retrieval available.
5. A separate authenticated, one-shot retrieval request rechecks owner/session and current tool/write permission, claims the transfer atomically and streams the completed file with backpressure.
   Use attachment disposition with a fixed safe archive filename, `application/octet-stream`, `nosniff` and `Cache-Control: no-store`; disable proxy caching, body logging and response transformation.
   No bearer URL, public object, range/resume or automatic retry.
   The client writes a private temporary file, verifies advertised size and SHA-256, and atomically publishes to the exact confirmed new destination without overwrite or symlink traversal.
   Browser download UI offers save only; it never renders or automatically opens the artifact.

Approved fixed limits: 250 MiB per artifact, one reservation per user, four globally and 1 GiB total reserved artifact capacity, including partial files.
Reserve full capacity before native execution; use a dedicated size-limited, non-swappable tmpfs at `/tmp/artium-artifacts`, mounted `noexec,nosuid,nodev`, separate from runner scratch and `/data`.
Native atomic publication may briefly leave two names for one inode; account actual bytes once and include every incomplete file in admission accounting.
No disk fallback is permitted when the mount, capacity or memory budget is unavailable.
The current 128 MiB Node heap in `src/server/config.ts` is not evidence that the upstream buffered 250 MiB path fits: establish bounded child RSS and container memory headroom with inert maximum-size fixtures before enabling it.

Expire reservations and bytes ten minutes after preparation, including generation and retrieval time; cancel the child or stream at expiry.
Delete immediately on completion, disconnect, denial, failure or explicit cancellation; an interrupted download requires a fresh preview and confirmation.
An expiry timer enforces the deadline even without further requests.
On shutdown, stop children and streams before unlinking files; on startup remove all stale entries before admission and mark surviving metadata interrupted.
Unlinking releases temporary storage, not a promise of forensic erasure; host swap, core dumps and backups must not capture the mount.
Persist only ownership, scope, expiry, state and audit metadata; an expired or restarted transfer is never recoverable from persistent metadata.
Deletion failure blocks new artifact admission and raises an operator-visible cleanup error until cleanup succeeds.

## Authorization, audit and user guidance

Downloads are guarded writes despite their upstream GET methods.
Expose each native download operation in the existing write switch's `supportedOperations`, `allowedOperations`, `unlocks` and `blocked` descriptions, off by default and never implicitly enabled by other Hybrid Analysis writes.
Administrator configuration continues to require current administrator authority, recent authentication and expected revision, with CSRF protection for browser changes.
Each user still needs tool policy access plus a fresh per-request scope and recent identity confirmation using the existing 15-minute recent-auth window in `src/server/config.ts`.
Recent authentication is an additional hosted requirement, not a substitute for preview, execute or exact target confirmation.
The user's local destination is bound in hosted scope alongside native confirmation of the reserved server destination.
Credential rotation, policy revocation, sign-out and session revocation invalidate pending transfers and prevent retrieval.

Extend the typed audit event, schema migration and export contract rather than putting new fields in stdout text.
Record authenticated actor and request/transfer correlation, sample hash or report ID, native operation/artifact type, credential revision, requested target digest, actual archive byte size, archive SHA-256 and outcome.
Distinguish preview, denial/not-sent, native outcome unknown, upstream failure, ready, delivery completed, delivery interrupted, expired and deleted.
Unknown size/digest stays null for incomplete archives; a partial digest never masquerades as a complete artifact digest.
Archive SHA-256 is distinct from the selected sample hash.
Keep native audit ID and journal evidence for reconciliation, retaining the existing metadata retention policy.
Fail closed if intent or ready audit cannot be persisted, and delete any unexposed bytes.
Delivery completion means the service finished sending; only the client's verified-save receipt proves local publication, and missing receipt remains unconfirmed.
Never audit bytes, passwords, keys, absolute client paths or untrusted filenames.

UI confirmation, CLI preview/result/error output and command help must say: “Live malware: this archive may contain executable malware. Save only; do not extract or execute. Password protection is unverified; bytes are saved exactly as provided.”
Show type, exact hash/report ID, local destination, limits and expiry before execution; show size/digest and save outcome afterward.
Preserve upstream HTTP 403 and `KEY_LEVEL_RESTRICTED` with vetted-account guidance, or `PERMISSION_DENIED` and unknown key level when restriction is unproven.
Explain that an administrator write switch cannot grant upstream download entitlement; never retry with another key or route.

Operator documentation must require security-team-approved, narrowly scoped AV/EDR handling for the host's dedicated artifact mount and the client's dedicated download directory before enabling downloads.
Explain that security software may quarantine or lock even compressed samples, causing failed delivery, changed availability or cleanup failure; do not disable protection globally or exclude `/data`, the tool installation or a general downloads directory.
Use a dedicated controlled analysis client, avoid sync/indexing/automatic opening, and keep any subsequent analysis outside Artium.
AV/EDR exceptions are operator policy, not changes Artium makes automatically.

## Threat model and limits

| Threat | Mitigation and remaining boundary |
|---|---|
| Accidental download or agent-driven write | Off-by-default operation selection, recent authentication, explicit warning, immutable scope, native preview/execute/exact-confirm and journal. |
| Cross-user disclosure, stolen link or replay | Authenticated owner/session-bound one-shot retrieval, policy rechecks, short expiry, no public URL/cache/range/retry. |
| Malicious archive, archive bomb or accidental execution | Opaque unchanged bytes, no parsing/extraction/rendering/scanning/execution, private noexec mount; noexec alone is not an execution sandbox. |
| Path/header injection or overwrite | Service-generated server paths, regular-file checks, ignored upstream filename, client no-clobber publication and destination binding. |
| Resource exhaustion or abandoned bytes | Full-capacity admission, size/RSS/container limits, absolute expiry, cancellation, startup cleanup and no persistence fallback. |
| Leaks through logs, backups, proxies or endpoint protection | Metadata-only audit, separate binary response, no-store, dedicated tmpfs and approved narrow AV/EDR handling. |
| Ambiguous upstream or client outcome | Native single-send journal, distinct upstream/delivery/save outcomes, no automatic replay, fresh confirmation for a new transfer. |

Out of scope: malware analysis, archive protection verification, payload safety certification, compromised host/client/upstream recovery, arbitrary artifact export, sharing and long-term storage.
An authorized recipient can deliberately copy or execute saved bytes; Artium cannot revoke that copy.
Memory dumps may contain sensitive data, so the same access and retention controls apply even when no executable malware is present.
All implementation verification uses inert synthetic bytes and fake services, never a live download or real credential.

## Storage decision and implementation slices

The owner approved bounded temporary local storage on 2026-10-23: the dedicated tmpfs, limits, ten-minute absolute TTL and one-shot authenticated retrieval specified above.
This preserves native exact-destination confirmation and atomic file/journal behavior.
Pure streaming was considered and deferred because it requires an upstream sink redesign.
There is no outstanding storage decision.
No hosted download becomes available merely by approving this document.

1. Define transfer API, typed audit fields, owner/session scope and limits -> verify denied/default-off/expired/changed-target flows with fake identities and clocks.
2. Add bounded tmpfs artifact ownership and native runner handoff -> verify inert bytes unchanged, maximum size/RSS, cleanup on every terminal path, restart and deletion failure.
3. Add authenticated one-shot transfer, CLI private atomic save and UI/help/operator warnings -> verify cross-user denial, revocation, digest/size mismatch, no overwrite, interrupted delivery and restricted-key 403 through fake-only public journeys.
4. Enable only the reviewed download operations in the T13 hybrid-axi integration after the preceding slices pass -> verify pinned package/container, managed-key redaction, write-switch selection, native preview/execute/exact-confirm and journal without any bypass.
   Until this slice, T13 ships its other capabilities with hosted downloads explicitly refused.
