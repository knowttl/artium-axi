# S03/04 local verification

All identities, profiles, credentials and response bodies are synthetic.
No live platform request, deployment, publication or real mutation is authorized.
No hosted CI is configured.

Run `pnpm install --frozen-lockfile`, which also installs the separate tools lockfile with upstream build scripts disabled.
Run `pnpm lint`, `pnpm test` and `pnpm check` against the final committed head.
The suite executes every fake-tool mode, checks installed parser inventories and pinned CLI version/help/usage behaviour, and exercises trusted loopback TLS and native Vectra write gates.
Run the private hygiene check with its outside-checkout deny-list path as documented in README.
Record only the list SHA-256 and result, never the list contents.

Run `pnpm test:build-image`, then `pnpm test:fake-services` separately.
See [README.md](../README.md) for the combined container command, [container-checks.mjs](../scripts/container-checks.mjs) for block ownership and [build-fake-service-image.mjs](../scripts/build-fake-service-image.mjs) for standalone image and cache cleanup.
The network harness must prove fixed-host DNS aliases, trusted test TLS and denied TCP access to a separate synthetic network before issuing pinned az-axi requests.
Record redirect, pagination and ambiguous-mutation counts from the fake service.
If the image cannot be built or Docker is unavailable, record explicit unverified container evidence rather than a pass.
Public dependency image retrieval is authorized, while live platform endpoints remain excluded.
Confirm every harness-created container, network and temporary directory was removed.
Remove the freshly built slice-owned test image after collecting the network evidence.

The [probe](../test/fake-service/probe.mjs) owns the expected ambiguous-mutation request count.
See [the evidence ledger](evidence-ledger.md) for historical retry observations and subsequent verification.
Live scopes, authentication, permissions, output parity and production host behaviour remain on the captain checklist.
