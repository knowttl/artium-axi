# S51 local Graph adapter (T8.2)

The [internal adapter](../src/server/adapters/mg.ts) supports the pinned application secret and certificate forms.
It emits a version-1 profile as a private runner-owned temporary file and places the secret or key in the environment holder named by the profile.
Configured preview and native write settings survive preparation, including the operation allowlist.
No Graph adapter enters the production runtime registry.
The admin/store contract recognizes Graph settings and credentials, while runtime enablement and credential tests remain unavailable.

The [generated boundary](../tools/inventories/mg-axi.json) owns allowed command families, unsafe overrides, sensitive arguments, input transports, known output scan values, resource requirements and pinned parser hashes.
Preparation accepts no uploaded files and accepts stdin only as a cursor transport.
Client secrets and their trimmed values, or private keys and their normalized PEM values, enter the existing raw/base64/base64url/percent-encoded scanner.
Upstream-minted tokens and assertions are unavailable during preparation and are not claimed as scanned values.

The pinned package parses a 73 MiB operation inventory for a Graph read.
The first real runner probe reproduced a process signal at the default 128 MiB heap.
Host probes using a bounded 512 MiB heap completed a fake user read in 1.14 seconds at 443,736 KiB maximum RSS and a confirmed fake group membership write in 1.15 seconds at 442,544 KiB maximum RSS.
The adapter alone supplies this trusted heap allowance; the runner still overwrites caller NODE_OPTIONS and other tools retain their default.
The container adapter probe uses a non-root user, a read-only root filesystem, no network, 768 MiB memory, 192 tasks and a 32 MiB noexec tmpfs.

`pnpm build` followed by `pnpm test:mg-headless` runs the existing fake MSAL secret/key acquisition probe and the additional real-runner adapter probe.
The latter replaces only the external executable with a child using the pinned Graph CLI, session and mutation coordinator, with fake credential and transport boundaries.
It proves a user read, profile override refusal before credential access, local role denial, native preview, missing confirmation, disabled writes, operation scope denial, one confirmed send, durable intent/outcome and paired Artium audit events.
An encoded secret in a fake Graph displayName triggers SECRET_IN_OUTPUT and a terminal audit; all call directories are removed.
No real Graph or Microsoft authentication call is made.

`pnpm check` covers typed API/store/admin contracts, adapter preparation, scanner forms, trusted heap behavior and the existing distribution checks.
`pnpm test:containers` repeats runner cgroup/tmpfs checks, walking skeleton, headless/adapter acceptance, fake services, packaged Graph version and production backup/restore rehearsal.
The block emits command timings, head and input/output digests, image identities and cleanup results, and removes only its own images, containers, networks, volumes and BuildKit cache.
Candidate evidence is recorded in delivery status and the PR body; any relevant input change requires fresh container checks.
The private deny-list hygiene check runs after committing and building without printing the list.

All local permission, preview, write, denial, audit, packaging and deployment rehearsal evidence uses fakes and synthetic identities.
Live Graph application consent, application permissions, actual authentication, live output redaction and deployment remain unverified.
No application account was requested.
