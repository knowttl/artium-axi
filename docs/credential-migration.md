# AXI credential migration

The [credential standard](credential-standard.md) is the canonical contract.

## Migration path per tool

| Tool | Changes |
| --- | --- |
| vectra-axi | Move to XDG; replace tokenEnv/secretEnv with SecretRefs; add permission checks, the env profile and auth status; ship the profile schema. |
| az-axi | Move to XDG; drop cwd discovery; write config atomically; validate SecretRefs on load; add auth status and ship the schema. Keep ambient az authentication. Changes stay in knowttl/az-axi, with matching UPSTREAM.md local-change records. |
| mg-axi | Move to XDG; add config/profile selection; flatten credentialRef into SecretRefs; add auth login/logout/status; use thumbprintSha256; store delegated credentials in the protected state file; enforce Windows DACLs. |
| falcon-axi | The managed pin supports schema-based host integration; see [current Falcon credential handling](credential-standard.md#per-tool-host-facing-schemas). |
| awx-axi | The managed pin ships the profile schema and SecretRefs; see the [host-facing integration](credential-standard.md#per-tool-host-facing-schemas) and [supported boundary](tool-credentials.md#awx). |
| tenable-axi | The managed pin ships both API-key SecretRefs and a fixed cloud origin; see [Tenable One setup](tool-credentials.md#tenable-one). |
| hybrid-axi | The managed pin ships one API-key SecretRef and a fixed origin; see [Hybrid Analysis setup](tool-credentials.md#hybrid-analysis). |
| azure-axi | Keep ambient credentials; adopt tenant/subscription profiles, AZURE_AXI variables and auth status. |
| artium-axi | Use one schema-driven profile writer, admin form and validation; retire legacy credential schemas and guide strings as each pinned tool migrates; use ARTIUM_SECRET_<n> holders; keep the az token broker. Addresses I-14 (certificate field alignment) and I-15 (bespoke onboarding). |
| ado-axi | No upstream migration required; see the [host-owned integration](credential-standard.md#per-tool-host-facing-schemas) and [current authentication scope](tool-credentials.md#azure-devops). |

The host now has the shared schema-driven profile writer, validation and admin fields, with legacy paths retained for pinned packages that do not ship a schema.
Schema locations are owned by [server configuration](../src/server/config.ts); an absent schema retains legacy handling for older adapters, while LDAP falls back to its bundled schema.
An unreadable or invalid schema fails startup with `CREDENTIAL_INVALID`.
The az token broker retains its source-identity editor and validates the brokered token profile against the shipped schema when available.
Each tool switches when its pinned package ships axi-credential.schema.json.
For tools using the shared profile writer, the shipped schema supplies validation, form guidance and secret injection, subject to [hosted input restrictions](credential-standard.md#per-tool-host-facing-schemas).
See the [per-tool host-facing schemas](credential-standard.md#per-tool-host-facing-schemas) for current shared-writer integrations.
Az's brokered token profile and schema-absent fallback both use the per-resource SecretRefs defined in the [credential standard](credential-standard.md#per-tool-host-facing-schemas).
See [credential editor guidance](admin-guide.md#browser-administration) for Vectra origin and CA inputs.
[Published-credential tests](../test/integration/published-credentials.test.ts) exercise artium-written SecretRefs and private per-call configuration: Vectra contacts a fake HTTPS appliance; Graph uses the published CLI and secret resolver with fake credential acquisition and transport.
See [Graph headless verification](https://github.com/knowttl/artium-axi/blob/archive/internal-docs/docs/verification-s50.md) for the generated schema and acquisition probe.
Azure-axi's schema-based host integration remains pending.
