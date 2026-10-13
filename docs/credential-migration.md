# AXI credential migration

The [credential standard](credential-standard.md) is the canonical contract.

## Migration path per tool

| Tool | Changes |
| --- | --- |
| vectra-axi | Move to XDG; replace tokenEnv/secretEnv with SecretRefs; add permission checks, the env profile and auth status; ship the profile schema. |
| az-axi | Move to XDG; drop cwd discovery; write config atomically; validate SecretRefs on load; add auth status and ship the schema. Keep ambient az authentication. Changes stay in knowttl/az-axi, with matching UPSTREAM.md local-change records. |
| mg-axi | Move to XDG; add config/profile selection; flatten credentialRef into SecretRefs; add auth login/logout/status; use thumbprintSha256; store delegated credentials in the protected state file; enforce Windows DACLs. |
| falcon-axi | Add XDG profiles; replace dotenv credentials with SecretRefs; rename environment variables; ship the schema; enforce platform-specific private-file checks. |
| awx-axi | Add profiles and SecretRefs; bind stored tokens to their origin; enforce HTTPS and per-request TLS policy; rename environment variables; revoke PATs on logout; enforce Windows DACLs. |
| azure-axi | Keep ambient credentials; adopt tenant/subscription profiles, AZURE_AXI variables and auth status. |
| artium-axi | Use one schema-driven profile writer, admin form and validation; retire legacy credential schemas and guide strings as each pinned tool migrates; use ARTIUM_SECRET_<n> holders; keep the az token broker. Addresses I-14 (certificate field alignment) and I-15 (bespoke onboarding). |

The host now has the shared schema-driven profile writer, validation and admin fields, with legacy paths retained for pinned packages that do not ship a schema.
Schema locations are owned by [server configuration](../src/server/config.ts); an absent schema retains legacy handling, while an unreadable or invalid schema fails startup with `CREDENTIAL_INVALID`.
The az token broker retains its source-identity editor and validates the brokered token profile against the shipped schema when available.
Each tool switches when its pinned package ships axi-credential.schema.json.
For tools using the shared credential editor, that schema owns validation, form guidance and secret injection.
The published vectra-axi 0.1.5 and mg-axi 0.1.6 pins ship the canonical schemas and use the shared writer.
Fake-service tests execute both released packages with artium-written SecretRefs, isolated XDG configuration and private files.
Graph's headless schema is projected from its published credential schema, including SHA-256 certificate thumbprints.
Az, Falcon and AWX follow; azure-axi follows last.
