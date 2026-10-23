# Tool credentials

Configure only the tools you intend to use.
At `/admin/tools`, open the tool, save its credential, then use **Test credential** and follow the [activation requirements](admin-guide.md#browser-administration) before enabling it.
The [credential standard](credential-standard.md#9-hosted-contract-artium-axi) owns profile injection and secret handling; [browser administration](admin-guide.md#browser-administration) explains editor inputs, saving and health behavior.

| Tool | Information to obtain | Fixed Artium credential test |
| --- | --- | --- |
| Falcon (`falcon-axi`) | Falcon API client ID, client secret, cloud region, optional Flight Control member CID. | `auth status`, followed by a permitted detection read to confirm API access. |
| Vectra (`vectra-axi`) | HTTPS origin, QUX/RUX deployment kind and API version, personal token or OAuth client ID and secret, optional private CA PEM. | `health list`; grant access to health reads as well as your intended data. |
| Azure (`az-axi`) | Entra tenant ID, application client ID, client secret or certificate private key and SHA-256 thumbprint, subscription IDs and optional workspace mapping. | `account list`; data-plane roles need their own permitted reads. |
| Microsoft Graph (`mg-axi`) | Entra tenant ID, application client ID, client secret or certificate private key and SHA-256 thumbprint, administrator-consented Graph application permissions. | `entra user list --limit 1`; other domains need their own permissions. |
| LDAP (`ldap-axi`) | Verified LDAPS or StartTLS URL, read-only bind identity and password, optional search base and private CA PEM. | `auth status`; binds once and reports the selected identity. |
| Azure DevOps (`ado-axi`) | Organization, optional default project and either a PAT or tenant ID, client ID and client secret. | `project list --limit 1`. |
| AWX (`awx-axi`) | Controller HTTPS origin and either an existing personal access token or a username and password used once to mint one. | `job list --limit 1`; job read permissions are required. |
| Tenable One (`tenable-axi`) | Access key and secret key; the origin is fixed to `https://cloud.tenable.com`. | `card list --limit 1`; exposure-view read access is required. |

#### Tenable One

At `/admin/tools/tenable-axi`, enter `accessKey` and `secretKey` in the secret fields.
The origin is fixed to `https://cloud.tenable.com`; both keys are stored encrypted and injected as private SecretRefs.
The credential test runs `card list --limit 1`; the identity needs exposure-view read access.
Other investigation commands need the corresponding upstream permissions.
Writes stay off until an administrator enables the tool's write switch and selects supported operation IDs.
Business writes and export-job creation retain the native preview, `--execute`, exact preview `--confirm` and durable journal gates.
Unknown write outcomes must be reconciled using the native audit ID and read-back guidance, never replayed blindly.
Through the run API, file flags accept uploaded leaf names or `-` for explicit stdin.
The bundled CLI does not upload Tenable files or forward stdin; see [client input handling](client-reference.md#command-surface-and-subcommands).
Server paths, local configuration, hooks and export downloads are blocked.
Export-job status remains available through the managed CLI.

#### Falcon

In the Falcon console, open **Support and resources > API clients and keys** and create a dedicated API client.
Copy its client ID and secret and record its cloud region: `us-1`, `us-2`, `eu-1` or `us-gov-1`.
At `/admin/tools/falcon-axi`, enter `clientId`, `clientSecret` and `region`, with `memberCid` only when targeting a Flight Control member tenant.
Grant `Alerts:read` for detection reads, including the first-call example.
Grant additional scopes only for the domains you use, following the pinned [API client permission matrix](https://github.com/knowttl/falcon-axi/blob/v0.7.2/README.md#api-client-permissions) and its offline `scopes` command.
For example, account reads need `Assets:read`, while CVE reads need `Vulnerabilities (Falcon Intelligence):read`, distinct from Spotlight vulnerability access.
NG-SIEM search requires `NGSIEM:write`; Identity Protection directory/timeline queries require `Identity Protection GraphQL:write` plus the documented read scopes, even though those queries read data.
These are optional domain requirements and do not justify granting other write or response scopes.
The pinned tool does not change hosts, detections, policies or identities and exposes no arbitrary REST or GraphQL requests.
The fixed `host usb` search requires `NGSIEM:write`; see [Falcon execution setup](runbook.md#falcon-rtr-execution) for its host capability gate.
MalQuery metadata, quota and request-status reads require `MalQuery:read`.
MalQuery search requires `MalQuery:write` and product licensing; see [supported Falcon capabilities](../README.md#safety) for its boundaries.
See [Falcon RTR execution setup](runbook.md#falcon-rtr-execution) for history reads, profile opt-in, execution confirmation and the read-only override.
Falcon's fixed `auth status` test reports local credential resolution, so also run `artium-axi falcon-axi detection list --limit 1` after enabling and granting the tool.

#### Vectra

Obtain the deployment's HTTPS origin; see [credential editor guidance](admin-guide.md#browser-administration) for accepted input.
For QUX, select `kind=qux`, `apiVersion=2.5` and either `auth=token` with `token`, or `auth=oauth` with `clientId` and `clientSecret`.
QUX OAuth requires appliance release 9.1 or later; `applianceRelease` is optional release metadata.
For RUX, select `kind=rux`, `apiVersion=3.4`, `auth=oauth`, `clientId` and `clientSecret`; leave `applianceRelease` blank.
Create a QUX personal token under **My Profile** using a local account, or have a Vectra administrator create an OAuth API client under **Manage > API Clients** and record the displayed ID and secret.
Tokens inherit their user's rights and clients inherit their assigned role; grant read access to health and the Hosts, Accounts, Detections or other areas you need.
See [Vectra's credential issuance guidance](https://github.com/vectranetworks/vectraautomatedresponse#getting-a-vectra-api-token-for-vectra-detect-api-v2) and the pinned [Vectra configuration contract](https://github.com/knowttl/vectra-axi/tree/v0.1.9#configuration) for deployment-specific requirements.
For a credential-specific private CA, paste its PEM contents into `caBundle`; enter no server file path.
For shared trust across tools, follow the [private CA runbook](runbook.md#tls-inspection-and-private-upstream-cas).
Keep Native settings empty for read-only use; optional writes need the native operation allowlist and upstream permissions.
Save, run **Test credential**, enable and grant the tool, then run `artium-axi vectra-axi detection list --limit 1` to check the intended read domain.

#### Entra application registration for Azure and Graph

In the [Entra admin center](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app), open **App registrations > New registration** and register an application in your organization directory.
Record the **Directory (tenant) ID** as `tenantId` and **Application (client) ID** as `clientId` from Overview.
Under **Certificates & secrets**, create a client secret and copy its **Value**, not its secret ID, before leaving the page.
Alternatively upload a public certificate and retain its matching PEM private key and 64-hex-digit SHA-256 certificate thumbprint.
No interactive user login or redirect URI is needed for these hosted application credentials.
Azure RBAC roles and Graph API application permissions are separate grants; configuring one does not grant the other.
You can use separate app registrations for the two tools or enter the same approved application identity separately in each editor.

#### Azure

In the Azure portal, select each subscription or narrower resource scope, open **Access control (IAM) > Add role assignment**, select the role, and assign it to the registered application's service principal.
Have an administrator authorized to assign roles perform this step.

| Role | Use |
| --- | --- |
| `Reader` | ARM inventory and metadata at the intended subscription/resource scope. |
| `Log Analytics Reader` | Workspace query access when granting workspace-specific log reads. |
| `Storage Blob Data Reader` | Blob data-plane reads; ARM `Reader` and `Contributor` alone do not supply these. |
| `Key Vault Reader` | Secret, key and certificate metadata on RBAC-mode vaults, without secret values. |
| `AcrPull` | Registry pull/catalogue access on RBAC-only registries. Not honored on ABAC-enabled registries. |
| `Container Registry Repository Catalog Lister` | Catalogue listing on ABAC-enabled registries; lists all repositories and does not support ABAC conditions. |
| `Container Registry Repository Reader` | Image, tag and metadata reads on ABAC-enabled registries; optional ABAC conditions restrict repositories. Does not grant catalogue listing. |
| `Contributor` | Optional ARM writes at the intended scope, only when writes are wanted; this does not assign roles or grant blob/vault data-plane writes. |

Check the registry's **Settings > Properties > Role assignment permissions mode** before choosing registry roles; see [Microsoft's registry permission guidance](https://learn.microsoft.com/en-us/azure/container-registry/container-registry-rbac-abac-repository-permissions).
On ABAC-enabled registries, ARM `Reader` and `Contributor` grant control-plane access only, so assign the catalogue and repository roles above for the reads you need.
Access-policy-mode vaults require corresponding vault access policies instead of the RBAC-mode role.

At `/admin/tools/az-axi`, choose authentication and enter the source identity in the guided credential fields.
Save subscriptions and write settings separately in Native settings.
The equivalent complete replacement API input has this shape, replacing every placeholder:

```json
{
  "auth": "secret",
  "tenantId": "<directory-tenant-UUID>",
  "clientId": "<application-client-UUID>",
  "clientSecret": "<client-secret-value>",
  "subscriptions": ["<subscription-UUID>"],
  "allowWrites": false
}
```

For certificate authentication, set `auth` to `certificate` and replace `clientSecret` with `privateKey` and `thumbprintSha256`.
Optionally add `workspaces` as a JSON object mapping friendly names to Log Analytics workspace customer-ID UUIDs, obtained from the workspace Overview page; these are not ARM resource IDs.
Artium mints and injects resource-specific tokens, so supply the source identity rather than an access token or upstream token-profile JSON.
Save, run **Test credential**, enable and grant the tool, then run `artium-axi az-axi account list`.
Test each needed data-plane read separately using the enabled tool's help; a successful subscription list proves no blob, vault or registry access.
For registry catalogue access, run `artium-axi az-axi acr repository list --name <registry>`; test any needed image, tag or metadata reads separately because catalogue listing does not grant repository reads on ABAC-enabled registries.
Keep `allowWrites` false unless writes are wanted and the corresponding Azure roles are approved.

#### Microsoft Graph

On the app registration, open **API permissions > Add a permission > Microsoft Graph > Application permissions**.
Add `User.Read.All` for Artium's credential test and first user read, then have an authorized administrator [grant tenant-wide admin consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent).
Add only the application permissions for the additional command families you intend to use, and grant admin consent again after changes.
Delegated permissions and interactive `User.Read` consent do not authorize this application flow.

| Optional read area | Graph application permissions |
| --- | --- |
| Groups and memberships | `GroupMember.Read.All`; `Group.Read.All` for richer group properties, `Member.Read.Hidden` for hidden memberships. |
| Applications, service principals and application consent | `Application.Read.All` |
| Devices | `Device.Read.All` |
| Organization metadata | `Organization.Read.All` |
| Directory roles | `RoleManagement.Read.Directory` |
| Conditional Access and policy reads | `Policy.Read.All` |
| Sign-ins, directory audits and authentication registration reports | `AuditLog.Read.All`; provisioning logs also need `Directory.Read.All`. |
| Risky users and service principals | `IdentityRiskyUser.Read.All`, `IdentityRiskyServicePrincipal.Read.All`, according to the command. |
| Entitlement management | `EntitlementManagement.Read.All` |
| User authentication methods | `UserAuthenticationMethod.Read.All` |
| Access reviews | `AccessReview.Read.All` |
| Directory role eligibility and assignment schedules | `RoleEligibilitySchedule.Read.Directory`, `RoleAssignmentSchedule.Read.Directory` |
| Privileged group eligibility | `PrivilegedEligibilitySchedule.Read.AzureADGroup` |
| Cross-tenant information | `CrossTenantInformation.ReadBasic.All` |
| Certificate authentication PKI | `PublicKeyInfrastructure.Read.All` |
| Multitenant organization | `MultiTenantOrganization.ReadBasic.All` or `MultiTenantOrganization.Read.All`, according to the operation |
| Identity providers | `IdentityProvider.Read.All` |
| Lifecycle workflows | `LifecycleWorkflows.Read.All` |

For other domains, use the pinned [Graph access and licence guidance](https://github.com/knowttl/mg-axi/blob/v0.1.10/docs/graph-coverage.md) and the command's permission requirements rather than granting every permission.
Licences still apply: PIM and risk/governance features can fail despite consent, and some commands support only delegated identities.
Do not add `User.Export.All` just to make a read-only setup pass; data-policy export is a write-class permission.

In the Graph credential form, choose `mode=application`, `cloud=commercial`, `auth=client-secret`, then enter `tenantId`, `clientId` and the secret value in `clientSecret`.
For a certificate, choose `auth=certificate`, enter the PEM in `privateKey` and its SHA-256 thumbprint in `thumbprintSha256`, leaving `clientSecret` blank.
Leave `allowDeviceCode`, `preview`, `sensitiveAreas` and `writes` at their defaults for the initial read-only setup.
Save, run **Test credential**, follow the [activation requirements](admin-guide.md#browser-administration), enable and grant the tool, then run `artium-axi mg-axi entra user list --limit 1`.
Credential setup does not establish acceptance for every upstream operation.
Hosted application mode acquires tokens silently; do not run upstream `auth login` or supply `--scopes` through Artium.

#### LDAP

Artium uses the [pinned npm release](../tools/package.json) of `@knowttl/ldap-axi` with stored simple-bind credentials, encrypted by the same credential store as the other tools.
The user's ambient Kerberos ticket belongs to their local login and is unavailable inside Artium's server-side isolated runner.
Artium therefore requires `auth=simple`; it does not accept a keytab or manage Kerberos ticket acquisition and renewal.
This keeps the directory identity explicit and its password rotation within the existing credential replacement flow.
The native Kerberos provider and its installation script are unnecessary for this authentication mode and remain disabled.

Obtain a dedicated directory identity with read access only, its bind DN and password, and a directory URL whose certificate can be verified.
At `/admin/tools/ldap-axi`, enter `url`, choose `auth=simple`, and enter `bindDn` and the password value in `bindPassword`.
Use `ldaps://<directory-host>:636` with `startTls` left at the default (unset) or explicitly `false`, or `ldap://<directory-host>:389` with `startTls=true`.
Saving an `ldaps://` URL with `startTls=true` is rejected with `INVALID_INPUT` and the message `startTls must be false for this URL.`
Plaintext simple bind, anonymous authentication, disabled certificate verification and caller-supplied connection or credential overrides are refused.
For a credential-specific private CA, supply its PEM contents in `caFile`, not a server file path.
For shared trust across tools, follow the [private CA runbook](runbook.md#tls-inspection-and-private-upstream-cas).
The multi-line `caFile` editor preserves newlines through saving and private CA file materialization for each call.
Artium's CLI has no credential-save command.
Optional `base` limits the search context; otherwise the pinned tool discovers the directory's default naming context.
Optional `pageSize` is an integer from 1 to 1000, and `tlsMaxVersion=1.2` supports TLS 1.2-only endpoints while retaining verification.

Enter the password itself in the form, never a SecretRef or password-file path.
Save, run **Test credential**, enable the tool, grant it to a role, then run `artium-axi ldap-axi user list --limit 1` to check directory read permissions.
**Test credential** runs `auth status`, which performs one bind; failed credentials can count toward directory account lockout limits.
LDAP is read-only by design and has no editable native write settings.
LDAP 0.2.0 adds `computer list`, `computer show <identifier-or-dn>` and `server` reads through the same managed identity.
Computer reads use AD machine accounts or the upstream's stated LDAPv3 device fallback; `server` reports advertised rootDSE capabilities and limits.
The [LDAP inventory](../tools/inventories/ldap-axi.json) owns the supported commands, blocked overrides and resource requirements.
Local fake-directory and offline profile checks do not establish live directory acceptance.

#### Azure DevOps

Artium uses the [pinned](../tools/package.json) `@jeffreyhaen/ado-axi` release without upstream modifications.
At `/admin/tools/ado-axi`, enter `org`, optional `project`, choose `auth=pat`, and paste the PAT itself into `token`.
Organization-root URLs such as `https://dev.azure.com/<org>` and `https://<org>.visualstudio.com` normalize to the organization name.
Artium encrypts the PAT in its credential store and injects it through a private per-call profile and environment variable.
Do not enter a SecretRef or environment-variable name.
Create a dedicated PAT scoped to the organization with Work Items, Code and Build read permissions as needed for the commands you use.
Grant corresponding read-write permissions only for intended mutations; a write switch never grants Azure DevOps permissions.
For service principal authentication, choose `auth=client-secret` and enter `tenantId`, `clientId` and `clientSecret` instead of `token`.
Add the service principal as a user in the Azure DevOps organization, in the organization's Entra tenant, and grant the required project permissions before testing.
Artium acquires and caches an Azure DevOps access token with client credentials and supplies it through a restricted per-call `az` stand-in.
The stand-in answers only the pinned tool's Azure DevOps token request; no Azure CLI sign-in or device flow is used.
Save, run **Test credential**, enable the tool, grant it to a role, then run `artium-axi ado-axi project list --limit 1`.

Writes are off by default; follow [write-access administration](runbook.md#roles-credentials-and-health) to enable them.
Artium classifies every command using the reviewed [ADO inventory](../tools/inventories/ado-axi.json), which binds the routing review to upstream source digests.
Artium manages `--org`, `--profile` and `--config`; those overrides and the top-level `config` and `update` commands are refused.
Use `--project` to select another project within the managed organization.
The `api` command accepts relative paths and GET only, even when writes are enabled; body flags and absolute URLs are refused.
All commands refuse repeated flags, stdin and files.
Use `pipeline watch --timeout 50` or less to stay within the runner's call timeout.
Writes are journaled by Artium only; see [audit action classification](admin-guide.md#audit-screen-and-api).
For an interrupted write, run the returned read-back command and follow its inspection guidance before retrying.
Local fake-service checks do not establish live organization acceptance.

#### AWX

Artium bundles the [pinned](../tools/package.json) `awx-axi` package without upstream modifications.
At `/admin/tools/awx-axi`, enter the controller HTTPS `origin`.
Paste an existing personal access token into `token`, or choose password sign-in and enter a username and password.
Follow the [runbook password sign-in flow](runbook.md#roles-credentials-and-health).
See the [hosted credential contract](credential-standard.md#per-tool-host-facing-schemas) for token exchange, password handling and controllers with basic authentication disabled.
Enter the token itself, never a SecretRef, environment-variable name or file path.
Artium encrypts the token and injects a SecretRef through its private per-call profile.
Save, run **Test credential**, enable the tool and grant it to a role, then run `artium-axi awx-axi job list --limit 1`.
**Test credential** reads one job using the managed token and reports structured authentication, network and TLS diagnostics.
For private certificates and rotation, follow the [credential trust runbook](runbook.md#trusting-one-tool-from-the-administration-ui).
HTTP and TLS-verification bypasses are refused.

Writes are off by default.
The native setting `{"allowWrites": true}` permits only operational writes, which still require upstream `--confirm`: launching, canceling or relaunching runs, approving or denying workflow approvals, project and inventory-source syncs, and notification-template tests.
Configuration writes, deletes and security writes are always blocked, including resource creation and editing, associations, role grants and token operations.
Artium never enables AWX's separate configuration, deletion or security write gates.
Token permissions remain an additional AWX-side limit; the write switch does not grant AWX permissions.
The generated [AWX inventory](../tools/inventories/awx-axi.json) classifies every command and records the reviewed upstream source digests.
Artium manages origin, TLS and credential selectors, and refuses standalone auth login/logout, setup, config, profile and update commands.
Stdin, file uploads, server file paths and `@file` values are unsupported; use inline non-secret launch parameters.
Use `job watch --timeout 50` or less to stay within the runner timeout.
For an interrupted write, inspect current state using the returned read-back guidance before retrying.
Local fake-service checks do not establish live controller acceptance.

#### Hybrid Analysis

Artium bundles `@knowttl/hybrid-axi` at the [reviewed package pin](../tools/package.json).
At `/admin/tools/hybrid-axi`, enter the API key itself into `apiKey`, never a SecretRef or file path.
The origin is fixed to `https://hybrid-analysis.com`; the published CLI sends the secret only in its `api-key` header.
Artium encrypts the key and supplies an environment SecretRef through its private per-call profile.
Save, run **Test credential**, enable the tool and grant it to a role, then run `artium-axi hybrid-axi quota`.
The credential test reads key level and submission quota; it does not prove permission for other resources.
Structured 403 failures preserve upstream key-level guidance and never become empty results.

Review the [Hybrid Analysis capability boundary](../README.md#safety) before enabling operations, including its quick-scan exception, community visibility, consuming-match recovery and deferred hosted downloads.
The [inventory](../tools/inventories/hybrid-axi.json) owns supported operation names and reviewed command/source digests.
See [client input handling](client-reference.md#command-surface-and-subcommands) for local uploads and explicit JSON stdin, and the [shared API contract](../src/shared/api.ts) for bounded input.
Local fake-service checks do not establish live service acceptance.
