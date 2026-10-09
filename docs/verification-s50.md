# S50 local Graph headless inventory (T8.1)

The local portion of T8.1 retains the exact scoped package pin already present in `tools/package.json`, `tools/integrity.json` and `tools/pnpm-lock.yaml`.
[The source record](../tools/mg-source.json) owns the fresh npm reconfirmation timestamp, version, integrity, exact query and tarball.
The package is scoped; the unscoped `mg-axi` npm name returns 404.

[The generated parser inventory](../tools/inventories/mg-axi.json) owns accepted leaf flags, API positional input, source hashes, native write settings and the observed `headlessInventory`.
Its `headlessInventory` records global and common flag scope, parser behavior and example credential environment names; `environment` and `dynamicCredentialEnvironment` distinguish native defaults from profile-selected holders.

[The generated headless JSON schema](../tools/inventories/mg-axi-headless.schema.json) is a local projection of the pinned application-profile validator, produced by `node scripts/mg-headless-schema.mjs --write` and freshness-checked by `pnpm test`.
The package's `inventory/schema.json` describes Graph operations, not headless profiles, and the pinned CLI has no schema export flag.
The schema owns the projected field constraints and credential forms, including upstream keychain and federation forms, without adapter policy dispositions.
It is a profile schema, not a claim that every valid profile is safe to expose through Artium.

`pnpm test:mg-headless` runs the pinned profile-create interface and acquisition provider in a task-owned Node 22 test image built with the existing digest-pinned fake-service builder, with a read-only filesystem, tmpfs credential files, no network, no host credential mounts and a loader that refuses keychain imports.
The loader replaces only `@azure/msal-node` with a fake confidential client, asserting the secret/key transport, certificate thumbprint and Graph `.default` audience.
The probe generates an ephemeral synthetic RSA PEM, tests both environment and 0600 file holders for secrets and certificate keys, and verifies session-only token acquisition.
It verifies application interactive login refusal, missing holders, encrypted key refusal, unsafe file modes, symlinks, inlined secrets, conflicting holders and device-code opt-in refusal.
Stored profiles contain references, never secret or PEM material.
It executes help resolution for all inventoried leaves and bare version flags, plus parser rejection and equals-syntax cases.
The task container and standalone image are removed in `finally`; the probe creates no volume, network or development stack.
`pnpm test:containers` runs the same probe using its task-owned fake-service image and removes that image with the rest of its resources.

These checks prove local validation and transport into a fake MSAL boundary.
They do not prove real certificate signing, Microsoft authentication, tenant permissions, Graph consent or a live Graph read.
Live application consent and both real authentication forms remain unverified.
No application account was requested and T8.2 was not started.
Final candidate aggregate checks, container input/output digests, timings and private hygiene evidence belong in delivery status and the PR body.

The worker's local run completed on Linux x64 with host Node `v24.17.0` and container Node `v22.23.3`.
`pnpm check` exited 0 with 50 test files and 1,864 tests passing (Vitest 91.46 seconds), then passed build and the AXI/distribution checklist.
`pnpm test:containers` exited 0 in 149,997 ms, including the headless probe in 678 ms and cleanup with `cacheRemoved: true`.
The headless image was `sha256:5b34a45edccbef2f6b5da60598b81702819e9ae16241ce3f60bb192194e660db`.
Container evidence named base HEAD `69150d1a096aacece038f0843be5b9e7db724e94` with the uncommitted S50 candidate present, input digest `93109d628661ce4f0ef4ad046268e52692f75e7a70b487e7b1891a72aea6c765` and compiled-output digest `e275b8fa0a35bc6ee72bb52490e61bc039bb372831be13cb809d78870be8fd81`.
These results describe the original S50 candidate before subsequent gate repairs; final candidate verification belongs in delivery status and the PR body.
The private deny-list hygiene check passed with zero matches, without printing its contents.
