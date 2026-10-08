# S24 local verification

S24 implements T2.5 steps 1 and 2 only.
The credential schema and MSAL acquisition boundary live in [azure-tokens.ts](../src/server/adapters/azure-tokens.ts).
The root package and lockfile pin MSAL to the version already installed with the pinned Graph upstream.
See [S25 verification](verification-s25.md) for the resource cache and [S26 verification](verification-s26.md) for adapter preparation and local pinned-command checks.
No live tenant or identity provider is contacted.

Run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test` and `pnpm check` against the final implementation commit.
Run the separate mandatory `pnpm test:walking-skeleton` and `pnpm test:runner-container` checks documented in [README.md](../README.md).
Run the real private hygiene scan on the committed and built candidate without printing the deny list.
Record the exact commit, command results and timings in the delivery status and PR body.
Any source or test changes during pipeline review require renewed validation.

The tests use MSAL's supported network interface to fake discovery and token responses.
Client-secret success verifies the submitted client credential grant and returned token, expiry and scan values.
Certificate success uses an ephemeral synthetic certificate and matching PEM key, verifies the PS256 assertion signature and SHA-256 thumbprint header, and checks issuer, subject and token-endpoint audience.
The exact submitted assertion is returned as a scan value and detected through the existing streaming scanner.
An unusable key fails before the token request, an authority signature rejection fails safely, and an assertion-bearing transport error produces only the catalogue error without a raw cause.
Malformed and mixed credential forms fail before token requests.
Diagnostics tests observe stdout and stderr and require no emitted secret-bearing transport details.
Both auth forms also run in a real Node child with filesystem writes denied by the permission model, proving authentication needs no disk cache.
The test selects the permission flag supported by the running Node version, including Node 22.12's experimental flag.

The `azureAudiences` map in [azure-tokens.ts](../src/server/adapters/azure-tokens.ts) owns the six audience values, derived from the pinned az-axi `dist/lib/auth.js` `RESOURCE_URL`.
[The authentication tests](../src/server/adapters/azure-tokens.test.ts) inspect actual MSAL token-request scopes and check the exact source-derived candidates, including preserved trailing slashes when appending `/.default`.
These values have fake transport evidence only.
The certificate fields follow the pinned MSAL public API and [Microsoft's certificate credential documentation](https://learn.microsoft.com/en-us/entra/msal/javascript/node/certificate-credentials).
No certificate or private key is published as a fixture.

Pending captain checklist: verify harmless live secret authentication, harmless live certificate authentication and all six scope audiences, recording their successful exact trailing-slash forms privately.
See [S26 verification](verification-s26.md) for the pending live resource, native permission and write-family acceptance.
Do not mark T2.5's live acceptance complete from these tests.
