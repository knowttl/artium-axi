---
name: beyondtrust-axi
description: Inspect and manage BeyondTrust PM Cloud Endpoint Privilege Management computers, groups, policies, applications, users, domains, SCIM, events, audits and JIT requests through bounded reads, downloads and explicitly confirmed writes and deletes.
---

# BeyondTrust AXI

Inspect BeyondTrust PM Cloud Endpoint Privilege Management through guarded AXI commands.

Use a configured session hook for ambient local context or this skill for on-demand guidance.
The full command set covers 47 reads (including four downloads), 40 write operations and six delete operations.
Windows and macOS application removal share two Policy Editor POSTs with additions, with distinct permissions and no mixed requests.
Certificate renewal is not built because the export documents only 410 Gone.
Local discovery commands remain offline.
Lists default to 50 rows; --all caps at 1000 rows within shared request, time and byte budgets.
Resume a non-null cursor with the same profile, command, ID, filters and sort.
Writes require a named file profile, writes.allowWrites and an exact operation allow-list entry; forced read-only takes precedence.
Preview first, then repeat with --execute and the exact --confirm; deletes additionally require writes.allowDeletes and exact --confirm-delete.
Policy delete --force also requires policy.delete.force.
Computer filter selections have no maximum count; previews show the count and first 20 hosts, and execution confirmations bind that count.
The server re-applies filters at execution, so membership can change after counting.
Never replay OUTCOME_UNKNOWN; reconcile remote state using auditId.
Downloads require downloads.allow and a new private destination file.
Never put secrets in argv or contact a live tenant during automated verification.
Live compatibility, token lifetime, rate limits, download formats and write-result task semantics remain unverified until commissioning through artium-axi.
See the README quickstart for running the published npm package and CONTRIBUTING.md for release mechanics.
See the README Troubleshooting section for API_RESPONSE_INVALID diagnostics.

## computer delete

Preview computer delete; DELETE /v3/Computers; requires file-profile writes.allowWrites, writes.allowDeletes and exact operation computer.delete. Re-reads targets, binds state into confirmation, requires --execute, --confirm and --confirm-delete, persists redacted intent and sends once without retries..

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send once after re-read and both exact confirmations |
| --confirm | Exact confirmation from preview |
| --confirm-delete | Exact deleteConfirmation from preview: DELETE <operation> <count> <targets> |
| --computer-id | Filter ComputerId (string) |
| --host | Filter Host (string) |
| --host-type | Filter HostType (Undefined|MicrosoftWindows|AppleMacOS|Linux) |
| --agent-version | Filter AgentVersion (string) |
| --adapter-version | Filter AdapterVersion (string) |
| --package-manager-version | Filter PackageManagerVersion (string) |
| --authorisation-state | Filter AuthorisationState (string) |
| --last-connected-dates | Filter LastConnected Dates (array; comma-separated) |
| --last-connected-selection-mode | Filter LastConnected SelectionMode (Single|Multiple|Range) |
| --policy-revision-status | Filter PolicyRevisionStatus (string) |
| --policy-id | Filter PolicyId (string) |
| --policy-name | Filter PolicyName (string) |
| --host-policy-name | Filter HostPolicyName (string) |
| --group-id | Filter GroupId (string) |
| --group-name | Filter GroupName (string) |
| --os | Filter OS (Windows|Mac) |
| --domain | Filter Domain (string) |
| --created-dates | Filter Created Dates (array; comma-separated) |
| --created-selection-mode | Filter Created SelectionMode (Single|Multiple|Range) |
| --duplicate-count-min | Filter DuplicateCount Min (integer) |
| --duplicate-count-max | Filter DuplicateCount Max (integer) |
| --connection-status | Filter ConnectionStatus (array; comma-separated) |
| --days-disconnected | Filter DaysDisconnected (integer) |
| --days-since-archived | Filter DaysSinceArchived (integer) |

```sh
npx -y @knowttl/beyondtrust-axi computer delete <uuid>
npx -y @knowttl/beyondtrust-axi computer delete --help
```

## computer deactivate

Preview computer deactivate; POST /v3/Computers/Deactivate; requires file-profile writes.allowWrites, writes.allowDeletes and exact operation computer.deactivate. Re-reads targets, binds state into confirmation, requires --execute, --confirm and --confirm-delete, persists redacted intent and sends once without retries. Archives and deletes computers..

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send once after re-read and both exact confirmations |
| --confirm | Exact confirmation from preview |
| --confirm-delete | Exact deleteConfirmation from preview: DELETE <operation> <count> <targets> |
| --computer-id | Filter ComputerId (string) |
| --host | Filter Host (string) |
| --host-type | Filter HostType (Undefined|MicrosoftWindows|AppleMacOS|Linux) |
| --agent-version | Filter AgentVersion (string) |
| --adapter-version | Filter AdapterVersion (string) |
| --package-manager-version | Filter PackageManagerVersion (string) |
| --authorisation-state | Filter AuthorisationState (string) |
| --last-connected-dates | Filter LastConnected Dates (array; comma-separated) |
| --last-connected-selection-mode | Filter LastConnected SelectionMode (Single|Multiple|Range) |
| --policy-revision-status | Filter PolicyRevisionStatus (string) |
| --policy-id | Filter PolicyId (string) |
| --policy-name | Filter PolicyName (string) |
| --host-policy-name | Filter HostPolicyName (string) |
| --group-id | Filter GroupId (string) |
| --group-name | Filter GroupName (string) |
| --os | Filter OS (Windows|Mac) |
| --domain | Filter Domain (string) |
| --created-dates | Filter Created Dates (array; comma-separated) |
| --created-selection-mode | Filter Created SelectionMode (Single|Multiple|Range) |
| --duplicate-count-min | Filter DuplicateCount Min (integer) |
| --duplicate-count-max | Filter DuplicateCount Max (integer) |
| --connection-status | Filter ConnectionStatus (array; comma-separated) |
| --days-disconnected | Filter DaysDisconnected (integer) |
| --days-since-archived | Filter DaysSinceArchived (integer) |

```sh
npx -y @knowttl/beyondtrust-axi computer deactivate <uuid>
npx -y @knowttl/beyondtrust-axi computer deactivate --help
```

## group delete

Preview group delete; DELETE /v3/Groups/{id}; requires file-profile writes.allowWrites, writes.allowDeletes and exact operation group.delete. Re-reads targets, binds state into confirmation, requires --execute, --confirm and --confirm-delete, persists redacted intent and sends once without retries..

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send once after re-read and both exact confirmations |
| --confirm | Exact confirmation from preview |
| --confirm-delete | Exact deleteConfirmation from preview: DELETE <operation> <count> <targets> |

```sh
npx -y @knowttl/beyondtrust-axi group delete <uuid>
npx -y @knowttl/beyondtrust-axi group delete --help
```

## domain delete

Preview domain delete; DELETE /v3/AcceptedDomains/{id}; requires file-profile writes.allowWrites, writes.allowDeletes and exact operation domain.delete. Re-reads targets, binds state into confirmation, requires --execute, --confirm and --confirm-delete, persists redacted intent and sends once without retries..

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send once after re-read and both exact confirmations |
| --confirm | Exact confirmation from preview |
| --confirm-delete | Exact deleteConfirmation from preview: DELETE <operation> <count> <targets> |

```sh
npx -y @knowttl/beyondtrust-axi domain delete <uuid>
npx -y @knowttl/beyondtrust-axi domain delete --help
```

## policy delete

Preview policy delete; DELETE /v3/Policies/{id}; requires file-profile writes.allowWrites, writes.allowDeletes and exact operation policy.delete. Re-reads targets, binds state into confirmation, requires --execute, --confirm and --confirm-delete, persists redacted intent and sends once without retries..

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send once after re-read and both exact confirmations |
| --confirm | Exact confirmation from preview |
| --confirm-delete | Exact deleteConfirmation from preview: DELETE <operation> <count> <targets> |
| --force | Force deletion; additionally requires operation policy.delete.force (default: false) |

```sh
npx -y @knowttl/beyondtrust-axi policy delete <uuid>
npx -y @knowttl/beyondtrust-axi policy delete --help
```

## policy discard-draft

Preview policy discard-draft; PATCH /v3/Policies/{id}/DiscardDraft; requires file-profile writes.allowWrites, writes.allowDeletes and exact operation policy.discard-draft. Re-reads targets, binds state into confirmation, requires --execute, --confirm and --confirm-delete, persists redacted intent and sends once without retries. Irreversibly discards draft changes..

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send once after re-read and both exact confirmations |
| --confirm | Exact confirmation from preview |
| --confirm-delete | Exact deleteConfirmation from preview: DELETE <operation> <count> <targets> |

```sh
npx -y @knowttl/beyondtrust-axi policy discard-draft <uuid>
npx -y @knowttl/beyondtrust-axi policy discard-draft --help
```

## policy app remove

Preview policy app remove; POST /PolicyEditor/v3/Policy/{policyId}/Windows/ApplicationGroups/Applications or POST /PolicyEditor/v3/Policy/{policyId}/MacOS/ApplicationGroups/Applications; requires file-profile writes.allowWrites, writes.allowDeletes and exact operation policy.app.remove. Re-reads targets, binds state into confirmation, requires --execute, --confirm and --confirm-delete, persists redacted intent and sends once without retries. Removes applications only; never mixed with additions..

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send once after re-read and both exact confirmations |
| --confirm | Exact confirmation from preview |
| --confirm-delete | Exact deleteConfirmation from preview: DELETE <operation> <count> <targets> |
| --os | Required windows|macos |
| --app-group | Required application group UUID; 1-20 application UUIDs follow as positional arguments |

```sh
npx -y @knowttl/beyondtrust-axi policy app remove <uuid> --os windows --app-group <uuid> <application-uuid>
npx -y @knowttl/beyondtrust-axi policy app remove --help
```

## admin-request create

Preview admin-request create; POST /v3/AdminAccessRequest; requires file-profile permission for admin-request.create; validates input and re-reads before exact confirmation, durable redacted intent and one send without retries. A pre-approved request grants admin rights..

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send once after re-read and exact confirmation |
| --confirm | Exact confirmation from preview; state and file digest must still match |
| --decision | Optional approve; grants admin rights |
| --by | Decision maker; required with --decision |
| --computer | Required computer UUID |
| --user | Required endpoint user ID |

```sh
npx -y @knowttl/beyondtrust-axi admin-request create --computer <uuid> --user <user>
npx -y @knowttl/beyondtrust-axi admin-request create --help
```

## admin-request decide

Preview admin-request decide; POST /v3/AdminAccessRequest/approval; requires file-profile permission for admin-request.decide; validates input and re-reads before exact confirmation, durable redacted intent and one send without retries. .

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send once after re-read and exact confirmation |
| --confirm | Exact confirmation from preview; state and file digest must still match |
| --decision | Required approve|deny; approve grants admin rights |
| --by | Decision maker; required with --decision |
| --duration | Session duration in seconds |
| --message | Decision message |

```sh
npx -y @knowttl/beyondtrust-axi admin-request decide <request-uuid> --decision approve --by <user>
npx -y @knowttl/beyondtrust-axi admin-request decide --help
```

## auth-request notify

Preview auth-request notify; POST /v3/AuthorizationRequest/notification; requires file-profile permission for auth-request.notify; validates input and re-reads before exact confirmation, durable redacted intent and one send without retries. .

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send once after re-read and exact confirmation |
| --confirm | Exact confirmation from preview; state and file digest must still match |
| --file | Required secure UTF-8 JSON matching AuthorizationRequestNotificationModel in inventory/swagger.json; maximum 10 MiB; sha256 bound into confirmation; all ten fields required |

```sh
npx -y @knowttl/beyondtrust-axi auth-request notify --file <input.json>
npx -y @knowttl/beyondtrust-axi auth-request notify --help
```

## app-switcher connect

Preview app-switcher connect; POST /v3/AppSwitcher/connector; requires file-profile permission for app-switcher.connect; validates input and re-reads before exact confirmation, durable redacted intent and one send without retries. No connector read endpoint exists in the export; checks API access and previews the registration request..

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send once after re-read and exact confirmation |
| --confirm | Exact confirmation from preview; state and file digest must still match |
| --file | Required secure UTF-8 JSON matching AppSwitcherRequest in inventory/swagger.json; maximum 10 MiB; sha256 bound into confirmation |

```sh
npx -y @knowttl/beyondtrust-axi app-switcher connect --file <input.json>
npx -y @knowttl/beyondtrust-axi app-switcher connect --help
```

## user create

Preview user create; POST /v3/Users; requires file-profile permission for user.create; validates input and re-reads before exact confirmation, durable redacted intent and one send without retries. .

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send once after re-read and exact confirmation |
| --confirm | Exact confirmation from preview; state and file digest must still match |
| --file | Required secure UTF-8 JSON matching V3CreateUserRequest in inventory/swagger.json; maximum 10 MiB; sha256 bound into confirmation |

```sh
npx -y @knowttl/beyondtrust-axi user create --file <input.json>
npx -y @knowttl/beyondtrust-axi user create --help
```

## user update

Preview user update; PUT /v3/Users/{id}; requires file-profile permission for user.update; validates input and re-reads before exact confirmation, durable redacted intent and one send without retries. .

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send once after re-read and exact confirmation |
| --confirm | Exact confirmation from preview; state and file digest must still match |
| --file | Required secure UTF-8 JSON matching ModifyUserRequest in inventory/swagger.json; maximum 10 MiB; sha256 bound into confirmation |

```sh
npx -y @knowttl/beyondtrust-axi user update <uuid> --file <input.json>
npx -y @knowttl/beyondtrust-axi user update --help
```

## user preferences set

Preview user preferences set; PUT /v3/Users/{id}/ModifyUserPreferences; requires file-profile permission for user.preferences; validates input and re-reads before exact confirmation, durable redacted intent and one send without retries. .

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send once after re-read and exact confirmation |
| --confirm | Exact confirmation from preview; state and file digest must still match |
| --file | Required secure UTF-8 JSON matching ModifyUserPreferencesRequest in inventory/swagger.json; maximum 10 MiB; sha256 bound into confirmation |

```sh
npx -y @knowttl/beyondtrust-axi user preferences set <uuid> --file <input.json>
npx -y @knowttl/beyondtrust-axi user preferences set --help
```

## user assign-roles

Preview user assign-roles; POST /v3/Users/{id}/AssignRoles; requires file-profile permission for user.assign-roles; validates input and re-reads before exact confirmation, durable redacted intent and one send without retries. .

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send once after re-read and exact confirmation |
| --confirm | Exact confirmation from preview; state and file digest must still match |
| --file | Required secure UTF-8 JSON matching V3AssignUserToRolesRequest in inventory/swagger.json; maximum 10 MiB; sha256 bound into confirmation |

```sh
npx -y @knowttl/beyondtrust-axi user assign-roles <uuid> --file <input.json>
npx -y @knowttl/beyondtrust-axi user assign-roles --help
```

## user disable

Preview user disable; PATCH /v3/Users/{id}/Disable; requires file-profile permission for user.disable; validates input and re-reads before exact confirmation, durable redacted intent and one send without retries. .

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send once after re-read and exact confirmation |
| --confirm | Exact confirmation from preview; state and file digest must still match |

```sh
npx -y @knowttl/beyondtrust-axi user disable <uuid>
npx -y @knowttl/beyondtrust-axi user disable --help
```

## user enable

Preview user enable; PATCH /v3/Users/{id}/Enable; requires file-profile permission for user.enable; validates input and re-reads before exact confirmation, durable redacted intent and one send without retries. .

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send once after re-read and exact confirmation |
| --confirm | Exact confirmation from preview; state and file digest must still match |

```sh
npx -y @knowttl/beyondtrust-axi user enable <uuid>
npx -y @knowttl/beyondtrust-axi user enable --help
```

## user resend-invite

Preview user resend-invite; PATCH /v3/Users/{id}/ResendInvite; requires file-profile permission for user.resend-invite; validates input and re-reads before exact confirmation, durable redacted intent and one send without retries. Sends an invitation email..

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send once after re-read and exact confirmation |
| --confirm | Exact confirmation from preview; state and file digest must still match |

```sh
npx -y @knowttl/beyondtrust-axi user resend-invite <uuid>
npx -y @knowttl/beyondtrust-axi user resend-invite --help
```

## domain create

Preview domain create; POST /v3/AcceptedDomains; requires file-profile permission for domain.create; validates input and re-reads before exact confirmation, durable redacted intent and one send without retries. .

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send once after re-read and exact confirmation |
| --confirm | Exact confirmation from preview; state and file digest must still match |

```sh
npx -y @knowttl/beyondtrust-axi domain create <domain>
npx -y @knowttl/beyondtrust-axi domain create --help
```

## domain update

Preview domain update; PUT /v3/AcceptedDomains/{id}; requires file-profile permission for domain.update; validates input and re-reads before exact confirmation, durable redacted intent and one send without retries. .

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send once after re-read and exact confirmation |
| --confirm | Exact confirmation from preview; state and file digest must still match |

```sh
npx -y @knowttl/beyondtrust-axi domain update <uuid> <domain>
npx -y @knowttl/beyondtrust-axi domain update --help
```

## scim user create

Preview scim user create; POST /scim/v3/users; requires file-profile permission for scim.user.create; validates input and re-reads before exact confirmation, durable redacted intent and one send without retries. Deactivation is identified in the preview..

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send once after re-read and exact confirmation |
| --confirm | Exact confirmation from preview; state and file digest must still match |
| --file | Required secure UTF-8 JSON matching ScimUserModelV3 in inventory/swagger.json; maximum 10 MiB; sha256 bound into confirmation |

```sh
npx -y @knowttl/beyondtrust-axi scim user create --file <input.json>
npx -y @knowttl/beyondtrust-axi scim user create --help
```

## scim user replace

Preview scim user replace; PUT /scim/v3/users/{userID}; requires file-profile permission for scim.user.replace; validates input and re-reads before exact confirmation, durable redacted intent and one send without retries. Deactivation is identified in the preview..

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send once after re-read and exact confirmation |
| --confirm | Exact confirmation from preview; state and file digest must still match |
| --file | Required secure UTF-8 JSON matching ScimUserModelV3 in inventory/swagger.json; maximum 10 MiB; sha256 bound into confirmation |

```sh
npx -y @knowttl/beyondtrust-axi scim user replace <uuid> --file <input.json>
npx -y @knowttl/beyondtrust-axi scim user replace --help
```

## scim user patch

Preview scim user patch; PATCH /scim/v3/users/{userID}; requires file-profile permission for scim.user.patch; validates input and re-reads before exact confirmation, durable redacted intent and one send without retries. Deactivation is identified in the preview..

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send once after re-read and exact confirmation |
| --confirm | Exact confirmation from preview; state and file digest must still match |
| --file | Required secure UTF-8 JSON matching ScimUserPatchRequest in inventory/swagger.json; maximum 10 MiB; sha256 bound into confirmation |

```sh
npx -y @knowttl/beyondtrust-axi scim user patch <uuid> --file <input.json>
npx -y @knowttl/beyondtrust-axi scim user patch --help
```

## policy create

Preview policy create; POST /v3/Policies; requires exact file-profile operation permission (replace command spaces with dots); re-reads targets and sends once after exact confirmation and durable private intent. File inputs are secure, at most 10 MiB, with sha256 bound into confirmation. Policy files are sent byte-identically; application additions require UTF-8 JSON..

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send once after re-read and exact confirmation |
| --confirm | Exact confirmation from preview; re-read and file digest must still match |
| --name | Policy name (required for create) |
| --description | Policy description |
| --file | Required policy XML file; maximum 10 MiB |

```sh
npx -y @knowttl/beyondtrust-axi policy create --help
npx -y @knowttl/beyondtrust-axi policy create --name example --file <policy-file>
```

## policy update

Preview policy update; PUT /v3/Policies/{id}; requires exact file-profile operation permission (replace command spaces with dots); re-reads targets and sends once after exact confirmation and durable private intent. File inputs are secure, at most 10 MiB, with sha256 bound into confirmation. Policy files are sent byte-identically; application additions require UTF-8 JSON..

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send once after re-read and exact confirmation |
| --confirm | Exact confirmation from preview; re-read and file digest must still match |
| --name | Policy name (required for create) |
| --description | Policy description |

```sh
npx -y @knowttl/beyondtrust-axi policy update --help
npx -y @knowttl/beyondtrust-axi policy update <policy-uuid> --name example
```

## policy upload

Preview policy upload; POST /v3/Policies/{id}/Upload; requires exact file-profile operation permission (replace command spaces with dots); re-reads targets and sends once after exact confirmation and durable private intent. File inputs are secure, at most 10 MiB, with sha256 bound into confirmation. Policy files are sent byte-identically; application additions require UTF-8 JSON..

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send once after re-read and exact confirmation |
| --confirm | Exact confirmation from preview; re-read and file digest must still match |
| --file | Required policy XML file; maximum 10 MiB |
| --auto-assign | Assign the new revision to the policy's groups (default: false) |

```sh
npx -y @knowttl/beyondtrust-axi policy upload --help
npx -y @knowttl/beyondtrust-axi policy upload <policy-uuid> --file <policy-file>
```

## policy auto-assign

Preview policy auto-assign; POST /v3/Groups/AutoAssignPolicyRevision; requires exact file-profile operation permission (replace command spaces with dots); re-reads targets and sends once after exact confirmation and durable private intent. File inputs are secure, at most 10 MiB, with sha256 bound into confirmation. Policy files are sent byte-identically; application additions require UTF-8 JSON..

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send once after re-read and exact confirmation |
| --confirm | Exact confirmation from preview; re-read and file digest must still match |
| --revision | Required revision UUID belonging to this policy |

```sh
npx -y @knowttl/beyondtrust-axi policy auto-assign --help
npx -y @knowttl/beyondtrust-axi policy auto-assign <policy-uuid> --revision <uuid>
```

## policy app add

Preview policy app add; POST /PolicyEditor/v3/Policy/{policyId}/Windows/ApplicationGroups/Applications or POST /PolicyEditor/v3/Policy/{policyId}/MacOS/ApplicationGroups/Applications; requires exact file-profile operation permission (replace command spaces with dots); re-reads targets and sends once after exact confirmation and durable private intent. File inputs are secure, at most 10 MiB, with sha256 bound into confirmation. Policy files are sent byte-identically; application additions require UTF-8 JSON..

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send once after re-read and exact confirmation |
| --confirm | Exact confirmation from preview; re-read and file digest must still match |
| --file | Required JSON array of additions using the committed OS application payload schema; no delete or request envelope; supported types: Windows bat|com|cpl|exe|msc|msi|ps1|reg|rpsc|rpss|unex|wsh, macOS bin|bund|pkg|scr|sudo|pref; maximum 10 MiB |
| --os | Required windows|macos |
| --app-group | Required application group UUID in the policy |

```sh
npx -y @knowttl/beyondtrust-axi policy app add --help
npx -y @knowttl/beyondtrust-axi policy app add <policy-uuid> --os windows --app-group <uuid> --file <apps-file>
```

## home

Show local context without resolving secrets or making API calls.

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |

```sh
npx -y @knowttl/beyondtrust-axi
npx -y @knowttl/beyondtrust-axi home --profile <name>
```

## auth status

Validate local credential readiness without API calls.

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |

```sh
npx -y @knowttl/beyondtrust-axi auth status
npx -y @knowttl/beyondtrust-axi auth status --profile <name>
```

## profile list

List named file profiles without resolving secrets.

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |

```sh
npx -y @knowttl/beyondtrust-axi profile list
npx -y @knowttl/beyondtrust-axi profile list --config <path>
```

## config path

Show effective configuration and state paths.

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |

```sh
npx -y @knowttl/beyondtrust-axi config path
npx -y @knowttl/beyondtrust-axi config path --config <path>
```

## doctor

Verify credentials and API access with a bounded About read.

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |

```sh
npx -y @knowttl/beyondtrust-axi doctor
npx -y @knowttl/beyondtrust-axi doctor --profile <name>
```

## about

Read API versions (GET /v3/About).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |

```sh
npx -y @knowttl/beyondtrust-axi about
npx -y @knowttl/beyondtrust-axi about --profile <name>
```

## task status

Read task detail (GET /v3/Tasks/{id}); a write result is not assumed to be a task ID.

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --id | Required task UUID |

```sh
npx -y @knowttl/beyondtrust-axi task status --id <uuid>
npx -y @knowttl/beyondtrust-axi task status --id <uuid> --fields task
```

## computer authorise

Preview computer authorise; provide 1-20 explicit computer UUIDs or a non-empty computer-list filter selection; filter preview counts matches and shows the first 20 hosts with no maximum count; filter execution requires exact count-bearing confirmation; POST /v3/Computers/Authorise; requires file-profile permission for computer.authorise; sends once without retries.

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send after re-read, exact confirmation and durable private intent |
| --confirm | Exact confirmation from preview; re-read must still match |
| --group | Optional target group UUID |
| --computer-id | Filter ComputerId (string) |
| --host | Filter Host (string) |
| --host-type | Filter HostType (Undefined|MicrosoftWindows|AppleMacOS|Linux) |
| --agent-version | Filter AgentVersion (string) |
| --adapter-version | Filter AdapterVersion (string) |
| --package-manager-version | Filter PackageManagerVersion (string) |
| --authorisation-state | Filter AuthorisationState (string) |
| --last-connected-dates | Filter LastConnected Dates (array; comma-separated) |
| --last-connected-selection-mode | Filter LastConnected SelectionMode (Single|Multiple|Range) |
| --policy-revision-status | Filter PolicyRevisionStatus (string) |
| --policy-id | Filter PolicyId (string) |
| --policy-name | Filter PolicyName (string) |
| --host-policy-name | Filter HostPolicyName (string) |
| --group-id | Filter GroupId (string) |
| --group-name | Filter GroupName (string) |
| --os | Filter OS (Windows|Mac) |
| --domain | Filter Domain (string) |
| --created-dates | Filter Created Dates (array; comma-separated) |
| --created-selection-mode | Filter Created SelectionMode (Single|Multiple|Range) |
| --duplicate-count-min | Filter DuplicateCount Min (integer) |
| --duplicate-count-max | Filter DuplicateCount Max (integer) |
| --connection-status | Filter ConnectionStatus (array; comma-separated) |
| --days-disconnected | Filter DaysDisconnected (integer) |
| --days-since-archived | Filter DaysSinceArchived (integer) |

```sh
npx -y @knowttl/beyondtrust-axi computer authorise <uuid>
npx -y @knowttl/beyondtrust-axi computer authorise <uuid> --execute --confirm '<exact confirmation>'
npx -y @knowttl/beyondtrust-axi computer authorise --host example
```

## computer reject

Preview computer reject; positional computer UUIDs required (maximum 20); POST /v3/Computers/Reject; requires file-profile permission for computer.reject; sends once without retries.

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send after re-read, exact confirmation and durable private intent |
| --confirm | Exact confirmation from preview; re-read must still match |

```sh
npx -y @knowttl/beyondtrust-axi computer reject <uuid>
npx -y @knowttl/beyondtrust-axi computer reject <uuid> --execute --confirm '<exact confirmation>'
```

## computer archive

Preview computer archive; positional computer UUIDs required (maximum 20); POST /v3/Computers/{computerId}/archive or /v3/Computers/archive; requires file-profile permission for computer.archive; sends once without retries.

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send after re-read, exact confirmation and durable private intent |
| --confirm | Exact confirmation from preview; re-read must still match |

```sh
npx -y @knowttl/beyondtrust-axi computer archive <uuid>
npx -y @knowttl/beyondtrust-axi computer archive <uuid> --execute --confirm '<exact confirmation>'
```

## computer unarchive

Preview computer unarchive; positional computer UUIDs required (maximum 20); POST /v3/Computers/{computerId}/Unarchive or /v3/Computers/Unarchive; requires file-profile permission for computer.unarchive; sends once without retries.

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send after re-read, exact confirmation and durable private intent |
| --confirm | Exact confirmation from preview; re-read must still match |

```sh
npx -y @knowttl/beyondtrust-axi computer unarchive <uuid>
npx -y @knowttl/beyondtrust-axi computer unarchive <uuid> --execute --confirm '<exact confirmation>'
```

## computer logs request

Preview computer logs request; positional computer UUIDs required (maximum 1); POST /v3/Computers/Logs/Request; requires file-profile permission for computer.logs.request; sends once without retries.

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send after re-read, exact confirmation and durable private intent |
| --confirm | Exact confirmation from preview; re-read must still match |

```sh
npx -y @knowttl/beyondtrust-axi computer logs request <uuid>
npx -y @knowttl/beyondtrust-axi computer logs request <uuid> --execute --confirm '<exact confirmation>'
```

## computer details request

Preview computer details request; positional computer UUIDs required (maximum 1); POST /v3/Computers/Details/Request; requires file-profile permission for computer.details.request; sends once without retries.

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send after re-read, exact confirmation and durable private intent |
| --confirm | Exact confirmation from preview; re-read must still match |

```sh
npx -y @knowttl/beyondtrust-axi computer details request <uuid>
npx -y @knowttl/beyondtrust-axi computer details request <uuid> --execute --confirm '<exact confirmation>'
```

## computer log download

Download raw bytes (GET /v3/Computers/Logs/{id}/Content); requires file-profile downloads.allow; new 0600 file only, maximum 50 MiB.

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --out | Required new destination file; never overwritten |

```sh
npx -y @knowttl/beyondtrust-axi computer log download <uuid> --out <file>
npx -y @knowttl/beyondtrust-axi computer log download --help
```

## policy download

Download raw bytes (GET /v3/Policies/{id}/Content); requires file-profile downloads.allow; new 0600 file only, maximum 50 MiB.

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --out | Required new destination file; never overwritten |

```sh
npx -y @knowttl/beyondtrust-axi policy download <uuid> --out <file>
npx -y @knowttl/beyondtrust-axi policy download --help
```

## policy revision download

Download raw bytes (GET /v3/Policies/PolicyRevision/{policyRevisionId}/Content); requires file-profile downloads.allow; new 0600 file only, maximum 50 MiB.

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --out | Required new destination file; never overwritten |

```sh
npx -y @knowttl/beyondtrust-axi policy revision download <uuid> --out <file>
npx -y @knowttl/beyondtrust-axi policy revision download --help
```

## api-definition download

Download raw bytes (GET /v3/File/download/GetYamlApiDefinitionFile); requires file-profile downloads.allow; new 0600 file only, maximum 50 MiB.

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --out | Required new destination file; never overwritten |

```sh
npx -y @knowttl/beyondtrust-axi api-definition download --out <file>
npx -y @knowttl/beyondtrust-axi api-definition download --help
```

## group create

Preview group create; POST /v3/Groups; requires file-profile permission for group.create; re-reads targets and sends once without retries. Group IDs and explicit computer selections are limited to 20. Computer filters count matches and preview the first 20 hosts without a maximum count. CSV imports require a secure UTF-8 file up to 10 MiB and bind its sha256 into confirmation..

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send after re-read, exact confirmation and durable private intent |
| --confirm | Exact confirmation from preview; re-read must still match |
| --name | Group name (required for create) |
| --description | Group description |
| --default | Create as the default group (default: false) |

```sh
npx -y @knowttl/beyondtrust-axi group create --help
npx -y @knowttl/beyondtrust-axi group create --name example
```

## group update

Preview group update; PUT /v3/Groups; requires file-profile permission for group.update; re-reads targets and sends once without retries. Group IDs and explicit computer selections are limited to 20. Computer filters count matches and preview the first 20 hosts without a maximum count. CSV imports require a secure UTF-8 file up to 10 MiB and bind its sha256 into confirmation..

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send after re-read, exact confirmation and durable private intent |
| --confirm | Exact confirmation from preview; re-read must still match |
| --name | Group name (required for create) |
| --description | Group description |

```sh
npx -y @knowttl/beyondtrust-axi group update --help
npx -y @knowttl/beyondtrust-axi group update <group-uuid> --name example
```

## group set-default

Preview group set-default; PATCH /v3/Groups/{id}/MarkAsDefault; requires file-profile permission for group.set-default; re-reads targets and sends once without retries. Group IDs and explicit computer selections are limited to 20. Computer filters count matches and preview the first 20 hosts without a maximum count. CSV imports require a secure UTF-8 file up to 10 MiB and bind its sha256 into confirmation..

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send after re-read, exact confirmation and durable private intent |
| --confirm | Exact confirmation from preview; re-read must still match |

```sh
npx -y @knowttl/beyondtrust-axi group set-default --help
npx -y @knowttl/beyondtrust-axi group set-default <group-uuid>
```

## group assign-policy

Preview group assign-policy; POST /v3/Groups/{id}/AssignPolicyRevision or POST /v3/Groups/AssignPolicyToMultipleGroups; requires file-profile permission for group.assign-policy; re-reads targets and sends once without retries. Group IDs and explicit computer selections are limited to 20. Computer filters count matches and preview the first 20 hosts without a maximum count. CSV imports require a secure UTF-8 file up to 10 MiB and bind its sha256 into confirmation..

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send after re-read, exact confirmation and durable private intent |
| --confirm | Exact confirmation from preview; re-read must still match |
| --revision | Required policy revision UUID |

```sh
npx -y @knowttl/beyondtrust-axi group assign-policy --help
npx -y @knowttl/beyondtrust-axi group assign-policy <group-uuid> --revision <uuid>
```

## group clear-policy

Preview group clear-policy; PATCH /v3/Groups/{id}/ClearPolicy or POST /v3/Groups/bulkclearpolicy; requires file-profile permission for group.clear-policy; re-reads targets and sends once without retries. Group IDs and explicit computer selections are limited to 20. Computer filters count matches and preview the first 20 hosts without a maximum count. CSV imports require a secure UTF-8 file up to 10 MiB and bind its sha256 into confirmation..

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send after re-read, exact confirmation and durable private intent |
| --confirm | Exact confirmation from preview; re-read must still match |

```sh
npx -y @knowttl/beyondtrust-axi group clear-policy --help
npx -y @knowttl/beyondtrust-axi group clear-policy <group-uuid>
```

## group add-computers

Preview group add-computers; POST /v3/Groups/{id}/AssignComputers; requires file-profile permission for group.add-computers; re-reads targets and sends once without retries. Group IDs and explicit computer selections are limited to 20. Computer filters count matches and preview the first 20 hosts without a maximum count. CSV imports require a secure UTF-8 file up to 10 MiB and bind its sha256 into confirmation..

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send after re-read, exact confirmation and durable private intent |
| --confirm | Exact confirmation from preview; re-read must still match |
| --computer-id | Filter ComputerId (string) |
| --host | Filter Host (string) |
| --host-type | Filter HostType (Undefined|MicrosoftWindows|AppleMacOS|Linux) |
| --agent-version | Filter AgentVersion (string) |
| --adapter-version | Filter AdapterVersion (string) |
| --package-manager-version | Filter PackageManagerVersion (string) |
| --authorisation-state | Filter AuthorisationState (string) |
| --last-connected-dates | Filter LastConnected Dates (array; comma-separated) |
| --last-connected-selection-mode | Filter LastConnected SelectionMode (Single|Multiple|Range) |
| --policy-revision-status | Filter PolicyRevisionStatus (string) |
| --policy-id | Filter PolicyId (string) |
| --policy-name | Filter PolicyName (string) |
| --host-policy-name | Filter HostPolicyName (string) |
| --group-id | Filter GroupId (string) |
| --group-name | Filter GroupName (string) |
| --os | Filter OS (Windows|Mac) |
| --domain | Filter Domain (string) |
| --created-dates | Filter Created Dates (array; comma-separated) |
| --created-selection-mode | Filter Created SelectionMode (Single|Multiple|Range) |
| --duplicate-count-min | Filter DuplicateCount Min (integer) |
| --duplicate-count-max | Filter DuplicateCount Max (integer) |
| --connection-status | Filter ConnectionStatus (array; comma-separated) |
| --days-disconnected | Filter DaysDisconnected (integer) |
| --days-since-archived | Filter DaysSinceArchived (integer) |

```sh
npx -y @knowttl/beyondtrust-axi group add-computers --help
npx -y @knowttl/beyondtrust-axi group add-computers <group-uuid> <computer-uuid>
```

## group import-computers

Preview group import-computers; POST /v3/Groups/{id}/AssignComputersByCsv; requires file-profile permission for group.import-computers; re-reads targets and sends once without retries. Group IDs and explicit computer selections are limited to 20. Computer filters count matches and preview the first 20 hosts without a maximum count. CSV imports require a secure UTF-8 file up to 10 MiB and bind its sha256 into confirmation..

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send after re-read, exact confirmation and durable private intent |
| --confirm | Exact confirmation from preview; re-read must still match |
| --file | Required CSV input file, maximum 10 MiB |

```sh
npx -y @knowttl/beyondtrust-axi group import-computers --help
npx -y @knowttl/beyondtrust-axi group import-computers <group-uuid> --file <csv>
```

## group remove-computers

Preview group remove-computers; POST /v3/Groups/UnassignComputers; requires file-profile permission for group.remove-computers; re-reads targets and sends once without retries. Group IDs and explicit computer selections are limited to 20. Computer filters count matches and preview the first 20 hosts without a maximum count. CSV imports require a secure UTF-8 file up to 10 MiB and bind its sha256 into confirmation..

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --execute | Send after re-read, exact confirmation and durable private intent |
| --confirm | Exact confirmation from preview; re-read must still match |
| --computer-id | Filter ComputerId (string) |
| --host | Filter Host (string) |
| --host-type | Filter HostType (Undefined|MicrosoftWindows|AppleMacOS|Linux) |
| --agent-version | Filter AgentVersion (string) |
| --adapter-version | Filter AdapterVersion (string) |
| --package-manager-version | Filter PackageManagerVersion (string) |
| --authorisation-state | Filter AuthorisationState (string) |
| --last-connected-dates | Filter LastConnected Dates (array; comma-separated) |
| --last-connected-selection-mode | Filter LastConnected SelectionMode (Single|Multiple|Range) |
| --policy-revision-status | Filter PolicyRevisionStatus (string) |
| --policy-id | Filter PolicyId (string) |
| --policy-name | Filter PolicyName (string) |
| --host-policy-name | Filter HostPolicyName (string) |
| --group-id | Filter GroupId (string) |
| --group-name | Filter GroupName (string) |
| --os | Filter OS (Windows|Mac) |
| --domain | Filter Domain (string) |
| --created-dates | Filter Created Dates (array; comma-separated) |
| --created-selection-mode | Filter Created SelectionMode (Single|Multiple|Range) |
| --duplicate-count-min | Filter DuplicateCount Min (integer) |
| --duplicate-count-max | Filter DuplicateCount Max (integer) |
| --connection-status | Filter ConnectionStatus (array; comma-separated) |
| --days-disconnected | Filter DaysDisconnected (integer) |
| --days-since-archived | Filter DaysSinceArchived (integer) |

```sh
npx -y @knowttl/beyondtrust-axi group remove-computers --help
npx -y @knowttl/beyondtrust-axi group remove-computers <computer-uuid>
```

## computer list

Read computer list (GET /v3/Computers).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --limit | Maximum rows, 1-1000 (default: 50) |
| --all | Read up to 1000 rows within 10 requests, 60 seconds and 8 MiB |
| --cursor | Resume an opaque cursor with the same profile, command and filters |
| --computer-id | Filter ComputerId (string) |
| --host | Filter Host (string) |
| --host-type | Filter HostType (Undefined|MicrosoftWindows|AppleMacOS|Linux) |
| --agent-version | Filter AgentVersion (string) |
| --adapter-version | Filter AdapterVersion (string) |
| --package-manager-version | Filter PackageManagerVersion (string) |
| --authorisation-state | Filter AuthorisationState (string) |
| --last-connected-dates | Filter LastConnected Dates (array; comma-separated) |
| --last-connected-selection-mode | Filter LastConnected SelectionMode (Single|Multiple|Range) |
| --policy-revision-status | Filter PolicyRevisionStatus (string) |
| --policy-id | Filter PolicyId (string) |
| --policy-name | Filter PolicyName (string) |
| --host-policy-name | Filter HostPolicyName (string) |
| --group-id | Filter GroupId (string) |
| --group-name | Filter GroupName (string) |
| --os | Filter OS (Windows|Mac) |
| --domain | Filter Domain (string) |
| --created-dates | Filter Created Dates (array; comma-separated) |
| --created-selection-mode | Filter Created SelectionMode (Single|Multiple|Range) |
| --duplicate-count-min | Filter DuplicateCount Min (integer) |
| --duplicate-count-max | Filter DuplicateCount Max (integer) |
| --connection-status | Filter ConnectionStatus (array; comma-separated) |
| --days-disconnected | Filter DaysDisconnected (integer) |
| --days-since-archived | Filter DaysSinceArchived (integer) |

```sh
npx -y @knowttl/beyondtrust-axi computer list
npx -y @knowttl/beyondtrust-axi computer list --help
```

## computer view

Read computer view (GET /v3/Computers/{id}).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --id | Required resource UUID |

```sh
npx -y @knowttl/beyondtrust-axi computer view --id <uuid>
npx -y @knowttl/beyondtrust-axi computer view --help
```

## computer command-log

Read computer command log (GET /v3/Computers/{id}/CommandLog).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --id | Required resource UUID |
| --limit | Maximum rows, 1-1000 (default: 50) |
| --all | Read up to 1000 rows within 10 requests, 60 seconds and 8 MiB |
| --cursor | Resume an opaque cursor with the same profile, command and filters |

```sh
npx -y @knowttl/beyondtrust-axi computer command-log --id <uuid>
npx -y @knowttl/beyondtrust-axi computer command-log --help
```

## computer logs

Read computer logs (GET /v3/Computers/{id}/Logs).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --id | Required resource UUID |
| --limit | Maximum rows, 1-1000 (default: 50) |
| --all | Read up to 1000 rows within 10 requests, 60 seconds and 8 MiB |
| --cursor | Resume an opaque cursor with the same profile, command and filters |

```sh
npx -y @knowttl/beyondtrust-axi computer logs --id <uuid>
npx -y @knowttl/beyondtrust-axi computer logs --help
```

## group list

Read group list (GET /v3/Groups).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --limit | Maximum rows, 1-1000 (default: 50) |
| --all | Read up to 1000 rows within 10 requests, 60 seconds and 8 MiB |
| --cursor | Resume an opaque cursor with the same profile, command and filters |
| --sort | Sort property and order, e.g. name:asc (default: created:asc) |
| --id | Filter Id (string) |
| --name | Filter Name (string) |
| --description | Filter Description (string) |
| --policy-name | Filter PolicyName (string) |
| --policy-revision-status | Filter PolicyRevisionStatus (OnAssignedPolicy|AwaitingPolicyUpdate|NoPolicy) |
| --computer-count | Filter ComputerCount (integer) |
| --active-computers-value | Filter ActiveComputers Value (integer) |
| --active-computers-operator | Filter ActiveComputers Operator (EqualTo|LessThan|GreaterThan|LessThanOrEqualTo|GreaterThanOrEqualTo) |
| --created-dates | Filter Created Dates (array; comma-separated) |
| --created-selection-mode | Filter Created SelectionMode (Single|Multiple|Range) |
| --default | Filter Default (boolean) |

```sh
npx -y @knowttl/beyondtrust-axi group list
npx -y @knowttl/beyondtrust-axi group list --help
```

## group view

Read group view (GET /v3/Groups/{id}).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --id | Required resource UUID |

```sh
npx -y @knowttl/beyondtrust-axi group view --id <uuid>
npx -y @knowttl/beyondtrust-axi group view --help
```

## policy list

Read policy list (GET /v3/Policies).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --limit | Maximum rows, 1-1000 (default: 50) |
| --all | Read up to 1000 rows within 10 requests, 60 seconds and 8 MiB |
| --cursor | Resume an opaque cursor with the same profile, command and filters |
| --sort | Sort property and order, e.g. name:asc (default: created:asc) |
| --name | Filter Name (string) |
| --size | Filter Size (integer) |
| --revision | Filter Revision (integer) |
| --total-assigned-revisions | Filter TotalAssignedRevisions (integer) |
| --created-dates | Filter Created Dates (array; comma-separated) |
| --created-selection-mode | Filter Created SelectionMode (Single|Multiple|Range) |
| --draft-user | Filter DraftUser (string) |

```sh
npx -y @knowttl/beyondtrust-axi policy list
npx -y @knowttl/beyondtrust-axi policy list --help
```

## policy view

Read policy view (GET /v3/Policies/{id}).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --id | Required resource UUID |

```sh
npx -y @knowttl/beyondtrust-axi policy view --id <uuid>
npx -y @knowttl/beyondtrust-axi policy view --help
```

## policy revisions

Read policy revisions (GET /v3/Policies/{id}/Revisions).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --id | Required resource UUID |
| --limit | Maximum rows, 1-1000 (default: 50) |
| --all | Read up to 1000 rows within 10 requests, 60 seconds and 8 MiB |
| --cursor | Resume an opaque cursor with the same profile, command and filters |

```sh
npx -y @knowttl/beyondtrust-axi policy revisions --id <uuid>
npx -y @knowttl/beyondtrust-axi policy revisions --help
```

## policy assigned-groups

Read policy assigned groups (GET /v3/Policies/{id}/AssignedGroups).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --id | Required resource UUID |
| --limit | Maximum rows, 1-1000 (default: 50) |
| --all | Read up to 1000 rows within 10 requests, 60 seconds and 8 MiB |
| --cursor | Resume an opaque cursor with the same profile, command and filters |

```sh
npx -y @knowttl/beyondtrust-axi policy assigned-groups --id <uuid>
npx -y @knowttl/beyondtrust-axi policy assigned-groups --help
```

## policy windows-application-groups

Read policy windows application groups (GET /PolicyEditor/v3/Policy/{policyId}/Windows/ApplicationGroups).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --id | Required resource UUID |
| --limit | Maximum rows, 1-1000 (default: 50) |
| --all | Read up to 1000 rows within 10 requests, 60 seconds and 8 MiB |
| --cursor | Resume an opaque cursor with the same profile, command and filters |
| --application-group-name | Filter ApplicationGroupName (string) |
| --application-group-id | Filter ApplicationGroupId (string) |
| --application-description | Filter ApplicationDescription (string) |
| --application-id | Filter ApplicationId (string) |

```sh
npx -y @knowttl/beyondtrust-axi policy windows-application-groups --id <uuid>
npx -y @knowttl/beyondtrust-axi policy windows-application-groups --help
```

## policy macos-application-groups

Read policy macos application groups (GET /PolicyEditor/v3/Policy/{policyId}/MacOS/ApplicationGroups).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --id | Required resource UUID |
| --limit | Maximum rows, 1-1000 (default: 50) |
| --all | Read up to 1000 rows within 10 requests, 60 seconds and 8 MiB |
| --cursor | Resume an opaque cursor with the same profile, command and filters |
| --application-group-name | Filter ApplicationGroupName (string) |
| --application-group-id | Filter ApplicationGroupId (string) |
| --application-description | Filter ApplicationDescription (string) |
| --application-id | Filter ApplicationId (string) |

```sh
npx -y @knowttl/beyondtrust-axi policy macos-application-groups --id <uuid>
npx -y @knowttl/beyondtrust-axi policy macos-application-groups --help
```

## user list

Read user list (GET /v3/Users).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --limit | Maximum rows, 1-1000 (default: 50) |
| --all | Read up to 1000 rows within 10 requests, 60 seconds and 8 MiB |
| --cursor | Resume an opaque cursor with the same profile, command and filters |
| --sort | Sort property and order, e.g. name:asc (default: created:asc) |
| --email-address | Filter EmailAddress (string) |
| --role-id | Filter RoleId (string) |
| --permission-id | Filter PermissionId (string) |
| --last-signed-in-dates | Filter LastSignedIn Dates (array; comma-separated) |
| --last-signed-in-selection-mode | Filter LastSignedIn SelectionMode (Single|Multiple|Range) |
| --disabled | Filter Disabled (boolean) |
| --language | Filter Language (string) |

```sh
npx -y @knowttl/beyondtrust-axi user list
npx -y @knowttl/beyondtrust-axi user list --help
```

## user show

Read user show (GET /v3/Users/{id}).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --id | Required resource UUID |

```sh
npx -y @knowttl/beyondtrust-axi user show --id <uuid>
npx -y @knowttl/beyondtrust-axi user show --help
```

## role list

Read role list (GET /v3/Roles).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --limit | Maximum rows, 1-1000 (default: 50) |
| --all | Read up to 1000 rows within 10 requests, 60 seconds and 8 MiB |
| --cursor | Resume an opaque cursor with the same profile, command and filters |

```sh
npx -y @knowttl/beyondtrust-axi role list
npx -y @knowttl/beyondtrust-axi role list --help
```

## role show

Read role show (GET /v3/Roles/{id}).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --id | Required resource UUID |

```sh
npx -y @knowttl/beyondtrust-axi role show --id <uuid>
npx -y @knowttl/beyondtrust-axi role show --help
```

## global-role list

Read global role list (GET /v3/GlobalRoles).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --limit | Maximum rows, 1-1000 (default: 50) |
| --all | Read up to 1000 rows within 10 requests, 60 seconds and 8 MiB |
| --cursor | Resume an opaque cursor with the same profile, command and filters |
| --sort | Sort property and order, e.g. name:asc (default: created:asc) |
| --id | Filter Id (string) |
| --name | Filter Name (string) |
| --description | Filter Description (string) |
| --is-built-in | Filter IsBuiltIn (boolean) |

```sh
npx -y @knowttl/beyondtrust-axi global-role list
npx -y @knowttl/beyondtrust-axi global-role list --help
```

## global-role show

Read global role show (GET /v3/GlobalRoles/{id}).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --id | Required resource UUID |

```sh
npx -y @knowttl/beyondtrust-axi global-role show --id <uuid>
npx -y @knowttl/beyondtrust-axi global-role show --help
```

## domain list

Read domain list (GET /v3/AcceptedDomains).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --limit | Maximum rows, 1-1000 (default: 50) |
| --all | Read up to 1000 rows within 10 requests, 60 seconds and 8 MiB |
| --cursor | Resume an opaque cursor with the same profile, command and filters |

```sh
npx -y @knowttl/beyondtrust-axi domain list
npx -y @knowttl/beyondtrust-axi domain list --help
```

## domain show

Read domain show (GET /v3/AcceptedDomains/{id}).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --id | Required resource UUID |

```sh
npx -y @knowttl/beyondtrust-axi domain show --id <uuid>
npx -y @knowttl/beyondtrust-axi domain show --help
```

## api-account list

Read api account list (GET /v3/ApiAccounts).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --limit | Maximum rows, 1-1000 (default: 50) |
| --all | Read up to 1000 rows within 10 requests, 60 seconds and 8 MiB |
| --cursor | Resume an opaque cursor with the same profile, command and filters |

```sh
npx -y @knowttl/beyondtrust-axi api-account list
npx -y @knowttl/beyondtrust-axi api-account list --help
```

## auth-provider show

Read auth provider show (GET /v3/AuthenticationProvider).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |

```sh
npx -y @knowttl/beyondtrust-axi auth-provider show
npx -y @knowttl/beyondtrust-axi auth-provider show --help
```

## scim resource-types

Read scim resource types; optional positional type: user|role (default: list all resource types) (GET /scim/v3/ResourceTypes[/User|/Role]).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --limit | Maximum rows, 1-1000 (default: 50) |
| --all | Read up to 1000 rows within 10 requests, 60 seconds and 8 MiB |
| --cursor | Resume an opaque cursor with the same profile, command and filters |

```sh
npx -y @knowttl/beyondtrust-axi scim resource-types
npx -y @knowttl/beyondtrust-axi scim resource-types user
npx -y @knowttl/beyondtrust-axi scim resource-types role
npx -y @knowttl/beyondtrust-axi scim resource-types --help
```

## scim schemas

Read scim schemas (GET /scim/v3/Schemas).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --limit | Maximum rows, 1-1000 (default: 50) |
| --all | Read up to 1000 rows within 10 requests, 60 seconds and 8 MiB |
| --cursor | Resume an opaque cursor with the same profile, command and filters |

```sh
npx -y @knowttl/beyondtrust-axi scim schemas
npx -y @knowttl/beyondtrust-axi scim schemas --help
```

## scim config

Read scim config (GET /scim/v3/ServiceProviderConfig).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |

```sh
npx -y @knowttl/beyondtrust-axi scim config
npx -y @knowttl/beyondtrust-axi scim config --help
```

## scim role list

Read scim role list (GET /scim/v3/Roles).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --limit | Maximum rows, 1-1000 (default: 50) |
| --all | Read up to 1000 rows within 10 requests, 60 seconds and 8 MiB |
| --cursor | Resume an opaque cursor with the same profile, command and filters |
| --filter | SCIM filter expression (sent literally) |

```sh
npx -y @knowttl/beyondtrust-axi scim role list
npx -y @knowttl/beyondtrust-axi scim role list --help
```

## scim user list

Read scim user list (GET /scim/v3/users).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --limit | Maximum rows, 1-1000 (default: 50) |
| --all | Read up to 1000 rows within 10 requests, 60 seconds and 8 MiB |
| --cursor | Resume an opaque cursor with the same profile, command and filters |
| --filter | SCIM filter expression (sent literally) |

```sh
npx -y @knowttl/beyondtrust-axi scim user list
npx -y @knowttl/beyondtrust-axi scim user list --help
```

## scim user show

Read scim user show (GET /scim/v3/users/{userID}).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --id | Required resource UUID |

```sh
npx -y @knowttl/beyondtrust-axi scim user show --id <uuid>
npx -y @knowttl/beyondtrust-axi scim user show --help
```

## event list

Read event list (GET /v3/Events/FromStartDate).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete redacted ECS event objects instead of compact columns |
| --help | Show command help |
| --limit | Maximum rows, 1-1000 (default: 50) |
| --all | Read up to 1000 rows within 10 requests, 60 seconds and 8 MiB |
| --cursor | Resume an opaque cursor with the same profile, command and filters |
| --since | UTC start time (default: 24 hours before end; maximum window: 31 days) |

```sh
npx -y @knowttl/beyondtrust-axi event list
npx -y @knowttl/beyondtrust-axi event list --help
```

## event search

Read event search (GET /v3/Events/search).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete redacted ECS event objects instead of compact columns |
| --help | Show command help |
| --limit | Maximum rows, 1-1000 (default: 50) |
| --all | Read up to 1000 rows within 10 requests, 60 seconds and 8 MiB |
| --cursor | Resume an opaque cursor with the same profile, command and filters |
| --since | UTC start time (default: 24 hours before end; maximum window: 31 days) |
| --until | UTC end time (default: now) |
| --group | ComputerGroups; arrays use comma-separated values |
| --os | OperatingSystem (required); arrays use comma-separated values |
| --action | Events EventAction; arrays use comma-separated values |
| --code | Events EventCode; arrays use comma-separated values |
| --type | Events EventType; arrays use comma-separated values |
| --app-type | Application ApplicationType; arrays use comma-separated values |
| --host | Computers HostName; arrays use comma-separated values |
| --domain | Computers HostDomain; arrays use comma-separated values |
| --user | Users UserName; arrays use comma-separated values |
| --workstyle | Policies WorkstyleName; arrays use comma-separated values |
| --app-group | Policies ApplicationGroupName; arrays use comma-separated values |
| --on-demand | Policies OnDemandRule; arrays use comma-separated values |

```sh
npx -y @knowttl/beyondtrust-axi event search --os Windows
npx -y @knowttl/beyondtrust-axi event search --help
```

## audit activity list

Read audit activity list (GET /v3/ActivityAudits).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --limit | Maximum rows, 1-1000 (default: 50) |
| --all | Read up to 1000 rows within 10 requests, 60 seconds and 8 MiB |
| --cursor | Resume an opaque cursor with the same profile, command and filters |
| --sort | Sort property and order, e.g. name:asc (default: created:asc) |
| --user | Filter User (string) |
| --details | Filter Details (string) |
| --created-dates | Filter Created Dates (array; comma-separated) |
| --created-selection-mode | Filter Created SelectionMode (Single|Multiple|Range) |
| --entity | Filter Entity (string) |
| --audit-type | Filter AuditType (string) |
| --changed-by | Filter ChangedBy (API|Portal|ManagementRule|Pathfinder) |

```sh
npx -y @knowttl/beyondtrust-axi audit activity list
npx -y @knowttl/beyondtrust-axi audit activity list --help
```

## audit activity show

Read audit activity show (GET /v3/ActivityAudits/{id}).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --id | Required resource int64 |
| --limit | Maximum rows, 1-1000 (default: 50) |
| --all | Read up to 1000 rows within 10 requests, 60 seconds and 8 MiB |
| --cursor | Resume an opaque cursor with the same profile, command and filters |

```sh
npx -y @knowttl/beyondtrust-axi audit activity show --id <int64>
npx -y @knowttl/beyondtrust-axi audit activity show --help
```

## audit activity details

Read audit activity details (GET /v3/ActivityAudits/Details).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --limit | Maximum rows, 1-1000 (default: 50) |
| --all | Read up to 1000 rows within 10 requests, 60 seconds and 8 MiB |
| --cursor | Resume an opaque cursor with the same profile, command and filters |
| --sort | Sort property and order, e.g. name:asc (default: created:asc) |
| --user | Filter User (string) |
| --details | Filter Details (string) |
| --created-dates | Filter Created Dates (array; comma-separated) |
| --created-selection-mode | Filter Created SelectionMode (Single|Multiple|Range) |
| --entity | Filter Entity (string) |
| --audit-type | Filter AuditType (string) |
| --changed-by | Filter ChangedBy (API|Portal|ManagementRule|Pathfinder) |

```sh
npx -y @knowttl/beyondtrust-axi audit activity details
npx -y @knowttl/beyondtrust-axi audit activity details --help
```

## audit auth-request list

Read audit auth request list (GET /v3/AuthorizationRequestAudits).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --limit | Maximum rows, 1-1000 (default: 50) |
| --all | Read up to 1000 rows within 10 requests, 60 seconds and 8 MiB |
| --cursor | Resume an opaque cursor with the same profile, command and filters |
| --sort | Sort property and order, e.g. name:asc (default: created:asc) |
| --ticket-id | Filter TicketId (string) |
| --user | Filter User (string) |
| --computer-name | Filter ComputerName (string) |
| --product-name | Filter ProductName (string) |
| --reason | Filter Reason (string) |
| --decision-performed-by-user | Filter DecisionPerformedByUser (string) |
| --decision | Filter Decision (string) |
| --time-of-request-dates | Filter TimeOfRequest Dates (array; comma-separated) |
| --time-of-request-selection-mode | Filter TimeOfRequest SelectionMode (Single|Multiple|Range) |
| --decision-time-dates | Filter DecisionTime Dates (array; comma-separated) |
| --decision-time-selection-mode | Filter DecisionTime SelectionMode (Single|Multiple|Range) |
| --start-time-dates | Filter StartTime Dates (array; comma-separated) |
| --start-time-selection-mode | Filter StartTime SelectionMode (Single|Multiple|Range) |
| --duration | Filter Duration (string) |

```sh
npx -y @knowttl/beyondtrust-axi audit auth-request list
npx -y @knowttl/beyondtrust-axi audit auth-request list --help
```

## audit auth-request show

Read audit auth request show (GET /v3/AuthorizationRequestAudits/{id}).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --id | Required resource int64 |
| --limit | Maximum rows, 1-1000 (default: 50) |
| --all | Read up to 1000 rows within 10 requests, 60 seconds and 8 MiB |
| --cursor | Resume an opaque cursor with the same profile, command and filters |

```sh
npx -y @knowttl/beyondtrust-axi audit auth-request show --id <int64>
npx -y @knowttl/beyondtrust-axi audit auth-request show --help
```

## admin-request list

Read admin request list (GET /v3/AdminAccessRequest).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --limit | Maximum rows, 1-1000 (default: 50) |
| --all | Read up to 1000 rows within 10 requests, 60 seconds and 8 MiB |
| --cursor | Resume an opaque cursor with the same profile, command and filters |
| --sort | Sort property and order, e.g. name:asc (default: created:asc) |
| --decision | Filter Decision (string) |
| --created-on | Filter CreatedOn (string) |
| --active-only | Filter ActiveOnly (boolean) |
| --modified-on | Filter ModifiedOn (string) |
| --computer-id | Filter ComputerId (string) |
| --endpoint-user-id | Filter EndpointUserId (string) |
| --endpoint-user-name | Filter EndpointUserName (string) |

```sh
npx -y @knowttl/beyondtrust-axi admin-request list
npx -y @knowttl/beyondtrust-axi admin-request list --help
```

## admin-request show

Read admin request show (GET /v3/AdminAccessRequest/{requestId}).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --id | Required resource UUID |
| --limit | Maximum rows, 1-1000 (default: 50) |
| --all | Read up to 1000 rows within 10 requests, 60 seconds and 8 MiB |
| --cursor | Resume an opaque cursor with the same profile, command and filters |

```sh
npx -y @knowttl/beyondtrust-axi admin-request show --id <uuid>
npx -y @knowttl/beyondtrust-axi admin-request show --help
```

## auth-request list

Read auth request list (GET /v3/AuthorizationRequest).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --limit | Maximum rows, 1-1000 (default: 50) |
| --all | Read up to 1000 rows within 10 requests, 60 seconds and 8 MiB |
| --cursor | Resume an opaque cursor with the same profile, command and filters |
| --sort | Sort property and order, e.g. name:asc (default: created:asc) |
| --decision | Filter Decision (string) |
| --created-on | Filter CreatedOn (string) |
| --active-only | Filter ActiveOnly (boolean) |
| --modified-on | Filter ModifiedOn (string) |

```sh
npx -y @knowttl/beyondtrust-axi auth-request list
npx -y @knowttl/beyondtrust-axi auth-request list --help
```

## auth-request show

Read auth request show (GET /v3/AuthorizationRequest/{systemId}).

| Flag | Meaning |
|---|---|
| --config | Configuration file path (default: platform config directory) |
| --profile | Named file profile (default: selection precedence) |
| --fields | Comma-separated output fields (default: all) |
| --full | Show complete strings |
| --help | Show command help |
| --id | Required resource string |
| --limit | Maximum rows, 1-1000 (default: 50) |
| --all | Read up to 1000 rows within 10 requests, 60 seconds and 8 MiB |
| --cursor | Resume an opaque cursor with the same profile, command and filters |

```sh
npx -y @knowttl/beyondtrust-axi auth-request show --id <string>
npx -y @knowttl/beyondtrust-axi auth-request show --help
```
