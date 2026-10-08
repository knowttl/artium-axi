# artium-axi

artium-axi is one container that fronts several agent-ergonomic command-line tools behind a single login.
It adds role-based access to those tools and a command-line client that follows the AXI design principles.

Status: under construction.
The development API and minimal bundled CLI are runnable locally, while production authentication arrives in later slices.

The development scaffold requires Node 22.12 or later and pnpm 10.22.0, pinned in `package.json`.
The local HTTPS tests also require OpenSSL on `PATH` to create ephemeral test certificates.
Run `pnpm install --frozen-lockfile`, then `pnpm check` for strict type checking, the Vitest suite and TypeScript compilation into `dist/`.
`pnpm lint` performs only static checking, `pnpm test` runs the full suite, and `pnpm build` compiles the scaffold.
The executable toolchain tests compile synthetic TypeScript and run its emitted ESM with Node, and verify strict null checking rejects an invalid assignment.
`pnpm test:security` selects tests whose names contain `security`.
It includes the synthetic hygiene checker and streaming secret-scanner tests.

`src/shared/` owns the run schemas and error catalogue, `src/server/` contains the runner, Falcon and Vectra adapters and encrypted credential store, and `src/cli/` contains the minimal client.
`test/` holds scaffold, hygiene and synthetic upstream tests.
The pinned container, development server, bundled CLI and Falcon and Vectra adapters are available, while the remaining adapters arrive in later slices.
See [`.no-mistakes.yaml`](.no-mistakes.yaml) for the configured pipeline commands.
All application validation will use fakes and synthetic data, with live acceptance deferred.

`pnpm build` produces the standalone `dist/cli/artium-axi.mjs`, requiring Node 22.12 or later and no sibling files or `node_modules`.
Set `ARTIUM_AXI_URL` to the server's HTTPS base URL and `ARTIUM_AXI_DEV_TOKEN_FILE` to an owner-only file containing your synthetic development token.
The URL cannot contain credentials, a query or a fragment.
The client uses Node's certificate trust, optionally extended with `ARTIUM_AXI_CA_FILE`; certificate verification remains enforced even with `NODE_TLS_REJECT_UNAUTHORIZED=0`.
Authenticated redirects are refused and requests are never retried automatically.
Only loopback HTTP test traffic may opt in with `ARTIUM_AXI_TEST_HTTP=1`.
Run `node dist/cli/artium-axi.mjs tools` or `node dist/cli/artium-axi.mjs falcon-axi detection list`.
For the advertised command in a POSIX shell, define `artium-axi() { node /absolute/path/to/artium-axi.mjs "$@"; }`.
The client preserves argument tokens, upstream stdout, stderr and exit status, with truncation diagnostics on stderr.
Artium errors withhold captured output and use structured TOON on stdout with exit 2 for usage or client configuration failures and exit 1 for other failures.
Login, complete home/help views, suggestion rewriting and download/launcher distribution remain later-slice work.

Run `pnpm test:walking-skeleton` for mandatory fake-only container-to-CLI acceptance.
See [S20+S21 verification](docs/verification-s20-21.md) for the harness, resource cleanup and deferred captain checks.
The same harness now exercises pinned Vectra reads, native write gates and durable logs through the production server entry point.
See [S22+S23 verification](docs/verification-s22-23.md) for Vectra acceptance and output-redaction limits.

Azure secret and certificate token minting and the resource token cache are implemented internally; Azure commands are not yet available through Artium.
See [S24 verification](docs/verification-s24.md) for authentication and [S25 verification](docs/verification-s25.md) for lazy resources, refresh, deadlines, backoff, coalescing and revision eviction.
Azure profile preparation and command execution remain S26, with live acceptance deferred.

Before publishing any candidate, set `ARTIUM_AXI_HYGIENE_DENY_LIST_FILE` to an absolute path to the private deny list outside the checkout, then run `pnpm hygiene:check` from the candidate repository root after committing and building.
The UTF-8 list contains one literal term per line, matched case-insensitively after trimming surrounding whitespace, with blank lines and duplicate terms ignored.
An unset, unreadable, empty or in-tree list fails the check.
Never copy real terms or the private list into this repository.
Record only its revision or SHA-256 alongside the candidate commit and pass/fail result.

The checker scans the whole current tree, including tracked, untracked and ignored files, generated narrative, build logs, bundles and source maps.
Only `.git` metadata and installed `node_modules` directories are excluded.
It also scans all commit messages reachable from `HEAD`.
Pass any intended assets outside the checkout explicitly, for example `pnpm hygiene:check /path/to/release-assets /path/to/build.log`.
Symlinks and unreadable files fail rather than silently reducing coverage.
BOM-marked UTF-16 and UTF-32 candidate files and supplied assets fail with an unsupported-encoding error; convert them to UTF-8 before checking.
Keep the deny list outside every supplied asset directory too.
Matches report the file or commit, one-based line and column, and entry number in the normalized, deduplicated list, without excerpts or term values.
A diagnostic label containing a matching path term is replaced entirely with `[redacted]`.
Synthetic tests prove checker behaviour, while the real private scan supplies candidate hygiene evidence.
The check cannot guarantee absence of unknown sensitive values and does not approve publication.

See [the evidence ledger](docs/evidence-ledger.md) for local implementation, pinned-upstream fake-service evidence and the deferred captain live acceptance gates.
No live gate is satisfied by a fake-service result.

The upstream Node packages are pinned separately in [`tools/package.json`](tools/package.json) and `tools/pnpm-lock.yaml`.
The root install runs their frozen installation.
Root native build approval is limited to `argon2`, `better-sqlite3` and `esbuild` in `package.json`, while upstream tool build scripts remain disabled.
[`tools/integrity.json`](tools/integrity.json) records the pinned upstream versions and npm SHA-512 values.
mg-axi is inventoried for phase 8, with no production adapter enabled.
`pnpm test` checks the generated parser inventories against the installed catalogues before running Vitest.
Regenerate them with `node scripts/upstream-inventory.mjs --write` when deliberately changing a pin.
These inventories record provisional flag dispositions, route-specific aliases, accepted short flags, positional inputs, native environment defaults, profile-selected credential variables, native profile write settings and suggestion fields, not a production allow-list.
Native write-setting records include hashes of the pinned configuration and permission-gate sources.
The native write gates remain upstream-owned.

The [Vectra adapter](src/server/adapters/vectra.ts) accepts QUX v2.5 token or OAuth credentials and RUX v3.4 OAuth credentials.
Each record contains `kind`, `apiVersion`, HTTPS `origin`, `auth`, and either `token` or `clientId` plus `clientSecret`.
Optional fields are PEM `caBundle`, QUX `applianceRelease`, and the native `writes: { allowWrites, operations }` policy.
Artium carries the validated write policy into its generated profile and never sets `VECTRA_AXI_READ_ONLY`.
The runner creates the profile and CA beside each other with mode 0600, sets `VECTRA_AXI_CONFIG`, injects the referenced secret variable, and removes the private call directory on completion.
Caller config/profile overrides and local setup commands are blocked before credential retrieval.
Reviewed `--tags-file`, `--ids-file` and `--note-file` inputs accept uploaded names or the upstream stdin marker `-`, rather than server paths.
The development server stores native Vectra JSONL write logs under `tool-logs/vectra-axi/writes.log` beside its database, normally `/data/tool-logs/vectra-axi/writes.log`.
These mode 0600 logs survive call cleanup and use the pinned tool's exclusive lock for daily 90-day retention, preserving intent/outcome pairs and their native format.
Before accepting runs, startup removes abandoned lock and retention files and runs native-log maintenance.
The [startup recovery contract](src/server/adapters/native-log.ts) requires exclusive server ownership of the journal; the supported Docker restart leaves no prior child writers running.
Malformed journals remain untouched and emit a safe `AUDIT_UNAVAILABLE` retention diagnostic while the API remains available.
Native logs complement the requesting user's Artium audit.
Platform grants, API-version compatibility and other native write families remain unverified captain acceptance.

The Falcon adapter is [falcon.ts](src/server/adapters/falcon.ts), implementing the shared [adapter contract](src/server/adapters/types.ts).
Create it with `createFalconAdapter(secretSource)`, then call `adapter.prepare(args, credentialReference)` after authorization and identity selection.
Its zod credential schema accepts `clientId`, `clientSecret`, `region` and optional `memberCid`.
It refuses unsafe overrides before secret retrieval, injects only `FALCON_CLIENT_ID` and `FALCON_CLIENT_SECRET`, and adds the managed region and optional member CID.
Pass its executable, arguments, environment, scan values and limits to the runner.
Falcon requires no temporary files and has no caller flags with server-checked allowed values, because its managed region and member flags are blocked from caller input.
`prepareFalcon(args, { clientIdFile, clientSecretFile, region, memberCid? })` remains the file-backed compatibility entry point and shares the same preparation logic.
The [generated Falcon manifest](tools/inventories/falcon-axi.json) owns the reviewed command and credential boundary, metadata, health read and resource requirements.
Regenerate or verify it with `node scripts/falcon-inventory.mjs /path/to/pinned-source --write` or the same command without `--write`, respectively.
The source checkout must match `tools/falcon-source.json`.
[S12 verification](docs/verification-s12.md) covers the actual pinned parser and canary detection reads using `node scripts/fake-services.mjs --falcon` with the locally built `artium-axi:local` image.
Live Falcon acceptance remains unverified.

The [credential store](src/server/store/db.ts) exposes `openStore(file, keyProvider?)`, returning a SQLite connection only after transactional numbered migrations and authentication of every stored credential.
Use a database file in a dedicated data directory, such as `/data/artium.db`, and close the connection during shutdown.
The directory and database use modes 0700 and 0600, respectively.
SQLite uses foreign keys, WAL, FULL synchronous writes and a 5-second busy timeout.
The default [KeyProvider](src/server/store/key-provider.ts) reads exactly 32 raw bytes from `ARTIUM_AXI_MASTER_KEY_FILE`, or canonical base64 from `ARTIUM_AXI_MASTER_KEY` when no file is configured.
An unreadable configured file does not fall back to the environment key.
Its key ID is the full SHA-256 digest.
Missing or invalid keys fail with `MASTER_KEY_INVALID`, while an unauthenticatable credential fails with `CREDENTIAL_INVALID`.
[Credential encryption](src/server/store/crypto.ts) uses AES-256-GCM with a fresh 12-byte nonce, a 16-byte authentication tag and canonical JSON associated data `[schemaVersion, tool, credentialId, keyId]`.
The [credential schema](src/server/store/migrations/001-credentials.sql) owns the stored fields and constraints; credential plaintext must be encrypted before insertion.
The `tools` table holds pinned versions, enabled state, validated native settings and revisions.
Store startup inserts missing supported tools disabled with an empty version until configured, preserving existing tool settings.
The caller owns native settings validation before storage.
The build copies numbered SQL migrations beside the compiled store.
[S13 verification](docs/verification-s13.md) covers real database reopen, persisted corruption, row binding, startup key refusal and migration rollback.
The [credential-store boundary](src/server/store/credential-store.ts) exposes credential references and parsed values without SQLite types.
Create it with `createCredentialStore(connection, keyProvider)` using the same provider as `openStore`.
Credentials are encrypted JSON objects matching the adapter's credential schema.
Version 1 uses one shared service credential per tool in the embedded encrypted database; external secret sources and per-user credentials remain deferred.
The [SharedIdentityResolver](src/server/policy/identity-resolver.ts) selects that credential with `resolve(userId, tool)`, whoever the user is.
The [EmbeddedSecretSource](src/server/store/secret-source.ts) retrieves that reference through `getCredential(reference)` and decrypts it in memory through the store boundary.
Selection does not grant access to a tool, so the owning server flow must authorize before resolution and retrieval.
[S14 verification](docs/verification-s14.md) covers fake-store unit tests and encrypted-store Falcon preparation after reopen, with the T1.5 tests unchanged.
Server startup opens and validates this store before listening.
Offline rotation arrives in a later slice.

The [authentication schema](src/server/store/migrations/002-authentication.sql) adds local users, roles, tool grants, direct assignments, session families, hashed-token metadata, browser sessions, audit records and a one-time bootstrap marker.
`users.username` stores the canonical lookup name with a unique constraint; `display_name` retains the entered name separately.
The account-writing flow owns canonicalization before insertion.
The `administrator` flag is a reserved account capability independent of role tool grants.
The schema provides revision fields for users and roles, alongside the existing tool and credential revisions; later account and role writers must enforce optimistic concurrency.
Token types are `access`, `refresh` and `password-change`, with consumed and revoked timestamps and family ownership enforced by foreign keys.
Browser idle tracking and reauthentication timestamps are stored for later authentication flows to enforce.
Authentication and audit writers must store timestamps as UTC Unix milliseconds.
Bootstrap metadata starts empty and is written atomically with the first administrator in the later bootstrap slice.
[S15 verification](docs/verification-s15.md) covers empty-store creation, Phase 2 upgrades with encrypted data preserved, canonical-name uniqueness and foreign keys.
The [access-token verifier](src/server/auth/tokens.ts) looks up SHA-256 hashes and enforces access-token type, token and family deadlines, consumption and revocation.
The [tool policy](src/server/policy/policy.ts) reads the current enabled user, enabled tool and role grants on every call.
The [audited execution function](src/server/runner/run.ts) verifies the token, current policy and bounded request before persisting a start, resolving the shared identity and retrieving credentials through the adapter.
It executes through the runner and persists a terminal event before returning a completed result, including nonzero upstream exits.
The [error catalogue](src/shared/errors.ts) owns token and policy denial codes and their distinct responses.
The random [fixture issuer](test/fixtures/tokens.ts) lives only in the test harness and refuses execution outside `NODE_ENV=test`.
It stores only the token hash, sets a one-hour access-token expiry and a fixed 12-hour family deadline, and issues tokens checked by the production verifier in tests.
[S16 verification](docs/verification-s16.md) covers expiry and revocation, next-call role changes and proof that denied preparation retrieves no secret.
Login, production token issuance and bootstrap execution arrive in later slices.

The [audit store](src/server/audit/audit.ts) records UTC Unix millisecond timestamps, actor IDs, tools, request IDs, verified client addresses, outcomes and safe run metadata.
`runTool(db, audit, runner, token, request, adapter, resolver, context, authenticate?)` owns admission and execution.
It defaults to the production access-token verifier; the development HTTP server supplies its separate static-token authenticator.
The HTTP owner supplies a unique request ID, a verified client address and an optional disconnect signal through `context`.
Audit persistence failure returns `AUDIT_UNAVAILABLE`, prevents credential retrieval and child creation at admission, and withholds the completed result if terminal persistence fails.
Run failures record only stable error codes, duration and observed output sizes, including secret-output failures.
The [argument redactor](src/server/audit/redact.ts) hides sensitive separate and equals flag values and the positional indices identified by `adapter.sensitiveArguments(args)`.
It records at most 64 original arguments, caps each recorded value at 512 characters and escapes control characters.
Injected credential arguments, request bodies, stdin, uploaded contents, tokens, passwords and output streams never enter audit storage.

Create one `Audit` per server and call `recoverInterrupted()` before admitting requests at startup.
It appends interrupted terminal events for unmatched starts without replaying commands, using null exit codes and unknown output sizes.
Call `maintain()` from the server's daily maintenance tick.
It drains all events strictly older than the captured 90-day cutoff in batches of at most 500 events.
Each batch commits its deletion, cutoff and count in a separate short transaction, and rolls back that batch if its maintenance event cannot be stored.
Set `ARTIUM_AXI_AUDIT_STDOUT=1` to stream each committed record as one JSON line on stdout with exactly the persisted fields.
SQLite remains authoritative if the optional stream fails.
For export, capture that stream in a protected external collector before retention expires.
Database backup includes retained audit records and account metadata and must be protected as sensitive data, with the master key stored separately.
Online backup and stopped restore execution arrive in the later maintenance slice.

`audit.record(event)` supplies the record shapes for sign-in, sign-out, lockout, token reuse, password changes, credential tests and administration.
The later authentication and admin producers must call it using metadata only.
`audit.change(event, mutation)` commits a synchronous database mutation and its event together, then streams the committed event.
It preserves mutation errors and rolls the mutation back when audit persistence fails.
These operations reject calls inside another transaction with `AUDIT_UNAVAILABLE`, so streaming always follows commit.
There is no audit update or deletion interface for administrators.
[S17+S18 verification](docs/verification-s17-18.md) defines the local checks.

`node test/fake-tool/fake-axi.mjs <mode>` runs the deterministic test executable.
Modes are `env`, `print`, `sleep`, `stdout`, `stderr`, `memory`, `child`, `child-exit`, `descendant`, `exit`, `split`, `leak`, `signal` and `upstream`.
For example, `stdout 8388608` floods stdout, `split canary 3 stderr` splits stderr bytes, and `upstream az-axi error` emits a synthetic stream capture with an error status.
`leak` reads only `ARTIUM_TEST_CANARY`, with `raw`, `base64`, `base64url` or `url` encoding and an optional `stderr` argument.
`child` creates an ordinary descendant, while `descendant` starts a separate session.
`child-exit` leaves an ordinary descendant after the leader exits.
`descendant pipes` retains inherited output pipes, and `sleep 60000 ignore-term` ignores SIGTERM.
Lifecycle tests may set `ARTIUM_TEST_READY_FILE` to an owned fixture path to receive an atomic readiness record.
Callers must terminate both PIDs printed by those modes.
[`test/fake-tool/tool.ts`](test/fake-tool/tool.ts) supplies the executable and argument descriptor for runner tests, without a production fake-tool entry.

[`SecretScanner`](src/server/runner/scan.ts) is the standalone S07 runner component.
Create one per call with all known injected secret values, then call `scan('stdout' | 'stderr', chunk)` on every raw byte chunk before retention or rewriting, including chunks after the 4 MiB per-stream cap.
A `true` result stays true and requires the caller to discard both streams and report `SECRET_IN_OUTPUT` with only safe audit metadata.
The scanner checks raw UTF-8, canonical base64, base64url and `encodeURIComponent` forms, including short values, without retaining output bytes.
Each stream carries independent prefix-match positions, so split UTF-8 bytes work and interleaved streams cannot create a false combined match.
An empty supplied value is rejected, while an empty list is valid for a call with no injected secrets.
Exact-value scanning cannot identify unknown tokens minted inside an upstream tool.
The [runner](src/server/runner/runner.ts) now owns stream capture and scanner integration.
Create one `Runner` per server with `await Runner.create()`, before accepting calls.
It removes abandoned `artium-call-` entries from its private root without following symlinks.
Call `runner.run(userId, executable, args, environment, secrets, limits, input, files)` with the authenticated user, adapter-provided environment values and all known preparation secrets.
Admission covers call-directory setup, execution and cleanup, with no queue, at most 8 global calls and 2 per user.
The later owning server flow must enforce a separate 30-second preparation deadline for the [Falcon adapter](src/server/adapters/falcon.ts).
Credential tests and future background health reads must use this same runner and an authenticated identity.
Excess calls reject immediately with `TOO_MANY_CALLS`.
It spawns an argument array without a shell in a detached Linux process group, using the fixed runtime PATH from `src/server/config.ts`.
Each call has a private mode-0700 directory for its working directory, HOME, TMPDIR and XDG paths, removed after completion or failure.
The child environment contains exactly the adapter-provided values with PATH, HOME, TMPDIR, XDG paths and NODE_OPTIONS overridden by the runner.
No parent environment variables are inherited.
The result preserves stdout, stderr and the upstream exit code, with duration, observed byte counts and per-stream truncation flags.
Capture defaults to 4 MiB per stream, drains subsequent output and scans every chunk before retention.
A secret match discards both streams and rejects with `SECRET_IN_OUTPUT`.
Failed spawn and signal termination reject safely without captured output.
The default child timeout is 60 seconds, with a trusted adapter override in `limits.timeoutMs` only after measured probe evidence.
Supply the caller's disconnect `AbortSignal` in `limits.signal` to cancel the call.
Timeout and cancellation reject with `TIMEOUT` and `CANCELLED`, without captured output or an invented upstream exit code.
Completed results retain the existing `timedOut: false` field.
At 64 MiB observed across both streams, the call stops with `OUTPUT_LIMIT`.
Termination sends SIGTERM to the whole Linux process group, allows 2 seconds, then sends SIGKILL, closes lingering pipes and waits for the leader's close event before releasing admission.
Normal leader exit also terminates surviving group descendants.
`await runner.shutdown()` stops admission, cancels runs and waits for their cleanup.
The development server wires HTTP disconnect and shutdown events to these public interfaces, then closes its store.
`TEMP_UNAVAILABLE` reports failure to create a call directory, adapter-owned files or uploaded inputs, including full tmpfs, without exposing filesystem diagnostics.
An upstream tmpfs write failure preserves its ordinary nonzero exit status and still removes the call directory.
Node children receive a 128 MiB heap limit.
The fixed Python launcher applies a 512 MiB address-space limit before executing Falcon, preserving its shebang interpreter.
Other trusted Python descriptors can set `limits.runtime: 'python'`.
Python is the only explicit runtime selector; Node heap limits apply to every call without a selector.
Heap and address-space limits are not total resident-memory caps or complete process isolation.
A descendant that starts a new session escapes the process group, including when it retains output pipes.
The runner bounds pipe cleanup but cannot kill or reap that escaped session.
Ordinary orphan descendants are reaped by the container init process, while the runner reaps its direct child.
The [shared contract](src/shared/api.ts) owns the exact request and response fields, input limits, validation rules and supported tool identifiers.
Requests support argument arrays, optional UTF-8 stdin and named base64 uploads.
The HTTP server enforces the exported body limit, JSON content type, schema validation and authorization before credential retrieval.
The [error catalogue](src/shared/errors.ts) owns the implemented error codes, HTTP status mapping and safe default messages and next steps.
Completed upstream calls use the success envelope even for nonzero exit codes.
Artium failures use the error envelope without captured output.
When building the HTTP success envelope, omit the runner's internal `timedOut` field.

Pass optional input as the seventh `runner.run` argument, with `stdin`, `files` and adapter-reviewed `fileArguments` indices.
Pass adapter-owned profile and CA files as the eighth argument using the [TemporaryFile contract](src/server/adapters/types.ts); the runner creates exclusive mode-0600 files in the call directory and refuses invalid leaf names or collisions.
The [input transport](src/server/runner/input.ts) validates inputs before creating the call directory, writes uploads into a separate mode-0700 `inputs/` directory as exclusive mode-0600 files, and substitutes only reviewed argument positions whose value exactly matches an uploaded name.
File arguments containing server paths or missing uploads are refused.
Adapters must normalize equals-form flags and supply the reviewed file-value positions after parser-aware validation.
The runner sends bounded UTF-8 stdin through a pipe and closes it, including when stdin is omitted, and cleans uploads with the call directory on success or failure.
The development HTTP endpoint uses this contract.
The CLI's command-specific stdin capture and remaining adapters' restrictions on credential/config/output paths arrive in later slices.
See [verification-s11.md](docs/verification-s11.md) for contract and input transport evidence.
See [verification-s09-10.md](docs/verification-s09-10.md) for lifecycle, resource and limitation evidence.
See [verification-s08.md](docs/verification-s08.md) for local runner acceptance checks.
See [verification-s07.md](docs/verification-s07.md) for the local acceptance checks.

Local HTTPS tests create an ephemeral CA and exercise the pinned Vectra native default refusal, preview, confirmed execution and ambiguous-write response against a loopback fake service.
They assert mutation counts and native write-log creation.
They do not prove real appliance permissions.

`pnpm test:fake-services` runs the separate Linux Docker TLS/DNS and outbound-denial check.
It requires Docker, OpenSSL and an image named `artium-test-node22` containing Node 22 or later.
Run `pnpm test:build-image` to build it from the digest-pinned official Node 22 bookworm-slim base in `test/fake-service/Dockerfile`.
The build requires an existing `moby/buildkit:buildx-stable-1` image and permits fetching the public Node base.
It uses a uniquely named, privileged `artium-test-` BuildKit container with bounded CPU and memory, and cache on private tmpfs.
Its finalizer removes that builder, cache and exported temporary archive without touching the shared Docker builder.
It refuses to replace an existing `artium-test-node22` image.
An existing suitable Node image can be tagged with `docker image tag <existing-node-image> artium-test-node22`.
The harness never pulls an image, builds one, publishes ports or alters existing containers.
It creates uniquely named `artium-test-` internal networks and containers, routes the fixed upstream names to the fake TLS service and trusts only its ephemeral test CA.
It tests outbound denial using a second synthetic service on a separate internal network, without probing a real endpoint.
Its finalizer removes its containers, networks and temporary certificates, and leaves the supplied image intact.
After a check using a freshly built test image, remove that owned image with `docker image rm artium-test-node22`.
No image or build cache is created by the network harness itself.
An unavailable image or Docker daemon produces a nonzero `unverified` result, which must be recorded in the evidence ledger.
The harness also records az-axi same-origin and cross-origin redirects, pagination and the actual mutation request count after an ambiguous 503.
See [the evidence ledger](docs/evidence-ledger.md) for the observed retry behaviour and Azure write-capability restriction.
The [Dockerfile](Dockerfile) owns the Falcon wheel build and install recipe, using the full commit in [`tools/falcon-source.json`](tools/falcon-source.json).
Python build and runtime dependencies have separate SHA-256 locks.
Python dependency downloads verify those hashes, and Python installation and wheel building run with no package index and no network.
The runtime contains Python 3.11, the pinned tools and UID 10001 (`artium`).
mg-axi is installed for inventory checks only and has no production tool path or adapter.
`src/server/config.ts` owns the three executable paths.

Run `node scripts/build-fake-service-image.mjs --production` to build `artium-axi:local` using the private BuildKit worker.
This larger build uses overlayfs and an executable 3 GiB tmpfs cache with a 4 GiB memory bound.
The worker and cache are removed on exit, and an existing image is never replaced.
Run `docker run --rm --network none --read-only --tmpfs /tmp artium-axi:local node scripts/native-smoke.mjs` to verify SQLite persistence across reopen, Argon2id hash/verify and an esbuild bundle executed with Node.
Run the same command with `scripts/falcon-smoke.mjs` to verify unknown-origin refusal and explicit canary delivery to a loopback TLS fake.
Remove the owned image afterwards with `docker image rm artium-axi:local`.

[`compose.example.yaml`](compose.example.yaml) records the loopback port, read-only root, `/tmp` tmpfs, `/data` volume and file-backed Docker master-key secret.
It also sets an init process for orphan reaping, a 6 GiB memory limit, a 192-task limit and a 256 MiB `/tmp` tmpfs.
Run `pnpm test:runner-container` for the separate mandatory Linux cgroup and full-tmpfs checks.
It builds a unique `artium-test-runner-s09-10-<uuid>` image with a private `artium-test-` BuildKit worker, tests a non-root read-only runtime without network access, and removes its containers, image and private build cache on completion.
The builder owns its Docker operation deadlines; the harness waits for its cleanup without an enclosing kill deadline.
The checks verify the configured 6 GiB bound and force a resident-memory OOM at a smaller synthetic 256 MiB cgroup bound, without stressing the host with a 6 GiB allocation.
They cover ENOSPC during upstream writes and directory creation under a tighter synthetic 1024-inode bound, cleanup and successful admission after storage is freed.
`docker compose -f compose.example.yaml config --quiet` validates it without creating resources or reading real secrets.
The image's default command starts the development API, which requires an explicit development gate and token file.
The Compose example supplies only the master key; supply the development gate and a mounted token file before starting it.
Compose publishes the internal HTTP listener on host loopback only.
An external connection requires a trusted HTTPS proxy.
See [verification-s05-06.md](docs/verification-s05-06.md) for packaging verification and deferred Falcon live checks.

After `pnpm build`, run `pnpm start` with `ARTIUM_AXI_DEV=1`, `ARTIUM_AXI_DEV_TOKEN_FILE` pointing to an owner-only random token file, and `ARTIUM_AXI_MASTER_KEY_FILE` pointing to a synthetic 32-byte key file.
Use `ARTIUM_AXI_DATABASE_FILE` to select a dedicated local development database instead of `/data/artium.db`.
The [server configuration](src/server/config.ts) owns the listener and storage defaults.
All tools remain disabled until the development store is configured.
Use only synthetic encrypted credentials and fake upstream services during the build.
Never put a token or key in an argument, source file, image or log.

The [Fastify API](src/server/app.ts) implements authenticated `GET /v1/tools` and JSON `POST /v1/tools/{tool}/run`.
Send `Authorization: Bearer <token>` using the token file's contents, and `Content-Type: application/json` for runs.
The [shared API contract](src/shared/api.ts) owns the tools listing schema as well as run requests and responses.
Tools listing includes enabled, granted adapters without contacting an upstream service.
Until the cached health scheduler lands, configured tools have `unknown` status and missing credentials have `unconfigured` status.
Run responses use the exact shared success or error envelope, preserving upstream nonzero exit codes as HTTP 200.
Development authentication is a separate static-token path for one synthetic non-administrator, with current database policy applied to every request.
The server refuses startup unless the development gate is exactly `1` and its token file is readable and contains a nonempty token with no internal whitespace after trimming.
It exposes no admin routes or production login bypass.

Public `GET /health/live` returns HTTP 200 with `{ "status": "ok" }`.
`GET /health/ready` checks that the local migrations table remains readable, returning HTTP 200 with `{ "status": "ok" }` or HTTP 503 with `{ "status": "unavailable" }`.
Readiness does not reload the key or contact remote services.
Set `ARTIUM_AXI_TRUSTED_PROXIES` only to a comma-separated list of verified proxy source IP addresses.
The default trusts none and rejects forwarding headers received directly from untrusted sockets.
The proxy must replace client forwarding headers.
Audit uses generated request IDs and the verified address, persists admission before credential retrieval or child creation, and withholds output when terminal persistence fails.
Startup recovers interrupted runs without replay and performs retention cleanup, followed by daily cleanup.
See [S19 verification](docs/verification-s19.md) for local HTTP, startup, proxy and validation evidence.
