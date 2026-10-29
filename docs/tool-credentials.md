# Tool credentials

## BeyondTrust PM Cloud

The package profile schema captured in the [reviewed inventory](../tools/inventories/beyondtrust-axi.json) owns the managed fields; [tools/package.json](../tools/package.json) owns the exact package pin.
Create an Endpoint Privilege Management API account and grant only the required API areas.
Save host (for example `example.pm.beyondtrustcloud.com`), clientId and clientSecret through the administrator credential form.
The host must be lowercase DNS ending in .beyondtrustcloud.com, without scheme, port, path or userinfo; requests use verified HTTPS.
The secret is encrypted at rest and supplied through a private environment reference, never argv.
The credential test runs doctor with a bounded About read.
A token 404 reports AUTH_ENDPOINT_NOT_FOUND and hints at the documented -services host form; the tool never switches hosts automatically.

Enable exact writes.operations through Write access and review the [supported capability boundary](safety.md#beyondtrust-endpoint-privilege-management) before enabling writes or deletes.
The advanced settings editor accepts the same writes object; downloads.allow is host-owned and cannot enable ordinary downloads.
See [BeyondTrust client usage](client-reference.md#beyondtrust-pm-cloud) for authenticated downloads.
Live authentication, permissions and every API operation remain subject to owner commissioning after offline build.


Contents:

- [Check Point Email Security](#check-point-email-security)
- [Tenable One](#tenable-one)
- [Falcon](#falcon)
- [Vectra](#vectra)
- [Entra application registration for Azure and Graph](#entra-application-registration-for-azure-and-graph)
- [Azure](#azure)
- [Microsoft Graph](#microsoft-graph)
- [LDAP](#ldap)
- [Azure DevOps](#azure-devops)
- [GitHub](#github)
- [AWX](#awx)
- [Hybrid Analysis](#hybrid-analysis)

Configure only the tools you intend to use.
At `/admin/tools`, open the tool, save its credential, then use **Test credential** and follow the [activation requirements](admin-guide.md#browser-administration) before enabling it.
The [credential standard](credential-standard.md#9-hosted-contract-artium-axi) owns profile injection and secret handling; [browser administration](admin-guide.md#browser-administration) explains editor inputs, saving and health behavior.

| Tool | Information to obtain | Fixed Artium credential test |
| --- | --- | --- |
| Falcon (`falcon-axi`) | Falcon API client ID, client secret, cloud region, optional Flight Control member CID. | `auth status`, followed by a permitted detection read to confirm API access. |
| Vectra (`vectra-axi`) | HTTPS origin, QUX/RUX deployment kind and API version, personal token or OAuth client ID and secret, optional private CA PEM. | `health list`; grant access to health reads as well as your intended data. |
| Azure (`az-axi`) | Entra tenant ID, application client ID, client secret or certificate private key and SHA-256 thumbprint, subscription IDs and optional workspace mapping. | `account list`; data-plane roles need their own permitted reads. |
| Microsoft Graph (`mg-axi`) | Entra tenant ID, application client ID, client secret or certificate private key and SHA-256 thumbprint, administrator-consented Entra Graph permissions; optional scoped Exchange mail roles. | `entra user list --limit 1`; cannot check mail permissions or Exchange scope. |
| LDAP (`ldap-axi`) | Verified LDAPS or StartTLS URL, read-only bind identity and password, optional search base and private CA PEM. | `auth status`; binds once and reports the selected identity. |
| Azure DevOps (`ado-axi`) | Organization, optional default project and either a PAT or tenant ID, client ID and client secret. | `project list --limit 1`. |
| GitHub (`gh-axi`) | GitHub HTTPS origin and one shared PAT, device-flow OAuth token or GitHub App installation credential. | `api /rate_limit`. |
| AWX (`awx-axi`) | Controller HTTPS origin and either an existing personal access token or a username and password used once to mint one. | `job list --limit 1`; job read permissions are required. |
| Tenable One (`tenable-axi`) | Access key and secret key; the origin is fixed to `https://cloud.tenable.com`. | `card list --limit 1`; exposure-view read access is required. |
| Check Point Email Security (`checkpoint-axi`) | Region, client ID, client secret, optional SaaS and scope. | `doctor`; regional authentication and one bounded email search. |

#### Check Point Email Security

At `/admin/tools/checkpoint-axi`, enter `region`, `clientId` and the secret value in `clientSecret`.
Regions are `us`, `eu`, `ca`, `au`, `uk`, `uae` and `in`; the pinned package owns their fixed HTTPS origins.
The credential schema captured in the [reviewed inventory](../tools/inventories/checkpoint-axi.json) supplies the managed form and validation; Artium injects the encrypted secret through a private environment SecretRef.
No credentials belong in arguments or output.
The optional `saas` defaults upstream to `office365_emails`; `scope` is required for email download and used for attachment download authorization.
Each hosted invocation exchanges a token again because its private XDG directory is removed after execution.

Save the credential, test it, enable the tool and grant it to a role.
The credential test runs `doctor`, which authenticates and performs one bounded email search without printing tenant data.
Local fake-only evidence does not establish live permissions or response contracts.
The owner commissions all capabilities together through Artium after the build, including token shape/lifetime, permissions, scopes and email/ZIP hash availability.
`AUTH_SHAPE_UNVERIFIED` requires owner commissioning; it is not an empty result or a successful credential test.

Every write and download defaults off behind the administrator write switch and exact operation allow-list.
The [reviewed inventory](../tools/inventories/checkpoint-axi.json) owns static operation IDs.
For an event action offered by `event show`, add its exact `event.action.<name>` entry through native settings or the write-access API; wildcards are refused.
Parameterized event actions remain unverified.
Email and exception writes retain native preview, `--execute`, exact `--confirm`, durable intent and read-back reconciliation.
Exception create/update uploads a private JSON file with `--input`; updates replace documented fields, and stdin/server paths are unavailable.
Malware, URL and DLP remove/clear and click-time clear remain unavailable pending endpoint commissioning, regardless of administrator settings.
Unknown outcomes require read-only reconciliation rather than replay.

Select `email.download`, `attachment.download` and `attachment.download-all` independently to enable [hosted saving](client-reference.md#check-point-email-and-attachment-saving).
The adapter enables native `downloads.allow` only for an authenticated transfer after current policy checks; a stored profile field cannot enable ordinary tool-run downloads.
Downloads use host-owned confirmation and evidence because the published native downloader has no preview or write journal.
Missing or mismatched upstream SHA-256 fails closed; attachment ZIP HTTP 200 can contain only some attachments.

#### Tenable One

At `/admin/tools/tenable-axi`, enter `accessKey` and `secretKey` in the secret fields.
The origin is fixed to `https://cloud.tenable.com`; both keys are stored encrypted and injected as private SecretRefs.
The credential test runs `card list --limit 1`; the identity needs exposure-view read access.
Other investigation commands need the corresponding upstream permissions.
Writes stay off until an administrator enables the tool's write switch and selects supported operation IDs.
Business writes and export-job creation retain the native preview, `--execute`, exact preview `--confirm` and durable journal gates.
Unknown write outcomes must be reconciled using the native audit ID and read-back guidance, never replayed blindly.
See [client input handling](client-reference.md#command-surface-and-subcommands) for Tenable uploads and explicit stdin.
Server paths, local configuration, hooks and export downloads are blocked.
Export-job status remains available through the managed CLI.

#### Falcon

In the Falcon console, open **Support and resources > API clients and keys** and create a dedicated API client.
Copy its client ID and secret and record its cloud region: `us-1`, `us-2`, `eu-1` or `us-gov-1`.
At `/admin/tools/falcon-axi`, enter `clientId`, `clientSecret` and `region`, with `memberCid` only when targeting a Flight Control member tenant.
Grant `Alerts:read` for detection reads, including the first-call example.
Grant additional scopes only for the domains you use, following the pinned [API client permission matrix](https://github.com/knowttl/falcon-axi/blob/v0.8.1/README.md#api-client-permissions) and its offline `scopes` command.
For example, account reads need `Assets:read`, while CVE reads need `Vulnerabilities (Falcon Intelligence):read`, distinct from Spotlight vulnerability access.
NG-SIEM search requires `NGSIEM:write`; Identity Protection directory/timeline queries require `Identity Protection GraphQL:write` plus the documented read scopes, even though those queries read data.
These are optional domain requirements and do not justify granting other write or response scopes.
The pinned tool does not change hosts, detections, policies or identities and exposes no arbitrary REST or GraphQL requests.
The fixed `host usb` search requires `NGSIEM:write`; see [Falcon execution setup](runbook.md#falcon-rtr-execution) for its host capability gate.
MalQuery metadata, quota and request-status reads require `MalQuery:read`.
MalQuery search requires `MalQuery:write` and product licensing; see [supported Falcon capabilities](safety.md) for its boundaries.
See [Falcon RTR execution setup](runbook.md#falcon-rtr-execution) for history reads, profile opt-in, execution confirmation and the read-only override.
Falcon's fixed `auth status` test reports local credential resolution, so also run `artium-axi falcon-axi detection list --limit 1` after enabling and granting the tool.

#### Vectra

Obtain the deployment's HTTPS origin; see [credential editor guidance](admin-guide.md#browser-administration) for accepted input.
For QUX, select `kind=qux`, `apiVersion=2.5` and either `auth=token` with `token`, or `auth=oauth` with `clientId` and `clientSecret`.
QUX OAuth requires appliance release 9.1 or later; `applianceRelease` is optional release metadata.
For RUX, select `kind=rux`, `apiVersion=3.4`, `auth=oauth`, `clientId` and `clientSecret`; leave `applianceRelease` blank.
Create a QUX personal token under **My Profile** using a local account, or have a Vectra administrator create an OAuth API client under **Manage > API Clients** and record the displayed ID and secret.
Tokens inherit their user's rights and clients inherit their assigned role; grant read access to health and the Hosts, Accounts, Detections or other areas you need.
See [Vectra's credential issuance guidance](https://github.com/vectranetworks/vectraautomatedresponse#getting-a-vectra-api-token-for-vectra-detect-api-v2) and the pinned [Vectra configuration contract](https://github.com/knowttl/vectra-axi/tree/v0.1.11#configuration) for deployment-specific requirements.
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
For command families other than mail, add only the application permissions you intend to use, and grant admin consent again after changes.
Mailbox authorization uses the scoped Exchange roles below instead of Entra mail application grants.
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

For other domains, use the pinned [Graph access and licence guidance](https://github.com/knowttl/mg-axi/blob/v0.1.17/docs/graph-coverage.md) and the command's permission requirements rather than granting every permission.

For mailbox opt-in, supported reads and writes, and mailbox selectors, see the [managed capability boundary](safety.md).
Grant no `Mail.*` or `MailboxSettings.*` application permissions in Entra: those grants combine with Exchange permissions and bypass the mailbox scope.
Keep `User.Read.All` for the credential test, which cannot verify mail authorization or scope.

| Mail operations | Scoped Exchange RBAC role |
| --- | --- |
| Folders, message lists, search, filters, conversations | Application Mail.ReadBasic |
| Message bodies, headers, attachment metadata, attachment saving and MIME export | Application Mail.Read |
| Mailbox settings, inbox rules and master categories | Application MailboxSettings.Read |
| Message and folder writes | Application Mail.ReadWrite |
| Rule and category writes | Application MailboxSettings.ReadWrite |

An Exchange administrator registers the application's service principal in Exchange Online, creates a management scope whose `MemberOfGroup` filter selects an owner-chosen mail-enabled group, then assigns only the required application roles to that service principal with that resource scope.
Use `New-ServicePrincipal`, `New-ManagementScope` and `New-ManagementRoleAssignment` following Microsoft's [RBAC for Applications procedure](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac).
Use the Enterprise application's service-principal object ID when registering it in Exchange, and confirm the group contains only the intended mailboxes.
Check an included and an excluded synthetic mailbox with `Test-ServicePrincipalAuthorization`; it bypasses the authorization cache, while runtime permission changes may take 30 minutes to two hours.
Do not create Application Access Policies, which RBAC for Applications replaces.
Live authorization and scope acceptance remain unverified by offline checks.
Licences still apply: PIM and risk/governance features can fail despite consent, and some commands support only delegated identities.
Do not add `User.Export.All` just to make a read-only setup pass; data-policy export is a write-class permission.

In the Graph credential form, choose `mode=application`, `cloud=commercial`, `auth=client-secret`, then enter `tenantId`, `clientId` and the secret value in `clientSecret`.
Profiles without `entra` are refused so existing Entra reads and credential tests remain available; see the [managed capability boundary](safety.md) for pack selection and Defender XDR hunting.
The app registration used by Artium requires `ThreatHunting.Read.All` with administrator consent; tenant acceptance remains unverified.
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

#### GitHub

Artium bundles unmodified published gh-axi and GitHub CLI releases, pinned in [tools/package.json](../tools/package.json) and [gh-source.json](../tools/gh-source.json).
At `/admin/tools/gh-axi`, set `origin` to `https://github.com`, your `https://SUBDOMAIN.ghe.com` origin or your GHES HTTPS origin, choose `auth=token`, and paste the PAT into `token`.
One encrypted, admin-set credential is shared by every user granted this tool; upstream attribution and rate limits belong to that identity.
Use a dedicated machine account and follow the [credential rotation procedure](runbook.md#roles-credentials-and-health) when replacing its PAT.
Tokens only reach children through private environment injection and are scanned for output disclosure.
The admin API never returns the token.

Classic PAT setup uses `repo`, `read:org`, `gist`, `workflow` and `project` scopes so the planned operation set can work when enabled in later slices.
Classic `repo` scope grants upstream write access even though Artium currently blocks all writes.
Prefer a fine-grained PAT restricted to selected repositories and the corresponding contents, issues, pull requests, actions, discussions and projects permissions.
Fine-grained tokens cannot access every classic-token feature; permission failures are errors, never empty results.
Organization approval, SSO authorization and GHES token support depend on upstream policy and version.
See GitHub's [PAT guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

For a shared bot identity, choose `auth=github-app` instead, enter your numeric `appId` and `installationId`, and paste the App's RSA PEM `privateKey`.
Register and install your own GitHub App on the managed host, selecting only the repositories and permissions it needs.
The key is encrypted in the credential store and never returned by the admin API or passed to gh; the output secret scanner covers both the key and minted tokens.
Artium signs a short-lived RS256 JWT and requests an [installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app) before a call.
Concurrent calls share an in-memory token cache keyed by credential identity, revision, grant selection and trust; cached tokens are reused until five minutes before the provider expiry or the one-hour lifetime cap, whichever comes first.
Saving or rotating the credential discards cached tokens; no installation token is persisted.
Optional `repositories` (repository names, up to 500) and `permissions` (a JSON map such as `{"contents":"read","issues":"read"}`) narrow the installation grant, never expand it.
GitHub rejects requests for repositories or permissions outside that installation; Artium never retries with a broader grant or another authentication method.
Omitting those fields uses the installation's existing selection and permissions.
For the planned read/write operation set, configure the App's corresponding contents, issues, pull requests, actions, discussions, projects and workflows permissions, with organization members read access where needed.
Artium's exact-operation write policy still applies even when the App has upstream write permissions.
Installation tokens act as the App bot and cannot use gists or user-only endpoints such as notifications; not every gh command supports installation authentication.
Those commands fail rather than falling back to a PAT.
To rotate, save a newly generated private key for the same App, test the credential, then revoke the old key in the App settings.
Changing the App or installation ID requires entering its key again.

Save, run **Test credential**, enable the tool and grant it to a role.
Try `artium-axi gh-axi repo list --limit 1`, then `artium-axi gh-axi issue list -R OWNER/NAME --limit 10`.
See the [supported GitHub boundary](safety.md) for repository selection, dashboard limitations and blocked operations.
The [reviewed inventory](../tools/inventories/gh-axi.json) owns the command allow-list, write tiers and upstream source digests.
`api` accepts `[GET] <relative-path>` with optional output shaping; GraphQL, other methods, request fields, headers and input bodies are refused.

GitHub writes default off.
An administrator enables exact operations under **Write access**, persisted as `{"writes":{"allowWrites":true,"operations":["issue comment"]}}` in native settings.
The collaboration and repository tiers describe capabilities; selecting one operation never enables its siblings.
For exact operation names and tier membership, use the `effect: "write"` command entries and their `tier` fields in the [reviewed inventory](../tools/inventories/gh-axi.json).

Issue lock/unlock is unsupported because pinned gh-axi 0.1.44 requests the `locked` issue field, which gh 2.103.3 does not export.
A compatible published upstream release is required before these operations can be enabled.
Repository creation requires an explicit `OWNER/NAME`; unqualified and host-qualified names are refused.
Repository visibility changes are unavailable.
PR merge uses `--method merge|squash|rebase`; release create/edit uses `--notes` for inline release notes.
Every project write requires `--owner OWNER` so recovery checks inspect the intended user's or organization's projects.
For `project item-edit`, Artium uses this owner for confirmation and recovery; the mutation itself selects the item by ID.

Artium owns write preview and confirmation because upstream gh-axi has neither.
Run the intended command without `--confirm` to obtain a preview without starting gh-axi or minting an installation token.
Review the request, then repeat its exact arguments and stdin with `--confirm <returned-value>`.
Confirmation binds normalized arguments, recovery scope, input, credential identity/revision and write settings; changing any requires a fresh preview.
For example, preview `artium-axi gh-axi issue comment 42 -R OWNER/NAME --body "Reviewed comment"`, then repeat it with the returned confirmation.
Keep the command before its flags.
PR creation requires explicit title, body, base and head branches; local git sources remain unavailable.
Release creation accepts no asset paths.
Gist creation requires `--public` or `--secret`, a `--filename` and piped content; a secret gist is unlisted, not private.
Gist edits accept inline descriptions or piped replacement content with `--filename`; local paths and file removal stay blocked.
Workflow `--field name=value` supports literal values; `@file` values are refused.
Deletes, `secret set`, `pr merge --admin`, `--delete-branch` and `api` non-GET remain refused for everyone.
An interrupted write or an ambiguous command failure, including a failed post-write read-back, returns `UNKNOWN_OUTCOME` with a scoped read-back command and is never automatically retried.
Known pre-mutation refusals retain their ordinary errors.
After `UNKNOWN_OUTCOME`, never retry blindly: execute the provided read-back command, inspect all relevant pages and reconcile GitHub audit evidence.
For project item edits, identify the project from the returned owner-scoped project list, then inspect its item list with the same owner; absence from a limited page does not establish failure.
For audit classification, see the [audit guide](admin-guide.md#audit-screen-and-api).
GitHub audit arguments redact titles, bodies, field values, search queries and confirmation values while retaining the command, repository and resource number.

GitHub.com and `*.ghe.com` use `GH_TOKEN`; GHES uses `GH_ENTERPRISE_TOKEN`, always with the managed host.
Callers cannot override the host or credential.
GitHub CLI telemetry, prompts and update notifications are disabled.
For private CAs, follow the [GitHub certificate trust exception](runbook.md#trusting-one-tool-from-the-administration-ui).

See the [supported GitHub boundary](safety.md) for why SSH keys are out of scope.
For device flow, open **Connect with GitHub** on `/admin/tools/gh-axi`, enter the HTTPS origin and confirm your admin identity when prompted.
Artium uses GitHub CLI's public OAuth client ID `178c6fc778ccc68e1d6a`, without a client secret or app registration, and requests `repo read:org gist workflow project`.
Enter only the code displayed by your own connection at the displayed GitHub verification URL.
The page shows the countdown, waits for approval, honours GitHub's polling interval and `slow_down`, and offers cancellation.
Denied, expired or unsupported flows require a new connection; GHES must support device flow for its GitHub CLI app, otherwise use a PAT or GitHub App.
Pending codes live only in server memory and disappear on restart; leaving the page stops polling.
Starting another connection replaces the deployment's pending connection.
The previous saved credential remains until authorization succeeds; concurrent credential or settings changes prevent stale approval from overwriting them.
On success Artium verifies the connected account, replaces the encrypted credential as a new revision, records a credential change without secrets, and requests the [post-connection health check](runbook.md#roles-credentials-and-health).
The connected account login is displayed, and the token is never returned to the browser or accepted through the ordinary credential editor.

These are **non-expiring OAuth tokens** appearing as **GitHub CLI** in GitHub Settings, Applications, Authorized OAuth Apps and organization OAuth policies.
Organizations restricting OAuth apps must approve GitHub CLI.
The broad scopes permit upstream writes even while Artium writes are off.
Use a dedicated machine account: these tokens share GitHub CLI's per-user/app/scope token budget with that account's other CLI logins, and GitHub can revoke old or inactive tokens.
Store and rotate them like every other secret: choose **Reconnect with GitHub**, test the replacement, and revoke the old authorization in the account's GitHub settings when it is no longer needed.
Revoking GitHub CLI's authorization can affect that account's other CLI sessions too.
No refresh token is stored and no refresh code runs.
If a provider returns `expires_in`, Artium records the expiry and refuses calls at that time with `CREDENTIAL_EXPIRED`.
Revoked device-token authentication failures also return `CREDENTIAL_EXPIRED`; credential checks record this error and the tool page asks the administrator to reconnect.
Permission failures remain permission errors rather than expired-credential errors.
See GitHub's [device-flow protocol](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow).

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

Review the [Hybrid Analysis capability boundary](safety.md) before enabling operations.
The [inventory](../tools/inventories/hybrid-axi.json) owns supported operation names and reviewed command/source digests.
See [client input handling](client-reference.md#command-surface-and-subcommands) for local uploads and explicit JSON stdin, and the [shared API contract](../src/shared/api.ts) for bounded input.
Local fake-service checks do not establish live service acceptance.
