# artium-axi

artium-axi is one container that fronts several agent-ergonomic command-line tools behind a single login.
It adds role-based access to those tools and a command-line client that follows the AXI design principles.

Status: under construction.
Nothing is usable yet.
Installation and quick-start instructions arrive with the first working release.

The development scaffold requires Node 22.12 or later and pnpm 10.22.0, pinned in `package.json`.
Run `pnpm install --frozen-lockfile`, then `pnpm check` for strict type checking, the Vitest suite and TypeScript compilation into `dist/`.
`pnpm lint` performs only static checking, `pnpm test` runs the full suite, and `pnpm build` compiles the scaffold.
The executable toolchain tests compile synthetic TypeScript and run its emitted ESM with Node, and verify strict null checking rejects an invalid assignment.
`pnpm test:security` selects tests whose names contain `security`.
It currently includes the synthetic hygiene checker tests and permits an empty selection.

`src/shared/`, `src/server/` and `src/cli/` reserve the application layout, and `test/` holds scaffold, hygiene and synthetic upstream tests.
The server, CLI, container and upstream integrations arrive in later slices.
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
The root install runs their frozen installation, with native dependency build scripts disabled.
[`tools/integrity.json`](tools/integrity.json) records the npm SHA-512 values for az-axi 0.1.4, vectra-axi 0.1.3 and mg-axi 0.1.4.
mg-axi is inventoried for phase 8, with no production adapter enabled.
`pnpm test` checks the generated parser inventories against the installed catalogues before running Vitest.
Regenerate them with `node scripts/upstream-inventory.mjs --write` when deliberately changing a pin.
These inventories record provisional flag dispositions, environment variables, aliases and suggestion fields, not a production allow-list.
The native write gates remain upstream-owned.

`node test/fake-tool/fake-axi.mjs <mode>` runs the deterministic test executable.
Modes are `env`, `print`, `sleep`, `stdout`, `stderr`, `memory`, `child`, `descendant`, `exit`, `split`, `leak`, `signal`, `fixture` and `upstream`.
For example, `stdout 8388608` floods stdout, `split canary 3 stderr` splits stderr bytes, and `upstream az-axi error` emits a synthetic stream capture with an error status.
`leak` reads only `ARTIUM_TEST_CANARY`, with `raw`, `base64`, `base64url` or `url` encoding and an optional `stderr` argument.
`child` creates an ordinary descendant, while `descendant` starts a separate session.
Callers must terminate both PIDs printed by those modes.
[`test/fake-tool/tool.ts`](test/fake-tool/tool.ts) supplies the executable and argument descriptor for future runner tests, without a production fake-tool entry.

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
Alternatively set `ARTIUM_TEST_IMAGE` to an existing image whose name starts with `artium-test-`.
An existing suitable Node image can be tagged with `docker image tag <existing-node-image> artium-test-node22`.
The harness never pulls an image, builds one, publishes ports or alters existing containers.
It creates uniquely named `artium-test-` internal networks and containers, routes the fixed upstream names to the fake TLS service and trusts only its ephemeral test CA.
It tests outbound denial using a second synthetic service on a separate internal network, without probing a real endpoint.
Its finalizer removes its containers, networks and temporary certificates, and leaves the supplied image intact.
After a check using a freshly built test image, remove that owned image with `docker image rm artium-test-node22`.
No image or build cache is created by the network harness itself.
An unavailable image or Docker daemon produces a nonzero `unverified` result, which must be recorded in the evidence ledger.
The harness also records az-axi same-origin and cross-origin redirects, pagination and the actual mutation request count after an ambiguous 503.
The Docker check confirmed that az-axi 0.1.4 repeats an uncertain write once after a recorded mutation returns 503 with Retry-After, so its write capability remains unavailable pending safe commissioning.
Clean Node 22 image installation and Falcon packaging remain for the next image slice.
