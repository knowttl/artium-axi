# artium-axi

artium-axi is one container that fronts several agent-ergonomic command-line tools behind a single login.
It adds role-based access to those tools and a command-line client that follows the AXI design principles.

Status: under construction.
Nothing is usable yet.
Installation and quick-start instructions arrive with the first working release.

The development scaffold requires Node 22.12 or later and pnpm 10.22.0, pinned in `package.json`.
The local HTTPS tests also require OpenSSL on `PATH` to create ephemeral test certificates.
Run `pnpm install --frozen-lockfile`, then `pnpm check` for strict type checking, the Vitest suite and TypeScript compilation into `dist/`.
`pnpm lint` performs only static checking, `pnpm test` runs the full suite, and `pnpm build` compiles the scaffold.
The executable toolchain tests compile synthetic TypeScript and run its emitted ESM with Node, and verify strict null checking rejects an invalid assignment.
`pnpm test:security` selects tests whose names contain `security`.
It includes the synthetic hygiene checker and streaming secret-scanner tests.

`src/shared/` owns the run schemas and error catalogue, `src/server/` contains the runner, Falcon adapter and encrypted credential store, and `src/cli/` reserves the client layout.
`test/` holds scaffold, hygiene and synthetic upstream tests.
The pinned container scaffold and Falcon preparation are available, while the server, CLI and remaining adapters arrive in later slices.
See [`.no-mistakes.yaml`](.no-mistakes.yaml) for the configured pipeline commands.
All application validation will use fakes and synthetic data, with live acceptance deferred.

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

The first Falcon adapter is [falcon.ts](src/server/adapters/falcon.ts).
Call `prepareFalcon(args, { clientIdFile, clientSecretFile, region, memberCid? })` with server-owned Docker secret-file paths.
It refuses unsafe overrides before reading either file, injects only `FALCON_CLIENT_ID` and `FALCON_CLIENT_SECRET`, and adds the managed region and optional member CID.
Pass its executable, arguments, environment, scan values and limits to the runner.
The [generated Falcon manifest](tools/inventories/falcon-axi.json) owns the reviewed command and credential boundary, metadata, health read and resource requirements.
Regenerate or verify it with `node scripts/falcon-inventory.mjs /path/to/pinned-source --write` or the same command without `--write`, respectively.
The source checkout must match `tools/falcon-source.json`.
[S12 verification](docs/verification-s12.md) covers the actual pinned parser and canary detection reads using `node scripts/fake-services.mjs --falcon` with the locally built `artium-axi:local` image.
Live Falcon acceptance remains unverified.

The [credential store](src/server/store/db.ts) exposes `openStore(file, keyProvider?)`, returning a SQLite connection only after transactional numbered migrations and authentication of every stored credential.
Use a dedicated data directory, such as `/data/artium.db`, and close the connection during shutdown.
The directory and database use modes 0700 and 0600, respectively.
SQLite uses foreign keys, WAL, FULL synchronous writes and a 5-second busy timeout.
The default [KeyProvider](src/server/store/key-provider.ts) reads exactly 32 raw bytes from `ARTIUM_AXI_MASTER_KEY_FILE`, or canonical base64 from `ARTIUM_AXI_MASTER_KEY` when no file is configured.
An unreadable configured file does not fall back to the environment key.
Its key ID is the full SHA-256 digest.
Missing or invalid keys fail with `MASTER_KEY_INVALID`, while an unauthenticatable credential fails with `CREDENTIAL_INVALID`.
[Credential encryption](src/server/store/crypto.ts) uses AES-256-GCM with a fresh 12-byte nonce, a 16-byte authentication tag and canonical JSON associated data `[schemaVersion, tool, credentialId, keyId]`.
Only encrypted fields and revisions belong in `credentials`.
The `tools` table holds pinned versions, enabled state, validated native settings and revisions.
The caller owns native settings validation before storage.
The build copies numbered SQL migrations beside the compiled store.
[S13 verification](docs/verification-s13.md) covers real database reopen, persisted corruption, row binding, startup key refusal and migration rollback.
SecretSource, identity resolution, offline rotation and server startup integration arrive in their assigned later slices.

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
Call `runner.run(userId, executable, args, environment, secrets, limits, input)` with the authenticated user, adapter-provided environment values and all known injected secrets.
Admission covers call-directory setup, execution and cleanup, with no queue, at most 8 global calls and 2 per user.
Falcon preparation reads Docker secret files; its later owning server flow must enforce a separate 30-second preparation deadline.
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
The later server slice must wire disconnect and shutdown events to these public interfaces, then close its store.
`TEMP_UNAVAILABLE` reports failure to create a call directory or its uploaded inputs, including full tmpfs, without exposing filesystem diagnostics.
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
The later HTTP server must enforce the exported body limit, JSON content type, schema validation and authorization before credential retrieval.
The [error catalogue](src/shared/errors.ts) owns the implemented error codes, HTTP status mapping and safe default messages and next steps.
Completed upstream calls use the success envelope even for nonzero exit codes.
Artium failures use the error envelope without captured output.
When building the HTTP success envelope, omit the runner's internal `timedOut` field.

Pass optional input as the seventh `runner.run` argument, with `stdin`, `files` and adapter-reviewed `fileArguments` indices.
The [input transport](src/server/runner/input.ts) validates inputs before creating the call directory, writes uploads into a separate mode-0700 `inputs/` directory as exclusive mode-0600 files, and substitutes only reviewed argument positions whose value exactly matches an uploaded name.
File arguments containing server paths or missing uploads are refused.
Adapters must normalize equals-form flags and supply the reviewed file-value positions after parser-aware validation.
The runner sends bounded UTF-8 stdin through a pipe and closes it, including when stdin is omitted, and cleans uploads with the call directory on success or failure.
The CLI's command-specific stdin capture, remaining adapters' restrictions on credential/config/output paths, HTTP endpoints and audit integration arrive in later slices.
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
It is a packaging example, not a running API yet.
The image's default command prints the Node version until the server entry point exists.
See [verification-s05-06.md](docs/verification-s05-06.md) for packaging verification and deferred Falcon live checks.
