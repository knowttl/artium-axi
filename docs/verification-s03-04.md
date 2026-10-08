# S03/04 local verification

All identities, profiles, credentials and response bodies are synthetic.
No live platform request, deployment, publication or real mutation is authorized.
No hosted CI is configured.

Run `pnpm install --frozen-lockfile`, which also installs the separate tools lockfile with upstream build scripts disabled.
Run `pnpm lint`, `pnpm test` and `pnpm check` against the final committed head.
The suite executes every fake-tool mode, checks installed parser inventories and pinned CLI version/help/usage behaviour, and exercises trusted loopback TLS and native Vectra write gates.
Run the private hygiene check with its outside-checkout deny-list path as documented in README.
Record only the list SHA-256 and result, never the list contents.

Run `pnpm test:fake-services` separately when an existing slice-prefixed Node 22 image is available.
It must prove fixed-host DNS aliases, trusted test TLS and denied TCP access to a separate synthetic network before issuing pinned az-axi requests.
Record redirect, pagination and ambiguous-mutation counts from the fake service.
An absent required image is an explicit unverified container check, not a passing test or live-acceptance result.
Do not pull images or probe real endpoints to overcome that absence.
Confirm every harness-created container, network and temporary directory was removed.
The harness does not create images or build cache.

az-axi 0.1.4's source-derived retry behaviour must not be treated as a commissioned write capability.
The probe expects two requests after a recorded mutation returns 503 with Retry-After.
Until executable evidence and a safe pin settle that limitation, Azure writes remain unavailable.
Live scopes, authentication, permissions, output parity and production host behaviour remain on the captain checklist.
