<h1 align="center">artium-axi</h1>

<p align="center">
  <img alt="Status" src="https://img.shields.io/badge/status-under%20construction-orange?style=flat-square" />
  <img alt="Verified platform" src="https://img.shields.io/badge/verified%20platform-Linux-blue?style=flat-square" />
  <a href="https://github.com/kunchenguid/axi"><img alt="AXI" src="https://img.shields.io/badge/AXI-Agent%20eXperience%20Interface-green?style=flat-square" /></a>
</p>

Managed command-line tools for agents, behind one artium sign-in.

artium-axi packages a server and CLI that give users role-based access to pinned upstream tools.
The published Graph and Azure releases in [the upstream pins](tools/package.json) include their upstream live-test fixes.
Administrators manage accounts, roles, encrypted service credentials and audit records through a browser.
The client follows AXI (Agent eXperience Interface) conventions for discovery, help and structured errors.

**Status: under construction.**
Falcon, Vectra, Azure, Graph and LDAP are wired into the production server entry point.
See the [evidence ledger](docs/evidence-ledger.md) for the acceptance boundaries.

## Agent Ergonomics

- Running without arguments shows identity, roles, available tools, cached health and pinned versions.
- Tool lists use a compact `name`, `status`, `version` schema and suggest a detail view and first call.
- Empty lists explain why no enabled tool is available and direct you to an administrator.
- Local help works before sign-in and includes usage, purpose, flags and an example.
- Artium errors use TOON on stdout; upstream calls preserve separate stdout, stderr and exit status.
- Embedded skills support Claude Code, Codex and OpenCode, with an optional Claude Code session hook.

## Quick Start

For a new server, follow [Set up a host](#set-up-a-host) first.
For an existing server, obtain its trusted HTTPS URL and an account from its administrator, then continue below.
The Linux client requires Node **24.11 or later**, curl and sha256sum on `PATH`.
Windows and macOS execution, token storage and actual agent host loading remain unverified.

### Download and first call

Set the trusted HTTPS server URL before downloading:

```sh
export ARTIUM_AXI_URL='https://artium.example.com'
```

For a private CA, set `ARTIUM_AXI_CA_FILE` to its readable PEM file and add `--cacert "$ARTIUM_AXI_CA_FILE"` to **both** curl commands below.
Keep certificate verification enabled.
The bundle and checksum must come from the trusted server; the checksum detects corruption and mixed releases, not an untrusted server.

```sh
mkdir -p "$HOME/.local/bin"
cd "$HOME/.local/bin"
curl --fail --output artium-axi.mjs "$ARTIUM_AXI_URL/cli/artium-axi.mjs" &&
curl --fail --output artium-axi.mjs.sha256 "$ARTIUM_AXI_URL/cli/artium-axi.mjs.sha256" &&
sha256sum --check artium-axi.mjs.sha256 &&
mv artium-axi.mjs artium-axi &&
chmod 755 artium-axi &&
rm artium-axi.mjs.sha256
export PATH="$HOME/.local/bin:$PATH"
```

**Stop if either download or checksum verification fails.**
Do not launch the downloaded file after a failure.
The executable is a standalone Node bundle; it needs no npm install or sibling assets.

For an SSO account, follow [CLI SSO sign-in](#sign-in-settings), then continue with tool discovery below.
For a local account, sign in using the hidden terminal password prompt, replacing the synthetic username with your account:

```sh
artium-axi login --username synthetic-user
```

If login reports `PASSWORD_CHANGE_REQUIRED`, change the temporary password and sign in again:

```sh
artium-axi passwd
artium-axi login --username synthetic-user
```

Discover the tools granted to your account:

```sh
artium-axi
artium-axi tools
artium-axi tools show falcon-axi
artium-axi falcon-axi detection list
```

The Falcon example requires an enabled Falcon tool and a role granting access to it.
Choose your first call from the example shown for an available tool.

### Skill installation

Install the embedded skill after downloading the client:

```sh
artium-axi setup --host claude --hook
```

Use `--host codex` or `--host opencode` without `--hook` for those hosts.
Setup always installs the skill; only Claude Code supports the optional `SessionStart` hook, which runs `tools` to supply session context.
Unsupported hosts or hooks are refused before files are written.

Setup preserves unrelated settings and hooks and leaves unchanged managed files alone.
It refuses to replace an edited or unmanaged skill unless `--force` is explicit.
Keep the bundle at its installed path; rerun setup if it moves so recorded invocations are repaired.
Actual host loading and hook usefulness require separate acceptance.

## Other ways to install

### Set up a host

Give the setup agent the Linux host access, intended HTTPS hostname, DNS and certificate provisioning method, private CA bundle if applicable, and the protected data and backup locations.
Also supply the first administrator's username and temporary password through protected input, a master-key custody decision, and credentials for each tool you want enabled from [Tool credentials](#tool-credentials).
Upstream accounts are shared server-side service identities; users sign in with their own [artium accounts](#sign-in-settings).

1. **Prepare the host.**
   Install Git and Docker with Compose and reserve HTTPS port 443 for the reverse proxy.
   The image supplies Node, Python and the pinned tools; see [Build from source](#build-from-source) for the source toolchain.
   Allow package and image downloads during the build and runtime access to the enabled tools' upstream APIs and identity endpoints.
   See [runbook prerequisites](docs/runbook.md#scope-and-prerequisites) for the runtime limits, writable data directory and UID 10001 ownership, including rootless UID mapping.

2. **Obtain the source and build the image.**
   Run from the checkout root:

   ```sh
   git clone https://github.com/knowttl/artium-axi.git
   cd artium-axi
   docker compose -f compose.example.yaml build
   ```

   Record the resulting immutable image identity for backups and rollback as described in the [runbook](docs/runbook.md#backup-restore-and-upgrade-rollback).

3. **Prepare the master key and bootstrap administrator before starting.**
   Place an owner-generated cryptographically random key containing exactly 32 raw bytes at `private/artium_master_key` and the temporary administrator password at `private/artium_bootstrap_password`, with no added newline.
   Use the [password rules](#security-and-acceptance-boundaries) and [key custody guidance](docs/runbook.md#backup-restore-and-upgrade-rollback).
   Follow the [secret ownership instructions](docs/runbook.md#scope-and-prerequisites) so both files are readable by container UID 10001 and protected from other users.
   In [compose.example.yaml](compose.example.yaml), uncomment both first-start environment settings and both bootstrap-password secret entries, replacing `synthetic-admin` with your chosen username.
   The master key alone cannot bootstrap a new store.
   See [first-administrator setup](docs/runbook.md#first-administrator-and-offline-recovery) for the empty-store requirement and startup refusals.

4. **Configure HTTPS.**
   Follow the [runbook proxy example](docs/runbook.md#proxy-and-certificate-trust), including its static proxy IP, matching `ARTIUM_AXI_TRUSTED_PROXIES`, TLS mounts and forwarding-header replacement.
   Save your Compose override as `compose.proxy.yaml` and provision its nginx configuration and certificates before starting.
   Keep the HTTP listener inaccessible to clients and select an unused proxy subnet.

5. **Start and check the server.**
   With that override prepared, run:

   ```sh
   docker compose -f compose.example.yaml -f compose.proxy.yaml config --quiet
   docker compose -f compose.example.yaml -f compose.proxy.yaml up -d
   docker compose -f compose.example.yaml -f compose.proxy.yaml ps
   ```

   Require a healthy Artium service, then set `ARTIUM_AXI_URL` to the trusted HTTPS origin and run the [HTTPS liveness and readiness checks](docs/runbook.md#roles-credentials-and-health).
   Both checks must return `status: ok`; they check the local server, not upstream credentials.
   If startup fails, inspect service logs and resolve the reported configuration or store error before continuing.

6. **Complete the first login.**
   Open `https://<your-artium-host>/login`, enter the bootstrap account, change its temporary password at `/password`, and sign in again.
   Remove the first-start environment settings and bootstrap-password secret entries from Compose after the administrator is created, remove the bootstrap-password file from its provisioning location, and recreate the service with the same `up -d` command.
   Keep the master-key file and persistent data volume for subsequent starts.
   Startup also saves the key beside the database, so protect the entire data volume as explained in [server custody](#server-settings-and-custody).

7. **Configure tools and user access.**
   Follow [Tool credentials](#tool-credentials) to save and test each credential, then follow the [activation requirements](#browser-administration) before enabling the tool at `/admin/tools`.
   Create a role at `/admin/roles`, grant it the enabled tools, create local users at `/admin`, and assign that role to them.
   Assign a tool role to your administrator too if that account will run CLI calls; administrator capability alone grants no tool access.
   Finish with [Download and first call](#download-and-first-call) and [Skill installation](#skill-installation) on each agent host.

Recovery, rotation, backups, retention and upgrades remain in the [operations runbook](docs/runbook.md).

### Tool credentials

Configure only the tools you intend to use.
At `/admin/tools`, open the tool, save its credential, then use **Test credential** and follow the [activation requirements](#browser-administration) before enabling it.
The [credential standard](docs/credential-standard.md#9-hosted-contract-artium-axi) owns profile injection and secret handling; [browser administration](#browser-administration) explains editor inputs, saving and health behavior.

| Tool | Information to obtain | Fixed Artium credential test |
| --- | --- | --- |
| Falcon (`falcon-axi`) | Falcon API client ID, client secret, cloud region, optional Flight Control member CID. | `auth status`, followed by a permitted detection read to confirm API access. |
| Vectra (`vectra-axi`) | HTTPS origin, QUX/RUX deployment kind and API version, personal token or OAuth client ID and secret, optional private CA PEM. | `health list`; grant access to health reads as well as your intended data. |
| Azure (`az-axi`) | Entra tenant ID, application client ID, client secret or certificate private key and SHA-256 thumbprint, subscription IDs and optional workspace mapping. | `account list`; data-plane roles need their own permitted reads. |
| Microsoft Graph (`mg-axi`) | Entra tenant ID, application client ID, client secret or certificate private key and SHA-256 thumbprint, administrator-consented Graph application permissions. | `entra user list --limit 1`; other domains need their own permissions. |
| LDAP (`ldap-axi`) | Verified LDAPS or StartTLS URL, read-only bind identity and password, optional search base and private CA PEM. | `auth status`; binds once and reports the selected identity. |

#### Falcon

In the Falcon console, open **Support and resources > API clients and keys** and create a dedicated API client.
Copy its client ID and secret and record its cloud region: `us-1`, `us-2`, `eu-1` or `us-gov-1`.
At `/admin/tools/falcon-axi`, enter `clientId`, `clientSecret` and `region`, with `memberCid` only when targeting a Flight Control member tenant.
Grant `Alerts:read` for detection reads, including the first-call example.
Grant additional scopes only for the domains you use, following the pinned [API client permission matrix](https://github.com/knowttl/falcon-axi/blob/v0.3.0/README.md#api-client-permissions) and its offline `scopes` command.
For example, account reads need `Assets:read`, while CVE reads need `Vulnerabilities (Falcon Intelligence):read`, distinct from Spotlight vulnerability access.
NG-SIEM search requires `NGSIEM:write`; Identity Protection directory/timeline queries require `Identity Protection GraphQL:write` plus the documented read scopes, even though those queries read data.
These are optional domain requirements and do not justify granting other write or response scopes.
Falcon's fixed `auth status` test reports local credential resolution, so also run `artium-axi falcon-axi detection list --limit 1` after enabling and granting the tool.

#### Vectra

Obtain the deployment's canonical HTTPS origin, without a path or trailing slash.
For QUX, select `kind=qux`, `apiVersion=2.5` and either `auth=token` with `token`, or `auth=oauth` with `clientId` and `clientSecret`.
QUX OAuth requires appliance release 9.1 or later; `applianceRelease` is optional release metadata.
For RUX, select `kind=rux`, `apiVersion=3.4`, `auth=oauth`, `clientId` and `clientSecret`; leave `applianceRelease` blank.
Create a QUX personal token under **My Profile** using a local account, or have a Vectra administrator create an OAuth API client under **Manage > API Clients** and record the displayed ID and secret.
Tokens inherit their user's rights and clients inherit their assigned role; grant read access to health and the Hosts, Accounts, Detections or other areas you need.
See [Vectra's credential issuance guidance](https://github.com/vectranetworks/vectraautomatedresponse#getting-a-vectra-api-token-for-vectra-detect-api-v2) and the pinned [Vectra configuration contract](https://github.com/knowttl/vectra-axi/tree/v0.1.5#configuration) for deployment-specific requirements.
If the deployment uses a private CA, paste its PEM contents into `caBundle`; enter no server file path.
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

For other domains, use the pinned [Graph access and licence guidance](https://github.com/knowttl/mg-axi/blob/v0.1.7/docs/graph-coverage.md) and the command's permission requirements rather than granting every permission.
Licences still apply: PIM and risk/governance features can fail despite consent, and some commands support only delegated identities.
Do not add `User.Export.All` just to make a read-only setup pass; data-policy export is a write-class permission.

In the Graph credential form, choose `mode=application`, `cloud=commercial`, `auth=client-secret`, then enter `tenantId`, `clientId` and the secret value in `clientSecret`.
For a certificate, choose `auth=certificate`, enter the PEM in `privateKey` and its SHA-256 thumbprint in `thumbprintSha256`, leaving `clientSecret` blank.
Leave `allowDeviceCode`, `preview`, `sensitiveAreas` and `writes` at their defaults for the initial read-only setup.
Save, run **Test credential**, follow the [activation requirements](#browser-administration), enable and grant the tool, then run `artium-axi mg-axi entra user list --limit 1`.
Hosted application mode acquires tokens silently; do not run upstream `auth login` or supply `--scopes` through Artium.
See the [evidence ledger](docs/evidence-ledger.md) for recorded local and captain live acceptance; credential setup instructions do not establish acceptance for a new host or every upstream operation.

#### LDAP

Artium uses the [pinned npm release](tools/package.json) of `@knowttl/ldap-axi` with stored simple-bind credentials, encrypted by the same credential store as the other tools.
The user's ambient Kerberos ticket belongs to their local login and is unavailable inside Artium's server-side isolated runner.
Artium therefore requires `auth=simple`; it does not accept a keytab or manage Kerberos ticket acquisition and renewal.
This keeps the directory identity explicit and its password rotation within the existing credential replacement flow.
The native Kerberos provider and its installation script are unnecessary for this authentication mode and remain disabled.

Obtain a dedicated directory identity with read access only, its bind DN and password, and a directory URL whose certificate can be verified.
At `/admin/tools/ldap-axi`, enter `url`, choose `auth=simple`, and enter `bindDn` and the password value in `bindPassword`.
Use `ldaps://<directory-host>:636`, or `ldap://<directory-host>:389` with `startTls=true`.
Plaintext simple bind, anonymous authentication, disabled certificate verification and caller-supplied connection or credential overrides are refused.
If a private CA is required, supply its PEM contents in `caFile`, not a server file path.
The multi-line `caFile` editor preserves newlines through saving and private CA file materialization for each call.
Artium's CLI has no credential-save command.
Optional `base` limits the search context; otherwise the pinned tool discovers the directory's default naming context.
Optional `pageSize` is an integer from 1 to 1000, and `tlsMaxVersion=1.2` supports TLS 1.2-only endpoints while retaining verification.

Enter the password itself in the form, never a SecretRef or password-file path.
Save, run **Test credential**, enable the tool, grant it to a role, then run `artium-axi ldap-axi user list --limit 1` to check directory read permissions.
**Test credential** runs `auth status`, which performs one bind; failed credentials can count toward directory account lockout limits.
LDAP is read-only by design and has no editable native write settings.
The [LDAP inventory](tools/inventories/ldap-axi.json) owns the supported commands, blocked overrides and resource requirements.
Local fake-directory and offline profile checks do not establish live directory acceptance.

### Build from source

The source toolchain requires Node **24.11 or later** and **pnpm 10.22.0**.
From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
node dist/cli/artium-axi.mjs --help
node dist/cli/artium-axi.mjs setup --host codex
```

The build produces the standalone `dist/cli/artium-axi.mjs`.
Set `ARTIUM_AXI_URL` and use the same login and discovery commands with `node dist/cli/artium-axi.mjs` in place of `artium-axi`.
The root package is private; server downloads and source builds are the installation paths described here.

## Usage

### Command surface and subcommands

| Command | Purpose |
| --- | --- |
| `artium-axi` | Show identity, roles and available tools. |
| `artium-axi login --username synthetic-user` | Sign in with a local account. |
| `artium-axi login --sso` | Sign in through browser approval with an enabled SSO provider; works on headless and SSH hosts. |
| `artium-axi passwd` | Change your password, then sign in again. |
| `artium-axi whoami` | Show identity, roles, access expiry and server URL. |
| `artium-axi tools` | List enabled runtime tools granted through your roles. |
| `artium-axi tools show falcon-axi` | Show cached status, vetted pinned help and a first-call example. |
| `artium-axi doctor` | Check server address, certificate, token, CLI version and cached tool health. |
| `artium-axi logout` | Remove local tokens and attempt server-session revocation. |
| `artium-axi setup --host claude --hook` | Install the embedded skill and optional Claude Code hook. |
| `artium-axi falcon-axi detection list` | Run a Falcon read through the managed adapter. |
| `artium-axi vectra-axi detection list` | Run a Vectra read through the managed adapter. |
| `artium-axi mg-axi entra user list --limit 1` | Run a bounded Graph read through the managed adapter. |
| `artium-axi ldap-axi user list --limit 1` | Run a bounded directory read through the managed adapter. |

Add `--help` to a local command to inspect its accepted flags.
Tool help has two boundaries:

```sh
artium-axi --help falcon-axi
artium-axi falcon-axi --help
```

The first prints local Artium help without signing in or contacting the server.
The second forwards `--help` through the authenticated upstream adapter.
A bare Falcon or Vectra invocation shows upstream help; `artium-axi az-axi` and `artium-axi az-axi home` run the Azure dashboard with ARM authentication.
A bare `artium-axi ldap-axi` shows directory discovery with managed-credential guidance.
Arguments after a tool name belong to upstream, subject to adapter restrictions on credential, configuration and file paths.
Unknown Azure flags return `INVALID_INPUT` with the flag name, valid flags and a hosted help command.
The bundled CLI forwards argument tokens and local Azure files supplied through the reviewed `--file` and `--body-file` flags.
It captures bounded non-terminal stdin only for Azure `rg query` (also `graph query`), `logs query` (also `monitor log-analytics query`) and `api` calls.
Other Azure commands, including the dashboard and `home`, leave stdin unread; help and version calls also leave it unread.
Local upload paths become leaf names in the request; duplicate leaf names and oversized input are refused.
The API supports bounded stdin and named uploads through the [shared API contract](src/shared/api.ts).

Write permission remains subject to the pinned tool's native gates and the configured adapter policy.
Vectra writes require its configured allowlist and upstream confirmation; Artium does not add a universal confirmation flag.
Falcon has no editable native write settings.

Azure writes whose outcome is unknown are not retried and return `UNKNOWN_OUTCOME` with state-check guidance; reads may still retry.
Artium also returns this error when its runner times out, cancels or receives a process signal after starting an executed Azure write; read timeouts remain `TIMEOUT`.
Before submitting the write again, follow the returned read commands and inspect the changed state.
Keep `--full` on recovery API GET commands so long changed values are not truncated, including both `Check current state before trying again` and `Verify with` suggestions.
Runner-generated recovery for Sentinel incident updates and comment creation first resolves the incident ID with the suggested `incident show` command, then uses that ID in the suggested API GET to inspect all incident fields or the comments collection.

### TOON output behavior

Discovery and Artium errors use TOON.
Tool listings include their count in the array header; an empty list returns `tools: 0 available` with a reason and next step.
Details read bundled manifests and stored health without fetching credentials or executing upstream help.
Discovery and administration show the server's bundled tool versions, as defined by the [API contract](src/shared/api.ts).

Upstream calls preserve stdout, stderr and nonzero exit codes.
For Falcon, Vectra, Azure, Graph and LDAP, recognized TOON or JSON root `help` suggestions, plain upstream help and bundled tool-detail help use `artium-axi <tool>` commands, including examples originally invoking `npx -y @knowttl/<tool>`.
Recognized flag listings and command suggestions omit managed flags declared in each pinned [tool inventory](tools/inventories/)'s `unsafeOverrides`, including Graph profile, config and scopes selectors.
LDAP home output lists hosted commands, and recognized connection and TLS recovery hints direct callers to an administrator to update the [stored LDAP credentials](#ldap).
Unrelated content, literal argument values, unknown formats and truncated streams remain unchanged.
Capture is capped at 4 MiB per stream, with truncation diagnostics on stderr.
Artium failures withhold captured output and return exit 2 for usage or client configuration failures, or exit 1 for other failures.
See the [generated error reference](docs/errors.md) for codes, HTTP status, CLI exit status and recovery steps.

Doctor reads cached tool health rather than running a fresh platform test.
Its certificate diagnostic reports whether the liveness request verified TLS, independently of the HTTP status or response body.
If the connection or CA-file read fails before verification, the certificate remains unverified.
Only `ok` passes; `unknown`, `unconfigured` and `error` require investigation.
If the client reports `CLI_OUTDATED`, download the current bundle and checksum from the server again.

### Browser administration

Open `/login` through the trusted HTTPS proxy.
Temporary passwords open `/password` and require a new login after changing them.
Administrators land on `/admin`; ordinary users land on `/account` for tool access, CLI setup and session management.

| Screen | Purpose |
| --- | --- |
| `/admin` | Search and filter the users table by source, status or role; create local users. |
| `/admin/users/:id` | Edit profile and roles, review effective tools and sessions, revoke sessions, enable or disable, unlock, reset local passwords and archive. |
| `/admin/invitations` | Prepare, resend and revoke SSO invitations; see [Sign-in settings](#sign-in-settings) for usage and claim availability. |
| `/account` | Review your roles and tools, download and set up the CLI, change your local-account password and revoke your sessions. |
| `/admin/tools` | Review installed tools, pinned versions and cached health. |
| `/admin/tools/:tool` | Configure credentials, native settings and enablement; test health and review granting roles. |
| `/admin/credentials` | Redirect to the merged tools index. |
| `/admin/roles` | List roles and create a role. |
| `/admin/roles/:id` | Rename a role, replace tool grants, review members and delete eligible roles. |
| `/admin/audit` | Filter and page through authentication, administration and tool-call records. |
| `/admin/settings/sign-in` | Configure providers and role rules; see [Sign-in settings](#sign-in-settings). |

Administrator capability is separate from tool grants.
Role changes apply on the next call, including calls using existing tokens.
User detail combines grants from every assigned role and links each tool to its granting roles.
User detail and role membership pages distinguish Direct assignments made by an administrator from Rule grants.
Saving a user's roles replaces direct assignments and preserves grants originating from SSO rules.
The identity schema supports SSO users, providers, rules and invitations; see [Sign-in settings](#sign-in-settings) for the available provider editor and current SSO limits.
SSO accounts cannot be given a local password.
Disabled and archived users remain listed as role members and must have that role removed before it can be deleted.
Archived user detail allows retained direct assignments to be removed without restoring sign-in; the UI and API refuse new direct assignments, including reassigning a removed direct grant.
See [Sign-in settings](#sign-in-settings) for removing rule-origin grants.
Deleting a role requires no members and no references from SSO rules; remove or retarget its mappings in **Sign-in settings** first.
Any invitation referencing the role prevents deletion, including expired, revoked or claimed invitations, preserving invitation history.
Deletion removes its tool grants and records an audit event.
User search matches literal text anywhere in a username or display name, ignoring case.
The users and role members tables show matching totals; Next page retains the current filters.
See the [shared API contracts](src/shared/api.ts) for user filters, detail responses, role membership pagination and role deletion inputs.
The last enabled administrator cannot be disabled, demoted or archived.
Profile, role and archive changes use revision checks; reload stale forms rather than overwriting newer changes.
Session revocation and administration changes commit with their audit records.
After 15 minutes without identity confirmation, administration mutations require reauthentication.
Administration and account screens share a navigation menu.
Signed-in screens have a header showing identity, sign-in source and sign-out.
On administration screens, the header also shows the remaining confirmation window.
Local admin forms open a password dialog when confirmation expires, then resume the pending action after successful confirmation.
SSO admin forms instead open a confirmation window with the session's provider, with a forced login and fresh authentication-time check.
For Entra, configure `auth_time` as an optional ID-token claim in the application registration, following [Microsoft's optional-claims instructions](https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims).
Confirmation is refused if that claim is absent or stale.
After confirming with the same identity, use **Continue to artium** to resume the pending action in the original window.
Keep the original window open; drafts, including credential fields, remain there and are not stored for the round trip.
Allow popups for artium if the browser blocks the confirmation window.
Cancel keeps the entered values without submitting the change.
SSO sign-out optionally also visits the provider's discovered end-session endpoint, when supported.
After signing out of artium, choose **Continue to provider sign-out** to finish that optional step.
The artium session is revoked first; if provider sign-out cannot be started, the page explains that the provider session may still be active.
Register the artium `/login` URL as an allowed post-logout return URI in the provider before using that option.
Confirmation dialogs explain consequences before changes; each screen also has expandable help.
Timestamps display in the browser's local time, with their UTC value available on hover.

User detail and Account list active browser sessions and CLI token families.
Revoke ends one whole family, including its access and refresh tokens; Sign out everywhere ends all sessions while allowing a new sign-in.
Revoking your current browser session signs you out immediately.
Account session management requires a normal browser sign-in and CSRF protection, without administrator capability or the [recent confirmation required for administration](#browser-administration).
Users with temporary passwords must change them first.
Archiving disables sign-in, revokes all sessions and hides the user from the users table while retaining identity, role membership and audit history.
Archived users cannot be enabled through the UI or API; use Disable for temporary loss of access.

Credential editors pre-fill non-secret values and never return stored secrets.
Vectra and Graph use schema-generated fields and validation from their published [AXI credential standard](docs/credential-standard.md) profile schemas.
Enter secret values themselves, not SecretRefs; leave unused fields blank and enter object fields as advanced JSON and string lists one value per line.
For Vectra, `origin` must be a canonical HTTPS origin, without a path, credentials or an explicit default port.
Enter PEM contents in `caBundle`, not a server file path; Artium writes a private CA file for each call.
The form exposes the schema's full requirements, including conditional requirements for the chosen authentication kind.
Azure uses guided source-identity fields because the host brokers resource tokens separately.
Azure and Graph certificate editors accept one PEM file containing one certificate and its matching unencrypted private key and calculate the fingerprint automatically.
See the [hosted contract](docs/credential-standard.md#9-hosted-contract-artium-axi) for profile injection.
Falcon has guided fields even when its pinned package has no credential schema; its injection path stays unchanged.
Browser saves keep native settings and retain blank stored secrets for the same identity.
Changing mode, kind, authentication, tenant, client or origin requires new secrets.
Select **Test after saving** to save and report a harmless credential check inline.
See the [credential-save contract](src/shared/api.ts) (`adminToolRoutes.save`) for API inputs and complete replacement semantics.
See [credential rotation](docs/runbook.md#roles-credentials-and-health).
Native settings also replace the entire object; `{}` clears it.
Credential changes clear cached health, and background checks run every 15 minutes for enabled configured tools.
Use **Test credential** for a current fixed read before enabling a configured tool.
Graph tests read at most one user through `entra user list --limit 1`.
For a new installation, follow [Graph credential setup](#microsoft-graph) and obtain the required permission results and maintainer approval before enabling Graph on a running installation.

### Sign-in settings

Open **Sign-in settings** at `/admin/settings/sign-in` to add a single-tenant Entra ID provider using its name and directory tenant UUID.
Open the provider to save its application client UUID and credential.
Certificate authentication is preferred: paste or upload one PEM containing the certificate and matching unencrypted private key; Artium calculates the SHA-256 fingerprint.
The application's public certificate registration is an owner setup step; saving here does not contact the provider.
A client secret is also accepted, with an in-page warning recommending certificates.

For another OpenID Connect provider, choose **Add OpenID Connect provider** and enter its name and exact HTTPS issuer URL.
Discovery reads the issuer's OpenID configuration over verified TLS and rejects redirects and mismatched issuers.
Register the provider page's exact callback URI in a confidential web application, then save its client ID and RSA certificate (`private_key_jwt`) or client secret (`client_secret_post` or `client_secret_basic`, selected from discovery with POST preferred).
If discovery omits the supported client-authentication methods, secret authentication defaults to Basic.
The provider must support authorization code with PKCE S256, RS256 ID tokens and scopes `openid profile`.
Configure `preferred_username` for invitation claims and `auth_time` for fresh browser confirmation and CLI approval; generic confirmation requests use `prompt=login` and `max_age=0`.
Generic identities bind to exact issuer and `sub`; Entra continues to bind to `tid` + `oid`.
Multiple enabled providers appear on both the sign-in page and CLI approval page, each with its own callback and state binding.
Assign generic-provider users direct artium roles for tool access; arbitrary claim rules follow separately.
See [generic OIDC verification](docs/verification-p5a.md) for the approved scope split, fake-provider evidence and pending maintainer live acceptance.

Provider credentials use the encrypted store; their secrets are never returned in pages, API metadata or audit records.
Non-secret fields are pre-filled; leave secrets blank to keep them for the same tenant, client and authentication method.
Changing client or authentication requires a new secret; changing the provider tenant or issuer removes the old credential.
Settings and credential saves require administrator capability and the [confirmation described under browser administration](#browser-administration), check revisions, and are audited.
The [provider and role-rule API contracts](src/shared/api.ts) own the request and response fields.

Providers start disabled.
The provider page includes its setup guide, copy buttons for redirect and post-logout URIs, and an audited activation control requiring recent authentication.
Activation requires a locally valid matching credential and an enabled, unlocked, unarchived break-glass local administrator with a permanent password.
Test that emergency account in a separate browser before enabling SSO, then test an invitation claim and provider sign-in while keeping break-glass access open.
Local checks cannot prove provider credential acceptance or access-policy configuration.
Saving provider settings or credentials disables that provider; review and enable it again afterwards.
Disabling all providers restores ordinary local password sign-in; existing artium sessions remain active.
Per-rule Who matches counts use enabled, unarchived users’ last successful sign-in role claims and are refreshed on page reload.
They include matches for new rules before the next role sync; users without recorded sign-in claims are unknown, and these counts do not query Entra.
See the [upgrade runbook](docs/runbook.md#backup-restore-and-upgrade-rollback) for existing-identity compatibility.
Local sign-in continues to work while all providers are disabled.
On a local administrator's user detail page, use **Designate break-glass administrator** to prepare emergency password access.
Designation requires recent identity confirmation, checks the user revision and is audited.
The users table and signed-in header identify designated accounts.
Removing designation revokes that account's browser and CLI sessions; demotion also clears designation, and claiming an SSO link removes it.
When any SSO provider is enabled, only designated local administrators may use password sign-in, password confirmation or password changes, through either browser or bearer routes.
Fresh installations designate no accounts automatically and keep providers disabled.
See [break-glass verification](docs/verification-p3c2.md) for local-password policy evidence and [P3 activation verification](docs/verification-p3c2b.md) for activation and complete fake-provider browser acceptance.
On an Entra provider page, add, edit or remove role rules mapping an exact, case-sensitive Entra `roles` claim value to an artium role.
The target role supplies tool access; rules never grant administrator capability.
Create roles and grant their tools on **Roles** first.
Every rule change requires the [confirmation described under browser administration](#browser-administration) and is audited atomically; stale edits require reloading the page.
At each Entra sign-in, matching rules add role grants and unmatched rules remove their grants for that provider; direct grants and other-provider grants stay unchanged.
User details label Direct and Rule grants and identify the Entra rule that supplied each rule grant.
Deleting a rule or changing its provider, claim value or target role immediately removes that rule's grants, including those retained by archived users; direct grants and grants from other rules remain unchanged.
Open **Invite SSO user and manage invitations** from Users to prepare an invitation with a provider, display name, exact expected `preferred_username` (Entra sign-in username for Microsoft), direct roles and an expiry of 1 to 30 days (default 7).
To prepare a link for an existing enabled local account, open that user's detail page and choose **Link to SSO**.
Preparing a link preserves the account, password, sessions and grants; nothing changes until claim.
Creation and **Resend invitation** display a bearer link once; copy it before closing the dialog and send it securely yourself.
Artium does not send email and stores only the link token's hash.
Resend replaces the old link and starts a new expiry period, including for expired invitations.
**Revoke invitation** prevents claiming; claimed or revoked invitations cannot be resent.
Every mutation requires administrator capability and the [confirmation described under browser administration](#browser-administration), checks revisions where applicable, and commits with an `invite-create`, `invite-resend` or `invite-revoke` audit event identifying the invitation.
Lists never return link tokens or hashes; expiry is evaluated when read.
The [invitation API contracts](src/shared/api.ts) own the request and response fields.
When a provider is enabled, its invitation link starts browser sign-in and requires an exact, case-sensitive match of the expected username.
Claiming atomically binds the immutable provider identity, consumes the invitation, adds its direct roles and synchronizes Entra rule roles.
Linking preserves the existing user id, username, display name, administrator flag and history, removes the local password and revokes prior browser and CLI sessions.
An existing identity or username is never automatically linked; expired, revoked, replaced or claimed links cannot grant access.
Claim, link, role-sync and sign-in audit events commit with the account and session changes.
See [browser SSO protocol verification](docs/verification-p3b.md) and [SSO reauthentication verification](docs/verification-p3c.md) and [P3 activation verification](docs/verification-p3c2b.md) for fake-provider evidence and pending maintainer live acceptance.
For CLI SSO, set `ARTIUM_AXI_URL` to this server and run `artium-axi login --sso`.
Open the displayed `/device` URL in any browser, enter the terminal code, choose an enabled provider and complete a fresh sign-in, then review the requesting IP and UTC time before choosing **Approve**.
Approve only a request you started on a device you control, with a code that matches your terminal; never approve a code someone sends you.
Choose **This wasn't me** to deny an unexpected request.
Codes expire after 10 minutes and can grant access only once.
The CLI waits for approval, retries transient polling limits at the returned interval until code expiry, and stores the usual private artium tokens; run `artium-axi login --sso` again after its 8-hour family ends.
No identity-provider public-client or device-code grant configuration is required; this is artium's own approval flow.
Restarting artium invalidates pending approvals; run `login --sso` again.
For bearer SSO reauthentication, send `POST /v1/auth/reauth` with your access token and JSON `{}`.
Approve the returned code through `/device` after a fresh provider sign-in as the same user.
Poll `/v1/auth/reauth` with the same access token and JSON `{ "deviceCode": "<deviceCode>" }`, waiting the returned `intervalMs` milliseconds between polls, until it returns a recent-auth `ticket` and `expiresAt` instead of `status: pending`.
Send the ticket in `x-artium-reauth-ticket` on administration requests; it authorizes only the initiating CLI family and cannot extend its lifetime.
Denial, expiry or revocation prevents ticket issuance; approval codes are single use.
See [CLI device sign-in verification](docs/verification-p4a.md) for recorded fake-provider evidence and bearer reauthentication coverage.

### Audit screen and API

Audit supports user, tool, exact event, exact outcome and inclusive UTC From/To filters.
Records contain actor, UTC time, event, outcome, request ID, redacted arguments and safe execution metadata.
Open an event in the table to inspect every persisted field.
Pagination retains filters; starting a new search includes records inserted after the previous search began.

`GET /v1/admin/audit` exposes the same records with `user`, `tool`, `event`, `outcome`, `from`, `to`, `limit` and `cursor` parameters.
Pages default to 50 records and accept 1 to 100; pass `nextCursor` with the same filters until it is null.
Apply filters, then use **Download CSV** or **Download JSON lines** to export every matching retained record, across all pages.
`GET /v1/admin/audit/export?format=csv` (or `format=jsonl`) accepts the same filters, excluding `limit` and `cursor`.
Exports are newest first and exclude records inserted after the download begins.
Both formats contain the same safe persisted fields as `ARTIUM_AXI_AUDIT_STDOUT`, never credentials, tokens or tool output.
CSV quotes non-null values and leaves null fields empty; JSON lines preserves JSON types and nulls.
An empty result produces a CSV header or an empty JSON-lines file.
Browser reads require administrator capability; bearer reads also require a session-bound recent-reauthentication ticket.
There is no audit mutation or deletion route.
Successful local password confirmations and SSO browser and bearer confirmations emit `reauth` events.
Successful local sign-in, password confirmation and password-change records include `authentication_method` as `local` or `break-glass`.
These events are flagged as `break-glass` for designated accounts, even before SSO activation; Audit highlights them and includes the same field in its exports and JSON stdout stream.
SSO reauthentication events include the authentication method, provider and validated subject.
Device approval and refusal emit `device-approve` and `device-deny` events, with the requesting IP in `arguments.requestingAddress` and the approving or denying browser's IP in `client_address`.
Each `run-terminal` record uses `action` to report `write` when the native tool journal contains valid JSON object records for that run, or `read` when a successful run leaves its supported journal absent or empty.
This records journal activity, including mutation intents, rather than guaranteeing that a remote change succeeded.
Pinned Falcon and LDAP runs report `read` from their inventories' read-only declarations, including normal runs and health checks.
For tools with native journals, failures without journal records and malformed or unreadable evidence report `unknown`; recovered interrupted runs also report `unknown`.
See the [API contract](src/shared/api.ts) and [retention and export runbook](docs/runbook.md#retention-and-export).

## Configuration

### Client settings

| Variable | Meaning |
| --- | --- |
| `ARTIUM_AXI_URL` | Required HTTPS base URL without credentials, query or fragment. |
| `ARTIUM_AXI_CA_FILE` | Optional readable PEM CA file added to Node's certificate trust. |
| `ARTIUM_AXI_PASSWORD` | Login password source when `--password-stdin` is absent, before the terminal prompt. |
| `ARTIUM_AXI_CURRENT_PASSWORD` | Current password for an ordinary password change, before the terminal prompt. |
| `XDG_CONFIG_HOME` | Session-file base on Linux/macOS; otherwise `~/.config`. |
| `APPDATA` | Session-file base on Windows, whose execution remains unverified. |
| `ARTIUM_AXI_TEST_HTTP` | `1` permits loopback HTTP for tests only. |

Use `login --password-stdin` or `passwd --password-stdin` to supply the login or new password through stdin.
Stdin removes one final LF or CRLF and preserves all other spaces and Unicode.
Password arguments are refused; tokens are never printed.
Ordinary password changes also require the current password through the terminal prompt or `ARTIUM_AXI_CURRENT_PASSWORD`.
Clear password environment values after use.

Sessions live in `artium-axi/session.json` under the applicable base directory and are bound to the normalized server URL.
POSIX directories use mode 0700 and files mode 0600; Windows uses a restricted ACL and refuses storage if it cannot establish it.
Do not export or share the session file.
CLI processes serialize refreshes through `session.lock`; after `SESSION_BUSY`, remove that lock directory only when every CLI process has exited.
Concurrent login or logout can produce `SESSION_CHANGED`; check the current session before repeating a command.
Logout removes local tokens even if remote revocation fails, reporting `remoteRevocation: unverified` in that case.

Certificate verification remains enforced even with `NODE_TLS_REJECT_UNAUTHORIZED=0`, and authenticated redirects are refused.
Only an explicit pre-execution `TOKEN_EXPIRED` response permits one serialized refresh and retry.
A network failure or uncertain command outcome is never retried automatically.

### Server settings and custody

| Variable | Meaning |
| --- | --- |
| `ARTIUM_AXI_DATABASE_FILE` | SQLite database path; default `/data/artium.db`. |
| `ARTIUM_AXI_MASTER_KEY_FILE` | Initial or explicit master-key file containing exactly 32 raw bytes; takes precedence over other key sources. |
| `ARTIUM_AXI_MASTER_KEY` | Alternative canonical base64 encoding of exactly 32 key bytes. |
| `ARTIUM_AXI_ADMIN_USERNAME` | First-start local administrator username. |
| `ARTIUM_AXI_ADMIN_PASSWORD_FILE` | UTF-8 file containing the exact first-start password, without an added newline. |
| `ARTIUM_AXI_TRUSTED_PROXIES` | Comma-separated verified proxy source IP addresses; default trusts none. |
| `ARTIUM_AXI_AUDIT_STDOUT` | `1` streams committed audit records as JSON lines; SQLite remains authoritative. |

The server listens on HTTP port 8080 behind a trusted HTTPS reverse proxy.
The [Compose example](compose.example.yaml) publishes only on host loopback and supplies a master-key secret, not bootstrap credentials.
Follow the [first-administrator runbook](docs/runbook.md#first-administrator-and-offline-recovery) before starting a new store.
All tools start disabled until configured.
The proxy must replace incoming forwarding headers, and clients must not reach the HTTP listener directly.
Public `/health/live` checks liveness; `/health/ready` checks local migration-table access, not upstream services.

Startup validates the store's key binding and every encrypted credential before listening.
It saves the plaintext master key as canonical base64 in an owner-only `.env` beside the database, even when the key came from a mounted file.
**The data volume therefore contains both the encrypted database and its decryption key.**
Protect the whole volume and keep key escrow separate from database backups.
With no explicit key source, later starts and maintenance commands read the saved key; no key is generated or uploaded.
Invalid or mismatched keys fail startup.
See [backup, restore, rotation and rollback](docs/runbook.md#backup-restore-and-upgrade-rollback) for matching-key recovery, backup retention and unresolved owner custody choices.

### Security and acceptance boundaries

Development and verification use only fakes, synthetic identities and canary credentials.
Fake-service results do not establish live platform permissions or production readiness.
Never put tokens or keys in arguments, source files, images or logs.
The server refuses the removed development-authentication settings `ARTIUM_AXI_DEV` and `ARTIUM_AXI_DEV_TOKEN_FILE`.

Local passwords use Argon2id, require 15 to 128 code points and at most 512 UTF-8 bytes, preserve spaces and Unicode, and reject exact matches in the bundled common-password list.
Access tokens last one hour within an 8-hour SSO CLI family or a 12-hour local CLI family; refresh-token reuse revokes the family.
Password changes revoke existing CLI tokens and browser sessions.
See [browser administration](#browser-administration) for session management and user archival.
Sign-in limits and persistent account lockout are enforced by the [attempt boundary](src/server/auth/attempts.ts) and [configured defaults](src/server/config.ts).
Successful login and reauthentication do not consume the per-username failed-attempt budget; the per-address budget still counts successful and failed attempts.
Rate-limit refusals produce a `sign-in` audit record with outcome `AUTH_RATE_LIMITED` and no user identity.
Browser sessions use Secure, HttpOnly, SameSite=Strict cookies and expire after 30 minutes idle or 12 hours overall; temporary-password sessions last 10 minutes.
Browser mutations require same-origin requests and CSRF tokens.

Credentials are encrypted with AES-256-GCM and retrieved only after authorization and audited admission.
Version 1 uses one shared service credential per tool; external secret sources and per-user credentials remain deferred.
Audit excludes injected credentials, request bodies, stdin, uploaded contents and output streams, and redacts Azure query arguments, including positional KQL.
Failure to persist admission prevents execution; failure to persist the terminal event withholds the result.
Startup recovery records interrupted calls without replay.
Native write journals complement Artium audit and isolate concurrent calls so reads do not inherit another call's write tag.
See the [retention and export runbook](docs/runbook.md#retention-and-export) for journal locations, formats and cleanup.

The runner uses argument arrays without a shell, a restricted child environment, private per-call directories and bounded concurrency, runtime and output.
Known injected secrets are scanned in raw, JSON-escaped, base64, base64url and URL-encoded output, including beyond capture limits; a match discards both streams.
Exact-value scanning cannot identify unknown tokens minted upstream.
Heap and address-space limits are not complete process isolation: descendants starting a new session escape the runner's process group.
See [runner verification and limitations](docs/verification-s09-10.md) and [secret-scanner evidence](docs/verification-s07.md).

## Development & Testing

Use Linux with the [source toolchain](#build-from-source), OpenSSL, Python 3, curl and sha256sum.
Container acceptance additionally requires Docker and the BuildKit prerequisites described in the [container evidence](docs/verification-s20-21.md).
`pnpm test:containers` starts a private BuildKit worker with `--privileged`; hosts that forbid privileged containers cannot run this check and must record container acceptance as unverified.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:containers
```

`pnpm check` verifies generated error-reference freshness, strict type checking, parser/schema inventory freshness, the Vitest suite, compilation and the AXI/distribution checklist.
The checklist exercises a fresh Linux download, checksum, setup, login, temporary-password change and first call against a local HTTPS fake.
It refuses unverified host platforms.

| Command | Scope |
| --- | --- |
| `pnpm lint` | Static TypeScript checking. |
| `pnpm test` | Inventory/schema freshness checks and the full Vitest suite. |
| `pnpm build` | Server compilation and standalone client bundle. |
| `pnpm test:security` | Tests whose names contain `security`. |
| `pnpm test:containers` | Mandatory fake-only runner, walking-skeleton, Graph headless and fake-service container acceptance. |
| `pnpm test:browser` | Real admin pages in an isolated Chrome session through `chrome-devtools-axi`, against the local fake browser harness. |
| `pnpm test:containers --measure-cache` | The container block plus an identical-input warm runner build measurement. |
| `pnpm errors:generate` | Regenerate the error reference after changing the catalogue. |

The container block builds before probing, emits head/input/output evidence and timings, and removes its uniquely owned test images and private BuildKit cache.
Do not touch shared Docker resources or use real service credentials.
Changed relevant inputs invalidate earlier container evidence.
Upstream pins and integrity records live in [tools/package.json](tools/package.json), [tools/integrity.json](tools/integrity.json) and [tools/falcon-source.json](tools/falcon-source.json).
The root install runs the frozen upstream install; native build approval is limited to argon2, better-sqlite3 and esbuild, with upstream build scripts disabled.

### Private hygiene check

Before publishing a candidate, commit and build it, then set `ARTIUM_AXI_HYGIENE_DENY_LIST_FILE` to an absolute path to the private deny list **outside the checkout** and run:

```sh
pnpm hygiene:check
```

The UTF-8 list contains one literal term per line, matched case-insensitively after trimming whitespace; blanks and duplicates are ignored.
Unset, unreadable, empty or in-tree lists fail.
Never copy real terms or the list into this repository.
Record only its revision or SHA-256, candidate commit and pass/fail result.

The check scans tracked, untracked and ignored files, generated output and every commit message reachable from `HEAD`, excluding only `.git` metadata and installed `node_modules` directories.
Supply intended release assets outside the checkout as additional `pnpm hygiene:check` arguments, keeping the list outside those directories too.
Symlinks, unreadable files and BOM-marked UTF-16/UTF-32 assets fail rather than reducing coverage; convert unsupported encodings to UTF-8.
Diagnostics report location and normalized entry number without secret excerpts, and redact labels whose paths match a term.
The scan cannot guarantee absence of unknown sensitive values and does not approve publication.

Further operational guidance lives in the [runbook](docs/runbook.md); local implementation and deferred live acceptance are tracked in the [evidence ledger](docs/evidence-ledger.md).
