# S20+S21 local verification

T1.7 implements a standalone minimal CLI, and T1.8 local acceptance runs through the real server/container against fakes.
T0.6 Falcon parity checks exercise the pinned binary; they do not close other tools' capture or live gates.
No real tenant, appliance, credential or connected service is used.

Run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test` and `pnpm check` on the final implementation commit.
Run `pnpm test:walking-skeleton` and `pnpm test:runner-container` for the separate mandatory container checks.
Run `ARTIUM_AXI_HYGIENE_DENY_LIST_FILE=/absolute/private/deny-list.txt pnpm hygiene:check` against that exact committed and built tree, without printing the private list.
Record final SHA, results and timings in the delivery status and PR body.
Any validation fix changing source or tests repeats these checks.

The executable CLI tests copy the esbuild artifact into a temporary directory with no sibling dependencies.
They verify tools and empty listing, exact shell tokens, independent streams, nonzero upstream status, truncation diagnostics, safe server errors, malformed response rejection, owner-only token permissions and usage failures before any request.
Ephemeral HTTPS certificates verify configured CA trust and failure without trust.
The inherited TLS-bypass regression checks both commands against an untrusted HTTPS server with `NODE_TLS_REJECT_UNAUTHORIZED=0`, requiring refusal without transmitting the token.
Authenticated redirect statuses 301, 302, 303, 307 and 308 never produce a second request.
HTTP without explicit test mode and non-loopback HTTP even with test mode are rejected before transmitting tokens.
URLs with embedded credentials, queries or fragments are rejected.
The real API integration test runs the bundle against Fastify, SQLite and the runner, including the fake tool's environment-mode canary scan and safe terminal audit.

The walking-skeleton harness builds the actual production Dockerfile and starts its normal server entry point.
It seeds encrypted synthetic credentials in disposable data volumes.
See [S30 verification](verification-s30.md) for the bootstrap, password-change and sign-in checks that supply its CLI access token.
See [S22+S23 verification](verification-s22-23.md) for the added Vectra harness acceptance.
An internal Docker network resolves the fixed Falcon origin to the fake TLS service, with a synthetic CA bound over the pinned Python certificate bundle.
Both the CLI and local pinned Falcon binary execute inside that isolated network.
Detection reads, pagination, empty results and usage-error output match across stdout, stderr and exit codes, apart from recognized timing fields.
For canary verification, the same server entry point runs with its executable path bound to a Python environment-mode fake, matching Falcon's Python memory limit.
The fake's local environment output confirms it emits the canary, and the CLI receives only `SECRET_IN_OUTPUT`.
The canary CLI runs on actual Linux Node 22.12.0 from a pinned test image with just one bundle file in its working directory.
All Docker names begin with `artium-test-`; the harness removes only resources it created.

Actual Windows and macOS execution, real Falcon permission/output captures, the deployed proxy and the owner's first live call remain unverified captain acceptance after the full build.
Linux containers and platform logic tests cannot substitute for those checks.
