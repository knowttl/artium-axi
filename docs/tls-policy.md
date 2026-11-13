# Credential TLS trust

A saved exact leaf pin is mandatory on the connection carrying application data, even when the same endpoint also has a CA record.
CA records build the verified chain and never suppress a pin.
CA-only credentials retain issuing-CA trust, and pin-only credentials retain exact-leaf trust.
Hostname, validity and chain verification remain enabled.
Proxmox `certificatePin.replaceHostname` is an intentional Proxmox-only exception that skips hostname comparison while retaining the exact leaf pin on every connection.

Existing setups that relied on a CA to override a stale pin fail until the pin is updated.
Follow the [inspection and renewal procedure](runbook.md#trusting-one-tool-from-the-administration-ui), compare the new fingerprint through an independent trusted route, then renew trust or replace the fingerprint in Certificate verification.

## Routes

| Route | Trust boundary |
| --- | --- |
| Node tools, including adapter-built HTTPS transports | Runner `nodeTrustBootstrap` serializes `buildCredentialTlsOptions` and `certificatePinError` from `credential-tls.ts` |
| Python tools | Runner `pythonTrustBootstrap` checks the connected leaf before returning the verified handshake |
| GitHub Go transport and managed Kubernetes transport | Runner selects `pinnedHttp`, whose upstream request uses `credentialTlsOptions`; unsupported Kubernetes byte paths refuse pins |
| Server-side Azure, GitHub and AWX token requests | `credentialFetch` uses `credentialTlsOptions` on each request |
| Health preflight and admin tests | `inspectEndpoint` and `preflightEndpoint` use the same policy; native fingerprints remain additional constraints |
| Admin certificate inspection | `inspectCertificate` delegates to `inspectEndpoint`; admin comparisons use `certificatePinError` |
| Background tool health | Uses the same Runner transports as foreground calls |
| Adapter CA inputs | `credential-profile.ts` and legacy Vectra materialize CA files; UniFi connection-address and AWX request hooks retain Runner verification |

Node TLS sessions are disabled in the injected connection policy; server fetches and the relay use fresh agents.
Python discards sessions for endpoints with saved trust.
Diagnostic certificate observation sends no application data or credentials and cannot authorize a rejected connection.
Issuer retrieval uses public trust and accepts only the certificate's bounded issuer URL.
`pnpm lint` runs `scripts/tls-policy.ts` to reject new direct server TLS transports and verification options outside these reviewed boundaries.

## Read-only credential inventory

No live credential store was inspected; no production deployment is in reach.
Repository fixtures, fake-service seeds and migration test data were inspected read-only.

- `test/integration/certificate-trust.test.ts`, synthetic Vectra migration: `synthetic-legacy-ca-pin` becomes CA trust beside retained self-signed and `synthetic-no-issuer-pin` pins at the same loopback endpoint.
  Its old acceptance of arbitrary CA-issued leaves depended on the bypass; the regression now requires a retained pin to match.
- The same file's synthetic Vectra mixed-trust scenario stores `synthetic-root-issued-pin` beside an issuing CA record.
  The pinned root-issued leaf remains accepted; another leaf remains rejected.
- Kubernetes certificate-administration fixtures retain credential `certificateAuthority` with endpoint pin records, and managed Kubernetes relay fixtures explicitly combine CA and pin records.
  These are intentional matching-pin setups; a stale pin must fail.
- `src/server/store/credential-instances.test.ts` and `multi-instance-migration.test.ts` contain only synthetic CA rows with observed leaf metadata, not an additional exact pin.
- Fake-service Gitea, UniFi, Kubernetes and Kubernetes-session seeds contain CA-only records; an observed `leaf_fingerprint` on a CA row does not itself make an exact pin.

The focused mixed-trust transport and Proxmox regressions add only temporary loopback credentials.
