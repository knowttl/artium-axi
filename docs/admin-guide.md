# Administrator guide

Contents:

- [Set up a host](#set-up-a-host)
- [Deploy a server with your agent](#deploy-a-server-with-your-agent)
- [Browser administration](#browser-administration)
- [Sign-in settings](#sign-in-settings)
- [Audit screen and API](#audit-screen-and-api)
- [Server settings and custody](#server-settings-and-custody)
- [Security and acceptance boundaries](#security-and-acceptance-boundaries)

Deploy and administer the managed tools server.
For daily client use, see the [README](../README.md); for recovery and upgrades, see the [runbook](runbook.md).

### Set up a host

Give the setup agent the Linux host access, intended HTTPS hostname, DNS and certificate provisioning method, private CA bundle if applicable, and the protected data and backup locations.
Also supply the first administrator's username and temporary password through protected input, a master-key custody decision, and credentials for each tool you want enabled from [Tool credentials](tool-credentials.md).
Upstream accounts are shared server-side service identities; users sign in with their own [artium accounts](admin-guide.md#sign-in-settings).

1. **Prepare the host.**
   Install Git and Docker with Compose and reserve HTTPS port 443 for the reverse proxy.
   The image supplies Node, Python and the pinned tools; see [Build from source](../CONTRIBUTING.md#build-from-source) for the source toolchain.
   Allow package and image downloads during the build and runtime access to the enabled tools' upstream APIs and identity endpoints.
   See [runbook prerequisites](runbook.md#scope-and-prerequisites) for the runtime limits, writable data directory and UID 10001 ownership, including rootless UID mapping.

2. **Obtain the source and build the image.**
   Run from the checkout root:

   ```sh
   git clone https://github.com/knowttl/artium-axi.git
   cd artium-axi
   docker compose -f compose.example.yaml build
   ```

   Record the resulting immutable image identity for backups and rollback as described in the [runbook](runbook.md#backup-restore-and-upgrade-rollback).

3. **Prepare the master key and bootstrap administrator before starting.**
   Create a protected `private` directory, generate the key with `openssl rand -out private/artium_master_key 32` under `umask 077`, and escrow an offline copy separately from database backups.
   Place the temporary administrator password at `private/artium_bootstrap_password` through protected input, with no added newline.
   Never send either secret through chat or command arguments.
   Use the [password rules](admin-guide.md#security-and-acceptance-boundaries) and [key custody guidance](runbook.md#backup-restore-and-upgrade-rollback).
   Follow the [secret ownership instructions](runbook.md#scope-and-prerequisites) so both files are readable by container UID 10001 and protected from other users.
   In [compose.example.yaml](../compose.example.yaml), uncomment both first-start environment settings and both bootstrap-password secret entries, replacing `synthetic-admin` with your chosen username.
   The master key alone cannot bootstrap a new store.
   See [first-administrator setup](runbook.md#first-administrator-and-offline-recovery) for the empty-store requirement and startup refusals.

4. **Configure HTTPS.**
   Follow the [runbook proxy example](runbook.md#proxy-and-certificate-trust), including its static proxy IP, matching `ARTIUM_AXI_TRUSTED_PROXIES`, TLS mounts and forwarding-header replacement.
   Save your Compose override as `compose.proxy.yaml` and provision its nginx configuration and certificates before starting.
   Keep the HTTP listener inaccessible to clients and select an unused proxy subnet.

5. **Start and check the server.**
   With that override prepared, run:

   ```sh
   docker compose -f compose.example.yaml -f compose.proxy.yaml config --quiet
   docker compose -f compose.example.yaml -f compose.proxy.yaml up -d
   docker compose -f compose.example.yaml -f compose.proxy.yaml ps
   ```

   Require a healthy Artium service, then set `ARTIUM_AXI_URL` to the trusted HTTPS origin and run the [HTTPS liveness and readiness checks](runbook.md#roles-credentials-and-health).
   Both checks must return `status: ok`; they check the local server, not upstream credentials.
   If startup fails, inspect service logs and resolve the reported configuration or store error before continuing.

6. **Complete the first login.**
   Open `https://<your-artium-host>/login`, enter the bootstrap account, change its temporary password at `/password`, and sign in again.
   Remove the first-start environment settings and bootstrap-password secret entries from Compose after the administrator is created, remove the bootstrap-password file from its provisioning location, and recreate the service with the same `up -d` command.
   Keep the master-key file and persistent data volume for subsequent starts.
   Startup also saves the key beside the database, so protect the entire data volume as explained in [server custody](admin-guide.md#server-settings-and-custody).

7. **Configure tools and user access.**
   Follow [Tool credentials](tool-credentials.md) to save and test each credential, then follow the [activation requirements](admin-guide.md#browser-administration) before enabling the tool at `/admin/tools`.
   Create a role at `/admin/roles`, grant it the enabled tools, create local users at `/admin/users`, and assign that role to them.
   Assign a tool role to your administrator too if that account will run CLI calls; administrator capability alone grants no tool access.
   Finish with [Download and first call](client-reference.md#verified-client) and [Skill installation](../README.md#use-with-your-agent) on each agent host.

Recovery, rotation, backups, retention and upgrades remain in the [operations runbook](runbook.md).

### Deploy a server with your agent

Give this prompt to the agent helping you administer the server:

> Deploy artium-axi on my Linux host.
> Check Docker/Compose, host capacity, ports, DNS and the HTTPS/TLS plan first.
> Use the repository's Compose file to build the server, or a published image only after verifying its release digest and provenance as described in the runbook.
> Generate an exactly 32-byte random master key into a protected file, make it readable by container UID 10001, and keep an offline escrow copy separate from database backups.
> Create the first administrator through the documented first-start password-file bootstrap, change its temporary password and remove bootstrap inputs.
> Configure tool credentials through the administrator UI, test each credential, enable the intended tools and grant roles.
> Run liveness, readiness and a permitted read for each enabled tool; report results and remaining limits without secrets.
> Never ask me to paste passwords, tokens or keys into chat or command arguments.
> Use hidden prompts, protected stdin or files with safe permissions for secrets.
> Follow docs/admin-guide.md, docs/tool-credentials.md and docs/runbook.md for the exact steps.

For manual deployment, follow the [administrator guide](admin-guide.md#set-up-a-host).

### Browser administration

Open `/login` through the trusted HTTPS proxy.
Temporary passwords open `/password` and require a new login after changing them.
Administrators land on the Overview at `/admin`; ordinary users land on `/account` for tool access, CLI setup and session management.
Administration pages share a left sidebar grouped into Access, Tools and Security; your account and sign-out are in the menu at its foot, and each page's help opens from **Learn** in the top bar.

| Screen | Purpose |
| --- | --- |
| `/admin` | Overview: enabled tools, health, people with access and write state; items that need attention, each with the action that fixes it; the setup checklist; enabled tools and recent administration changes. Older `/admin?…` users-list links redirect to `/admin/users`. |
| `/admin/users` | People: search and filter by sign-in, status or role; add local users from the Add user sheet (`?sheet=add-user` opens it without JavaScript; submission requires JavaScript). |
| `/admin/users/:id` | Person detail: edit profile and direct roles, review what they can use and their sessions; the **…** menu resets local passwords, signs out everywhere and sets break-glass designation; unlock appears while locked; disable and archive are in the danger zone. |
| `/admin/invitations` | Prepare and resend SSO invitations from sheets (`?sheet=new-invitation` opens creation without JavaScript; submission requires JavaScript); revoke from the table; a banner explains when no enabled provider can accept claims; see [Sign-in settings](admin-guide.md#sign-in-settings). |
| `/account` | Review your roles and tools, download and set up the CLI, change your local-account password and revoke your sessions. |
| `/admin/tools` | Review installed tools in a table with state, enablement, write state, granting roles and last checked time; filter by All, Enabled or Needs attention or by name; the server-wide trusted CA bundle appears as a read-only card at the bottom. |
| `/admin/tools/:tool` | Header with state, write badges, **Test connection** and an **Enabled** switch, a setup strip and tabs: Connection, Write permissions, Certificates, Access and Advanced. |
| `/admin/credentials` | Redirect to the merged tools index. |
| `/admin/roles` | List roles with their tools, member and SSO rule counts, and create a role. |
| `/admin/roles/:id` | Rename a role, replace tool grants, review members and delete an unused role by typing its name. |
| `/admin/audit` | Filter, page through and export authentication, administration and tool-call records, and open one in a detail panel. |
| `/admin/settings/sign-in` | Configure providers and role rules; see [Sign-in settings](admin-guide.md#sign-in-settings). |

Tool State reflects the latest cached check for the current credential even while the tool is disabled; Enabled is shown separately, with its switch on the tool detail page.
The Needs attention filter includes Failing and Needs credential states.

For users granted Hybrid Analysis, Check Point or Microsoft Graph, `/account` also shows artifact warnings, CLI save guidance for [Hybrid Analysis archives](client-reference.md#hybrid-analysis-archive-saving), [Check Point emails and attachments](client-reference.md#check-point-email-and-attachment-saving) and [Microsoft Graph mail](client-reference.md#microsoft-graph-mail-saving), and metadata for their latest 20 transfers, including delivery and client-save receipts.
The browser receives no artifact bytes and never saves, renders, opens or executes an artifact.
See the [capability boundary](safety.md) for current availability.

Administrator capability is separate from tool grants.
Role changes apply on the next call, including calls using existing tokens.
Choose **New role**, enter a name and select **Create role** to open the new role's detail page and choose its tools.
The roles list marks disabled tools with a grey dot; role detail shows each tool's current state beside its grant checkbox.
Use the pencil beside the role name to rename it inline.
User detail combines grants from every assigned role and links each tool to its granting roles.
User detail and role membership pages distinguish **Direct** assignments made by an administrator from rule grants, labelled **SSO rule**.
Saving a user's roles replaces direct assignments and preserves grants originating from SSO rules.
The identity schema supports SSO users, providers, rules and invitations; see [Sign-in settings](admin-guide.md#sign-in-settings) for the available provider editor and current SSO limits.
SSO accounts cannot be given a local password.
Enter temporary passwords manually in Add user and Reset password; the fields keep them masked.
Disabled and archived users remain listed as role members and must have that role removed before it can be deleted.
Archived user detail is read-only and displays retained roles, grant provenance and change history.
The API still allows retained direct assignments to be removed without restoring sign-in and refuses new direct assignments, including reassigning a removed direct grant.
See [Sign-in settings](admin-guide.md#sign-in-settings) for removing rule-origin grants.
Deleting a role requires no members and no references from SSO rules; remove or retarget its mappings in **Sign-in settings** first.
Any invitation referencing the role prevents deletion, including expired, revoked or claimed invitations, preserving invitation history.
Deletion removes its tool grants and records an audit event.
User search matches literal text anywhere in a username or display name, ignoring case.
The People and role members tables show matching totals; pagination retains the current filters.
See the [shared API contracts](../src/shared/api.ts) for user filters, detail responses, role membership pagination and role deletion inputs.
The last enabled administrator cannot be disabled, demoted or archived.
Profile, role and archive changes use revision checks; reload stale forms rather than overwriting newer changes.
Session revocation and administration changes commit with their audit records.
After 15 minutes without identity confirmation, administration mutations require reauthentication.
See [credential certificate trust](runbook.md#trusting-one-tool-from-the-administration-ui) for the administration UI's inspection, trust modes, rotation and network-path warning.
Administration screens share a sidebar; ordinary users get a top bar only.
Signed-in screens have an account menu showing identity and sign-in source, with links to your account and sign-out.
On administration screens, the top bar also shows the remaining confirmation window: "Changes unlocked" with the minutes left, or "Changes locked".
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
Confirmation dialogs explain consequences before changes.
Archiving a person requires typing their exact username before the **Archive** confirmation button becomes available.
Role creation and rename save without an additional action confirmation dialog; saving tool grants requires confirmation, and deleting an eligible role requires typing its exact name.
The role's deletion control is disabled while blockers remain and lists their counts.
Recent identity confirmation still applies to these actions; each screen also has expandable help.
Timestamps display in the browser's local time, with their UTC value available on hover.

User detail and Account list active browser sessions and CLI token families.
Revoke ends one whole family, including its access and refresh tokens; Sign out everywhere ends all sessions while allowing a new sign-in.
Revoking your current browser session signs you out immediately.
Account session management requires a normal browser sign-in and CSRF protection, without administrator capability or the [recent confirmation required for administration](admin-guide.md#browser-administration).
Users with temporary passwords must change them first.
Archiving disables sign-in, revokes all sessions and hides the user from the users table while retaining identity, role membership and audit history.
Archived users cannot be enabled through the UI or API; use Disable for temporary loss of access.

Credential editors pre-fill non-secret values and never return stored secrets.
Field labels use schema titles when available, then plain labels for known fields, falling back to the property name; help uses schema descriptions before tool-specific fallback guidance and displays any declared schema default.
Vectra and Graph use schema-generated fields and validation from their published [AXI credential standard](credential-standard.md) profile schemas.
Enter secret values themselves, not SecretRefs; leave unused fields blank and enter object fields as advanced JSON and string lists one value per line.
Profile-backed credential saves normalize safe differences only when the schema rejects the original value; already valid values, including secrets, remain byte for byte unchanged.
Rejected strings can have surrounding whitespace removed, including nested object and list values; secret interior whitespace is preserved.
For Vectra, `origin` accepts surrounding whitespace, a trailing slash, uppercase scheme or host and an explicit default port, saving a canonical HTTPS origin.
Paths, queries, fragments, embedded credentials and HTTP origins remain invalid.
Rejected profile input returns `INVALID_INPUT` with field names and failing schema constraints, including string lengths, array bounds, uniqueness and unsupported fields, without echoing submitted values.
When the authentication branch is identifiable, guidance reports its failures and conflicting field names without instructions from other branches; independent errors are reported together.
Ambiguous alternatives receive field-combination guidance.
See [Vectra credential setup](tool-credentials.md#vectra) for private CA input and shared trust.
The form exposes the schema's full requirements, including conditional requirements for the chosen authentication kind.
Azure uses guided source-identity fields because the host brokers resource tokens separately.
Azure and Graph certificate editors accept one PEM file containing one certificate and its matching unencrypted private key and calculate the fingerprint automatically.
See the [hosted contract](credential-standard.md#9-hosted-contract-artium-axi) for profile injection.
Falcon has guided fields; see its [current credential handling](credential-standard.md#per-tool-host-facing-schemas).
Browser saves keep native settings and retain blank stored secrets for the same identity.
Identity changes require new secrets as defined by the [credential-save contract](../src/shared/api.ts) (`adminToolRoutes.save`).
**Test after saving** is on by default on the Connection tab and reports a harmless credential check inline; clear it to save without testing.
After saving, the page reports applied normalizations and reloads stored non-secret values; secret notices name only the field and change, never the value.
See the [credential-save contract](../src/shared/api.ts) (`adminToolRoutes.save`) for API inputs and complete replacement semantics.
See [credential rotation](runbook.md#roles-credentials-and-health).
Use the **Write permissions** tab (`?tab=writes`) on a tool page to change writes without replacing other native settings.
Writes default to off; the master **Allow writes** switch is absent on fixed read-only tools, which show the reason instead.
Review the current grant, actions enabled by the switch and actions that always stay blocked.
For AWX, **Operational actions** and **Configuration changes** are independent switches; review the [AWX write boundary](safety.md#write-gates-by-tool) before enabling either.
For Falcon, GitHub, Graph, Vectra, Tenable, Hybrid Analysis, Check Point and BeyondTrust, select supported operations from the pinned catalogue, grouped by resource with a search box and All, Selected and Deletes filters; turning writes on requires at least one selection.
For BeyondTrust, the separate **Allow deletes** toggle can be saved while writes are off; see the [delete gates](safety.md#beyondtrust-endpoint-privilege-management) before enabling it.
Check Point name-only event actions use exact `event.action.<name>` entries added through native settings or the write-access API, based on `event show`; no wildcard is accepted.
Check Point email/attachment downloads are separately selected and use [host-owned CLI confirmation](client-reference.md#check-point-email-and-attachment-saving), while mutations retain their native gates.
See the [Vectra supported boundary and native write gates](safety.md) before selecting operations.
Review the Vectra grant warnings: host/account close closes every active detection with no single inverse, assignment resolve is permanent, group deletion orphans triage rule references, syslog/Kafka redirects detection exports, and Match enablement changes cause a reboot.
Choose **Save write permissions** and confirm the change, completing identity confirmation if requested.
See [write-access audit events](#audit-screen-and-api) to review saved changes.
The **Advanced** tab (`?tab=advanced`) shows the saved write state, but **Replace settings** replaces all native settings and omitting write settings turns writes off.
With JavaScript, the editor reports whether the input is a valid JSON object as you type; saving also validates the tool's native settings on the server.
See the runbook's [background health schedule](runbook.md#roles-credentials-and-health) for automatic checks after configuration changes, pending status, recovery retries and concurrency limits.
Use **Test connection** for a current fixed read before enabling a configured tool; it asks for no confirmation dialog but still needs recent identity confirmation.
For failed tests, follow the [credential diagnostic guidance](runbook.md#scripted-administrator-sessions) and the [error reference](errors.md).
Graph tests read at most one user through `entra user list --limit 1`.
For a new installation, follow [Graph credential setup](tool-credentials.md#microsoft-graph), verify the required permissions against your intended operations and obtain maintainer approval before enabling Graph on a running installation.

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
Assign generic-provider users direct artium roles or configure claim rules for tool access.
Generic rules accept any exact top-level claim name, such as `groups` or `custom.claim`, and match a string or a string in an array against the case-sensitive rule value.
Dots are literal claim-name characters, not nested paths; numbers, booleans and objects do not match.

Provider credentials use the encrypted store; their secrets are never returned in pages, API metadata or audit records.
Non-secret fields are pre-filled; leave secrets blank to keep them for the same tenant, client and authentication method.
Changing client or authentication requires a new secret; changing the provider tenant or issuer removes the old credential.
Settings and credential saves require administrator capability and the [confirmation described under browser administration](admin-guide.md#browser-administration), check revisions, and are audited.
The [provider and role-rule API contracts](../src/shared/api.ts) own the request and response fields.

Providers start disabled.
The provider page includes its setup guide, copy buttons for redirect and post-logout URIs, and an audited activation control requiring recent authentication.
Activation requires a locally valid matching credential and an enabled, unlocked, unarchived break-glass local administrator with a permanent password.
Test that emergency account in a separate browser before enabling SSO, then test an invitation claim and provider sign-in while keeping break-glass access open.
Local checks cannot prove provider credential acceptance or access-policy configuration.
Saving provider settings or credentials disables that provider; review and enable it again afterwards.
Disabling all providers restores ordinary local password sign-in; existing artium sessions remain active.
Local sign-in continues to work while all providers are disabled.
On a local administrator's user detail page, use **Designate break-glass administrator** to prepare emergency password access.
Designation requires recent identity confirmation, checks the user revision and is audited.
The users table and signed-in account menu identify designated accounts.
Removing designation revokes that account's browser and CLI sessions; demotion also clears designation, and claiming an SSO link removes it.
When any SSO provider is enabled, only designated local administrators may use password sign-in, password confirmation or password changes, through either browser or bearer routes.
Fresh installations designate no accounts automatically and keep providers disabled.
On an Entra provider page, add, edit or remove role rules mapping an exact, case-sensitive Entra `roles` claim value to an artium role.
Generic provider pages offer the same rule editor with a claim-name field.
Each rule's Who matches link opens the enabled, unarchived users whose last successful sign-in claims match that provider, issuer, claim name and value.
Counts refresh on page reload and include matches for new rules before the next role sync.
These saved claims are not a live directory query; users without recorded sign-in claims are unknown.
The target role supplies tool access; rules never grant administrator capability.
Create roles and grant their tools on **Roles** first.
Every rule change requires the [confirmation described under browser administration](admin-guide.md#browser-administration) and is audited atomically; stale edits require reloading the page.
At each SSO sign-in, matching rules add role grants and unmatched rules remove their grants for that provider; direct grants and other-provider grants stay unchanged.
User details identify the provider rule that supplied each rule grant; see [browser administration](#browser-administration) for grant labels and assignment behavior.
Deleting a rule or changing its provider, claim name, claim value or target role immediately removes that rule's grants, including those retained by archived users; direct grants and grants from other rules remain unchanged.
Choose **New invitation** on Invitations, or **Invite with SSO** on People, to prepare an invitation with an Entra ID or OpenID Connect provider, display name, exact expected `preferred_username` (the Entra ID sign-in name or the OpenID Connect username), direct roles and an expiry of 1 to 30 days (default 7).
To prepare a link for an existing enabled local account, open that user's detail page and choose **Link to SSO**.
Preparing a link preserves the account, password, sessions and grants; nothing changes until claim.
Creation and **Resend invitation** display a bearer link once; use **Copy** or copy the field manually before closing the dialog, then send it securely yourself.
Artium does not send email and stores only the link token's hash.
Invitations display their status and recorded expiry, including after claim or revocation.
Resend replaces the old link and starts a new expiry period, including for expired invitations.
**Revoke invitation** prevents claiming; claimed or revoked invitations cannot be resent.
Every mutation requires administrator capability and the [confirmation described under browser administration](admin-guide.md#browser-administration), checks revisions where applicable, and commits with an `invite-create`, `invite-resend` or `invite-revoke` audit event identifying the invitation.
Lists never return link tokens or hashes; expiry is evaluated when read.
The [invitation API contracts](../src/shared/api.ts) own the request and response fields.
When a provider is enabled, its invitation link starts browser sign-in and requires an exact, case-sensitive match of the expected username.
Claiming atomically binds the immutable provider identity, consumes the invitation, adds its direct roles and synchronizes that provider's rule roles.
Linking preserves the existing user id, username, display name, administrator flag and history, removes the local password and revokes prior browser and CLI sessions.
An existing identity or username is never automatically linked; expired, revoked, replaced or claimed links cannot grant access.
Claim, link, role-sync and sign-in audit events commit with the account and session changes.
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

### Audit screen and API

Audit supports exact request ID, user, tool, exact event, exact outcome, exact error code and inclusive UTC From/To filters, plus **Failed runs only**.
The screen provides request ID, User, Tool, Event, Outcome and failed-run filters in one row; set an exact error code with `errorCode=<code>` in the page URL, which displays a removable filter.
Its **24 h** and **7 days** time ranges set From to that long before each page request and clear To; **Custom** shows the inclusive UTC From and To fields, and **Any time** removes the time bounds.
Use `requestId=<id>` to correlate a call's records.
Use `failed=1` to select only `run-terminal` records with a non-zero or missing exit code, or an outcome other than `completed`; omit it or use `failed=0` to disable this restriction.
This filter does not change stored outcomes: a non-zero tool exit can still have outcome `completed`.
When a normal managed run exits non-zero, its terminal record stores the tool's own bounded failure code in `error_code` from a recognized `code:` or `error_code:` line, falling back to an Azure `AADSTS` provider code found in the output.
Audit records exclude failure messages, help text and tool output; a normal managed run with no recognizable code leaves `error_code` empty while keeping its exit code.
Records contain actor, UTC time, event, outcome, request ID, redacted arguments and safe execution metadata.
Each upload accepted by command input validation emits an `upload` event before credential preparation and tool execution.
Its `arguments` contains the redacted command and file metadata: uploaded leaf name, decoded byte size and server-computed SHA-256, never the original local path or file contents.
An upload event's `success` outcome records input acceptance, not successful tool execution or a completed upstream write.
Select a record in the table to open its detail panel, which shows its key fields and every persisted field.
The `/admin/audit?record=<id>` link opens a retained record without JavaScript, even if it is outside the current list filters; an absent or expired record shows **Record not found**.
A terminal record's panel can also show a separately retained failure diagnostic; see [diagnostic storage and retention](runbook.md#scripted-administrator-sessions).
Pagination retains filters; starting a new search includes records inserted after the previous search began.

`GET /v1/admin/audit` exposes the same records; [the API contract](../src/shared/api.ts) owns the accepted filters (`auditFiltersSchema`) and pagination parameters (`adminAuditQuerySchema`).
Pages default to 50 records and accept 1 to 100; pass `nextCursor` with the same filters until it is null.
Apply filters, then choose **CSV** or **JSON lines** from **Export** to export every matching retained record, across all pages.
`GET /v1/admin/audit/export?format=csv` (or `format=jsonl`) accepts the same filters, excluding `limit` and `cursor`.
Exports are newest first and exclude records inserted after the download begins.
Both formats contain the same safe persisted fields as `ARTIUM_AXI_AUDIT_STDOUT`, never credentials, tokens or tool output.
CSV quotes non-null values and leaves null fields empty; JSON lines preserves JSON types and nulls.
The [API contracts](../src/shared/api.ts) own the persisted field definitions (`adminAuditRecordSchema`) and transfer evidence rules (`transferAuditSchema` and `transferEvidenceSchema`).
For hosted download availability, see the [supported capability boundaries](safety.md).
An empty result produces a CSV header or an empty JSON-lines file.
Browser reads require administrator capability; bearer reads also require a session-bound recent-reauthentication ticket.
There is no audit mutation or deletion route.
Filter by event `tool-write-access` to review changes to effective write enablement, AWX configuration permission, BeyondTrust delete permission or an operations allow-list, including changes made through the Advanced tab or complete credential replacement.
These events identify the administrator and tool and record the new write policy without credentials or unrelated native settings; the [API contract](../src/shared/api.ts) owns the audit argument fields and treatment of unsupported legacy operation names.
No-op write-access requests emit no change event.
Successful local password confirmations and SSO browser and bearer confirmations emit `reauth` events.
Successful local sign-in, password confirmation and password-change records include `authentication_method` as `local` or `break-glass`.
These events are flagged as `break-glass` for designated accounts, even before SSO activation; Audit highlights them and includes the same field in its exports and JSON stdout stream.
SSO reauthentication events include the authentication method, provider and validated subject.
Device approval and refusal emit `device-approve` and `device-deny` events, with the requesting IP in `arguments.requestingAddress` and the approving or denying browser's IP in `client_address`.
For Azure, Graph and Vectra, each `run-terminal` record uses `action` to report `write` when the native tool journal contains valid JSON object records for that run, or `read` when a successful run leaves its supported journal absent or empty.
This records journal activity, including mutation intents, rather than guaranteeing that a remote change succeeded.
LDAP runs report `read` from its inventory's read-only declaration.
Falcon calls report `read` unless they contain `--execute` or submit `malquery search`.
Those calls report `write` only with valid native journal records; absent or empty evidence reports `unknown`, even after success.
MalQuery submissions do not emit the native RTR journal.
ADO and AWX use host classification: reads report `read`, successful write calls report `write`, and failed or interrupted writes report `unknown`.
Identifiable raw ADO API mutations also emit an `ado-api` decision record; the [API contract](../src/shared/api.ts) owns its argument fields.
The decision is `allowed` immediately before runner admission or `refused` on validation, policy or credential refusal.
The record identifies the authenticated user when available; execution outcome remains in the normal run-terminal record.
Body text is never included in this decision journal, and audit persistence failure prevents forwarding.
GitHub also uses host classification; see its [supported boundary](safety.md).
See [GitHub setup](tool-credentials.md#github) for device connection, token lifecycle and reconnect guidance, and its [certificate trust exception](runbook.md#trusting-one-tool-from-the-administration-ui).
Tenable, Hybrid Analysis and Check Point writes use shared native journals with invocation-specific attribution; see the [retention and export runbook](runbook.md#retention-and-export).
BeyondTrust executed writes report `write` when their isolated native intent is present, otherwise `unknown`; `native_audit_id` carries the native intent ID or the durable host fallback ID.
See [BeyondTrust intent storage and reconciliation](runbook.md#retention-and-export) before interpreting an interrupted write.
Check Point download evidence is host-owned and leaves native journal fields empty.
For Azure, Graph, Vectra and Falcon calls requiring journal evidence, failures without journal records and malformed or unreadable evidence report `unknown`; recovered interrupted runs for every tool also report `unknown`.
See the [API contract](../src/shared/api.ts) and [retention and export runbook](runbook.md#retention-and-export).

### Server settings and custody

| Variable | Meaning |
| --- | --- |
| `ARTIUM_AXI_DATABASE_FILE` | SQLite database path; default `/data/artium.db`. |
| `ARTIUM_AXI_MASTER_KEY_FILE` | Initial or explicit master-key file containing exactly 32 raw bytes; takes precedence over other key sources. |
| `ARTIUM_AXI_MASTER_KEY` | Alternative canonical base64 encoding of exactly 32 key bytes. |
| `ARTIUM_AXI_EXTRA_CA_FILE` | Optional readable PEM bundle of public CA certificates for upstream TLS, including TLS inspection; mounted read-only. Loaded at startup; see the [private CA runbook](runbook.md#tls-inspection-and-private-upstream-cas). |
| `ARTIUM_AXI_ADMIN_USERNAME` | First-start local administrator username. |
| `ARTIUM_AXI_ADMIN_PASSWORD_FILE` | UTF-8 file containing the exact first-start password, without an added newline. |
| `ARTIUM_AXI_TRUSTED_PROXIES` | Comma-separated verified proxy source IP addresses; default trusts none. |
| `ARTIUM_AXI_AUDIT_STDOUT` | `1` streams committed audit records as JSON lines; SQLite remains authoritative. |
| `ARTIUM_AXI_ADO_API_WRITE_PATHS` | Server-only JSON allow list by uppercase method. Example: `{"PATCH":["_apis/wit/workitems/*"]}`. See the path contract below and [implementation defaults](../src/server/adapters/ado-api.ts). |

Configure the ADO API write allow list in the server process environment; it is never accepted from a client or forwarded to the tool.
Keys are `POST`, `PATCH`, `PUT` or `DELETE`; values are arrays of relative REST path patterns.
Each pattern matches the complete normalized relative path, case sensitively; a whole segment `*` matches exactly one nonempty segment.
Other segments match literally after canonical percent encoding.
No default pattern permits writes; invalid JSON or a non-object configuration refuses writes, and invalid or nonmatching patterns do not authorize a path.
Empty segments, dot segments, encoded traversal, nested percent encodings, URLs, backslashes, controls, query strings and fragments are refused for writes.
See the [command reference](commands.md) for path scope and body syntax, and [supported write gates](safety.md#write-gates-by-tool) for administrator enablement.

The server listens on HTTP port 8080 behind a trusted HTTPS reverse proxy.
The [Compose example](../compose.example.yaml) publishes only on host loopback and supplies a master-key secret, not bootstrap credentials.
Follow the [first-administrator runbook](runbook.md#first-administrator-and-offline-recovery) before starting a new store.
All tools start disabled until configured.
The proxy must replace incoming forwarding headers, and clients must not reach the HTTP listener directly.
Public `/health/live` checks liveness; `/health/ready` checks local migration-table access, not upstream services.

Startup validates the store's key binding and every encrypted credential before listening.
It saves the plaintext master key as canonical base64 in an owner-only `.env` beside the database, even when the key came from a mounted file.
**The data volume therefore contains both the encrypted database and its decryption key.**
Protect the whole volume and keep key escrow separate from database backups.
With no explicit key source, later starts and maintenance commands read the saved key; no key is generated or uploaded.
Invalid or mismatched keys fail startup.
See [backup, restore, rotation and rollback](runbook.md#backup-restore-and-upgrade-rollback) for matching-key recovery, backup retention and unresolved owner custody choices.

### Security and acceptance boundaries

Development and verification use only fakes, synthetic identities and canary credentials.
Fake-service results do not establish live platform permissions or production readiness.
Never put tokens or keys in arguments, source files, images or logs.
The server refuses the removed development-authentication settings `ARTIUM_AXI_DEV` and `ARTIUM_AXI_DEV_TOKEN_FILE`.

Local passwords use Argon2id and accept any non-empty password of at most 512 UTF-8 bytes, preserving spaces and Unicode.
The byte cap bounds input to native hashing; there are no minimum-length, character-count or common-password rules.
Access tokens last one hour within an 8-hour SSO CLI family or a 12-hour local CLI family; refresh-token reuse revokes the family.
Password changes revoke existing CLI tokens and browser sessions.
See [browser administration](admin-guide.md#browser-administration) for session management and user archival.
Sign-in limits and persistent account lockout are enforced by the [attempt boundary](../src/server/auth/attempts.ts) and [configured defaults](../src/server/config.ts).
Successful login and reauthentication do not consume the per-username failed-attempt budget; the per-address budget still counts successful and failed attempts.
Rate-limit refusals produce a `sign-in` audit record with outcome `AUTH_RATE_LIMITED` and no user identity.
Browser sessions use Secure, HttpOnly, SameSite=Strict cookies and expire after 30 minutes idle or 12 hours overall; temporary-password sessions last 10 minutes.
Browser mutations require same-origin requests and CSRF tokens.

Credentials are encrypted with AES-256-GCM and retrieved only after authorization and audited admission.
The server uses one shared service credential per tool; external secret sources and per-user credentials are unsupported.
Audit excludes injected credentials, request bodies, stdin, uploaded contents and output streams, and redacts Azure query arguments, including positional KQL.
Failure to persist admission prevents execution; failure to persist the terminal event withholds the result.
Startup recovery records interrupted calls without replay.
Native write journals complement Artium audit and isolate concurrent calls so reads do not inherit another call's write tag.
See the [retention and export runbook](runbook.md#retention-and-export) for journal locations, formats and cleanup.

The runner uses argument arrays without a shell, a restricted child environment, private per-call directories and bounded concurrency, runtime and output.
See [runner admission](runbook.md#runner-admission) for capacity, queue waits and cancellation behavior.
Known injected secrets are scanned in raw, JSON-escaped, base64, base64url and URL-encoded output, including beyond capture limits; a match discards both streams.
Exact-value scanning cannot identify unknown tokens minted upstream.
Heap and address-space limits are not complete process isolation: descendants starting a new session escape the runner's process group.
