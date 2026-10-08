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

`src/shared/`, `src/server/` and `src/cli/` reserve the application layout, and `test/` holds scaffold, hygiene and synthetic upstream tests.
The pinned container scaffold is available, while the server, CLI and adapters arrive in later slices.
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

`node test/fake-tool/fake-axi.mjs <mode>` runs the deterministic test executable.
Modes are `env`, `print`, `sleep`, `stdout`, `stderr`, `memory`, `child`, `descendant`, `exit`, `split`, `leak`, `signal` and `upstream`.
For example, `stdout 8388608` floods stdout, `split canary 3 stderr` splits stderr bytes, and `upstream az-axi error` emits a synthetic stream capture with an error status.
`leak` reads only `ARTIUM_TEST_CANARY`, with `raw`, `base64`, `base64url` or `url` encoding and an optional `stderr` argument.
`child` creates an ordinary descendant, while `descendant` starts a separate session.
Callers must terminate both PIDs printed by those modes.
[`test/fake-tool/tool.ts`](test/fake-tool/tool.ts) supplies the executable and argument descriptor for future runner tests, without a production fake-tool entry.

[`SecretScanner`](src/server/runner/scan.ts) is the standalone S07 runner component.
Create one per call with all known injected secret values, then call `scan('stdout' | 'stderr', chunk)` on every raw byte chunk before retention or rewriting, including chunks after the 4 MiB per-stream cap.
A `true` result stays true and requires the caller to discard both streams and report `SECRET_IN_OUTPUT` with only safe audit metadata.
The scanner checks raw UTF-8, canonical base64, base64url and `encodeURIComponent` forms, including short values, without retaining output bytes.
Each stream carries independent prefix-match positions, so split UTF-8 bytes work and interleaved streams cannot create a false combined match.
An empty supplied value is rejected, while an empty list is valid for a call with no injected secrets.
Exact-value scanning cannot identify unknown tokens minted inside an upstream tool.
The [runner](src/server/runner/runner.ts) now owns stream capture and scanner integration.
Call `run(executable, args, environment, secrets, limits)` with adapter-provided environment values and all known injected secrets.
It spawns an argument array without a shell in a detached Linux process group, using the fixed runtime PATH from `src/server/config.ts`.
Each call has a private mode-0700 directory for its working directory, HOME, TMPDIR and XDG paths, removed after completion or failure.
No parent environment variables are inherited.
The result preserves stdout, stderr and the upstream exit code, with duration, observed byte counts and per-stream truncation flags.
Capture defaults to 4 MiB per stream, drains subsequent output and scans every chunk before retention.
A secret match discards both streams and rejects with `SECRET_IN_OUTPUT`.
Failed spawn and signal termination reject safely without captured output.
The `timedOut` field is currently false.
Timeout, cancellation, descendant termination, admission, flood and memory enforcement arrive in S09/10, while HTTP error mapping and audit integration arrive with the server.
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
`docker compose -f compose.example.yaml config --quiet` validates it without creating resources or reading real secrets.
It is a packaging example, not a running API yet.
The image's default command prints the Node version until the server entry point exists.
See [verification-s05-06.md](docs/verification-s05-06.md) for this slice's local verification and deferred Falcon live checks.
