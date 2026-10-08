# S05/06 verification

All application execution uses synthetic values and fake services.
Only public source, package registries and Debian packages are downloaded during the build.
No Falcon credential or service is used.
There is no hosted CI.

1. Run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test` and `pnpm check` on the final candidate.
2. Validate the Compose document with `docker compose -f compose.example.yaml config --quiet`.
3. Build `artium-axi:local` with `node scripts/build-fake-service-image.mjs --production`.
   Hashed build and runtime dependency installs, wheel building and wheel installation have no network.
   `pip check` verifies the resulting runtime dependency graph.
   The clean builder executes the native smokes too.
4. Run the image with `--network none --read-only --tmpfs /tmp`.
   Check `id` reports UID 10001 and the tool versions match Falcon 0.3.0, Vectra 0.1.3, Azure 0.1.4 and Graph 0.1.4.
   Falcon reports its version in `--help`.
   Run `node scripts/native-smoke.mjs` and `node scripts/falcon-smoke.mjs`.
   The latter makes one canary-only OAuth request to a loopback fake, returning a synthetic rejection.
5. Remove the owned image and confirm no slice-owned containers, images or build cache remain.
6. Run the mandatory private hygiene scanner against the final commit and exact published head.
   Never print or copy its private input.
   Record exit status, commit and deny-list SHA-256 in delivery evidence and the PR body.

The pipeline must rerun frozen install, lint, tests, aggregate checks and private hygiene after any source or test fixes.
Repeat the container build and smokes if the pipeline changes packaging, dependencies, native modules, config or smoke scripts.
Use only uniquely named `artium-*` resources and the private BuildKit cache.
Do not use the shared builder or prune Docker resources.

## Falcon boundary evidence

Source pin: v0.3.0, commit `3eaf23fa8496b8ecf947e45e1a6e7e8227349ccb`.
The upstream `GLOBAL_FLAGS` are `help`, `region`, `allow-unknown-origin`, `member-cid` and `no-member-cid`.
`help` is provisional passthrough.
`region` and `member-cid` are server-managed, while `allow-unknown-origin` and `no-member-cid` are blocked caller overrides.
These dispositions are commissioning evidence, not an implemented adapter allow-list.

The source reads `FALCON_CLIENT_ID`, `FALCON_CLIENT_SECRET`, `FALCON_MEMBER_CID`, `FALCON_BASE_URL`, `FALCON_AXI_CREDENTIALS_FILE` and `FALCON_PROXY_URL`.
The server will inject only the client ID and secret, adding its region and optional member CID arguments.
It will not inherit the remaining variables.
Requests also supports transport environment such as `REQUESTS_CA_BUNDLE` and proxy settings, which the production clean child environment must not inherit from callers.
The loopback test supplies only a synthetic CA for verified TLS.
The pinned tool rejects non-default ports even with `--allow-unknown-origin`, so the isolated loopback service listens on 443.
Source region precedence is `--region`, then `FALCON_BASE_URL`, then `us-1`.

Captain live acceptance remains unverified: a harmless detection read with the designated credential and region, a read without region to confirm actual cloud behaviour, and timing a 24-hour NG-SIEM search.
Record those privately after the full build and before changing adapter timeouts.
The local canary test does not satisfy those gates.
