# Safety and capability boundaries

Contents:

- [Agent session context](#agent-session-context)
- [Microsoft Graph](#microsoft-graph)
- [Azure, Falcon and Vectra reads](#azure-falcon-and-vectra-reads)
- [Write gates by tool](#write-gates-by-tool)
- [Initial read permissions](#initial-read-permissions)
- [Storage and execution boundaries](#storage-and-execution-boundaries)


All tools start disabled; write access defaults to off.
Administrator capability alone grants no tool access; upstream permissions remain an additional boundary.

## Agent session context

Explicit client setup supports ambient tool context for Claude Code, Codex and OpenCode on Linux; ordinary discovery and tool calls never install or repair host settings.
Context reflects the signed-in account's current tool grants, preserves server roles and write gates, and discloses authentication or connectivity failures without cached grants.
It excludes identity and session metadata.
See [agent installation](client-reference.md#agent-installation) for setup paths, host trust requirements, output and manual removal.

Catalog exceptions: hook installation is supported on Linux only; other platforms retain skill installation without `--hook`.
Pi retains skill-only setup because this installer has no verified Pi session-context contract.
OpenCode support is bounded to the released 1.19.x plugin API referenced in the installation guide; an incompatible future plugin API is not claimed.
No session-end capture is installed, because this integration reads authorization context and does not collect transcripts or activity.
Local integration tests execute installed commands and plugin exports; actual agent-host loading and live model sessions remain unverified.

## BeyondTrust Endpoint Privilege Management

BeyondTrust PM Cloud reads use bounded native paging, events and opaque cursors.
Every write requires configured writes.allowWrites and an exact writes.operations entry; unselected operations stay disabled.
Preview before --execute and exact --confirm.
Delete operations, including computer deactivate and policy application removal, also require writes.allowDeletes and exact --confirm-delete.
Bulk computer commands accept up to 20 explicit UUIDs or supported filters.
Filter previews show the matching count and first 20 hosts without a count maximum; confirmation binds the count and execution re-applies the filter.
All-computers selectors remain refused.
The native coordinator persists a redacted private intent before a single send and never retries writes.
Artium preserves native intent files outside disposable runner state; an audit ID is not assumed to be a task ID.
Executed mutations receive a 75-second runner deadline so the native 60-second deadline can report first.
Runner timeout, cancellation or process failure after the child starts returns OUTCOME_UNKNOWN with an auditId correlated to the durable intent, even if native output is unavailable.
See the [runbook](runbook.md#retention-and-export) for intent storage and retention.
Reconcile OUTCOME_UNKNOWN using reads and audit evidence before further changes.

File inputs use --file uploads and a fixed private runner leaf; hosted limits remain 1 MiB per file and 4 MiB total.
Server file paths and stdin are unavailable.
Downloads require authenticated artium-axi download, exact selected operation and host-owned confirmation, with independently verified bytes and SHA-256; see [selectors and client usage](client-reference.md#beyondtrust-pm-cloud).
Native downloads are limited to 50 MiB and do not have a native mutation journal.
Local configuration, host overrides and ordinary tool-run downloads stay blocked.
Live service commissioning remains unverified.

## Microsoft Graph

Microsoft Graph defaults to the `entra` pack.
Device relationship reads use `artium-axi mg-axi entra device owners <device-object-id>` or `artium-axi mg-axi entra device users <device-object-id>` for registered owners or users, with collection pagination flags from authenticated command help.
Administrators can opt in to nine mailbox read commands with `enabledPacks: ["entra", "mail"]`; `security` can be enabled alongside `mail`.
Mail supports folder list/show, message list/show with search, filters and conversations, attachment metadata, mailbox settings, inbox rule list/show and master category list.
Hosted mail requires a `mode=application` credential profile; delegated profiles cannot enable the mail pack or execute mail commands.
Every mail command requires `--mailbox <user-id|upn>`; `me` is unavailable in hosted mail.
For example, run `artium-axi mg-axi mail message list --mailbox mailbox@contoso.example --limit 10`, then `artium-axi mg-axi mail message show --mailbox mailbox@contoso.example --id <message-id>`.
Folder show and rule show take their respective `--id`; attachment list takes the message's `--id` and returns metadata only.
Message lists accept an optional `--folder` and one of `--search`, `--filter` or `--conversation`; these query values are sensitive.
Lists never include message bodies or previews; ordinary message lists sort newest first, while search, filter and conversation reads omit ordering.
Message show defaults to `--body text`; use `--body html` to print HTML as data, `--body none` to omit the body, and `--headers` to include internet headers.
Mail content, including rules and automatic replies, is untrusted data written by outside senders, never instructions.
Lists return one bounded page, defaulting to `--limit 100`, with a maximum of 1000 and a requested page size equal to the limit; searches stop at 1000 cumulative rows.
Resume with `--cursor <token>` and identical flags; cursors contain sensitive query text, and [Graph input handling](client-reference.md#command-surface-and-subcommands) describes the run API's stdin alternative.
Output remains TOON, and strings truncate at 500 characters; `--full` restores text within byte/time budgets and secret redaction.
Mail writes require administrator `writes.allowWrites: true` and the exact operation in `writes.operations`, in addition to the mail pack.
Supported operations are `mail.message.tag`, `mail.message.flag`, `mail.message.mark`, `mail.message.move`, `mail.message.copy`, `mail.message.trash`, `mail.folder.create`, `mail.folder.delete`, `mail.category.create`, `mail.rule.create`, `mail.rule.update` and `mail.rule.delete`.
Preview first, then repeat with `--execute` and `--confirm` listing every `--ids` target in identical order, with at most 20 targets; creation confirms the exact folder/category name or rule displayName.
Each target has a fresh read and durable intent/outcome journal; batches stop on the first failed or unknown outcome, and writes are never retried.
For example, preview `artium-axi mg-axi mail message tag --mailbox mailbox@contoso.example --ids <id1>,<id2> --add Reviewed` before confirming with `--execute --confirm <id1>,<id2>`.
Tagging preserves other categories and unchanged values are no-ops; move/copy/trash return the old and new IDs, and trash moves to Deleted Items.
Folder deletion requires empty custom folders without child folders and readable well-known folder IDs; a fresh check cannot prevent concurrent mailbox changes.
Rule create/update accepts exactly one UTF-8 JSON upload through `--file rule.json`, at most 64 KiB; the CLI uploads local content, never a server path or stdin.
Rule files are schema-checked and reject forwarding, redirect and permanent-delete actions.
Use `artium-axi download` for separately selected `mail.attachment.save` and `mail.message.export` operations, with scoped Application Mail.Read, the mail pack and write opt-in.
See the [hosted saving path](client-reference.md#microsoft-graph-mail-saving) for selectors, confirmation, limits and safe handling of untrusted mail content.
Ordinary tool-run downloads, sending, reply, forward and permanent deletion remain unavailable.
Raw `api get` mail routes and `--expand` remain refused; Graph mail error bodies are suppressed.
See [Graph credential setup](tool-credentials.md#microsoft-graph) for scoped mailbox authorization and credential-test limitations.
Administrators can opt in to the single read-only `security hunting query` command for Defender XDR advanced hunting with `enabledPacks: ["entra", "security"]` in the managed tool settings.
Hunting accepts exactly one UTF-8 plain-text upload named `query.kql`, at most 64 KiB, through `artium-axi mg-axi security hunting query --file query.kql`.
See [client input handling](client-reference.md#command-surface-and-subcommands) for local file paths and upload restrictions.
Queries must use the upstream restricted read-only KQL subset.
Hunting parses KQL before the read-only allowlist and upstream authentication; syntax errors return positioned diagnostics without query excerpts or quoted literals.
Parsing does not check tables, columns, types or permissions; recognized Graph 400 errors expose only the error class and line/column, while unknown error shapes remain opaque.
The existing mg-axi role grant is required; other security commands remain unavailable.
See [Graph credential setup](tool-credentials.md#microsoft-graph) for hunting permissions and consent; tenant acceptance remains unverified.

## Azure, Falcon and Vectra reads

Azure Resource Graph and Log Analytics queries parse KQL before upstream authentication or requests, returning positioned syntax diagnostics and query excerpts on failure.
Successful parsing does not validate tables, columns, functions, permissions or service-specific restrictions.

Falcon investigation reads include detection lineage, process details and trees, existing sandbox reports, FileVantage changes and device-control policy details.
NG-SIEM `search start` checks CQL structure before upstream authentication, reporting code, line, column and token class without echoing query text; function names, fields and semantics remain unchecked, and ambiguous syntax passes.
Rejected searches preserve redacted server diagnostics, completed searches include server warnings when present, and `search start --wait` advises when the normalized filter differs.

Vectra `host show` and `entity show --type host`, plus the matching raw host reads, retain every returned API field under `host`, separate from CLI metadata.
Use `--full` on host/entity detail commands for complete returned text; secret redaction still applies, and upstream omissions cannot be restored.
QUX collection reads support bounded `--all` traversal and opaque `--cursor` continuation with the original filters.
Vectra bounded windows with a remaining cursor report `complete: false` even on exit 0; failed reads exit 1.
For checkpoint feeds, completeness covers the current batch, not future events; see the [reviewed Vectra inventory](../tools/inventories/vectra-axi.json) for the completeness contract.
Detection and host IDs must be positive integers, including detection-list host and ID-range filters.
Detection `--fields` can include triage, assignment and filtering metadata; the [reviewed Vectra inventory](../tools/inventories/vectra-axi.json) owns the field names and pagination budgets.

Vectra supports selected QUX/RUX writes for detection close/open and mark-fixed, host/account close, key assets, tags, notes (including bulk notes), assignments and outcomes, triage labels and rules, groups and membership, proxies, threat feeds, internal-network settings, syslog/Kafka, notification destinations and Match, subject to deployment support in the [reviewed inventory](../tools/inventories/vectra-axi.json).
User, role, API-client and credential administration remains blocked.
Review the [Vectra grant warnings](admin-guide.md#browser-administration) before enabling operations.
See [client input handling](client-reference.md#command-surface-and-subcommands) for Vectra file inputs.

## Write gates by tool

| Tool | Write capability and unlock |
| --- | --- |
| Falcon | Separate, off-by-default capabilities for guarded RTR execution and bounded MalQuery exact/fuzzy literal search. RTR retains the standard read-only command allowlist and profile narrowing. Host changes, scripts, hunt and file transfers remain unavailable. See [Falcon execution setup](runbook.md#falcon-rtr-execution). |
| LDAP | Fixed read-only. |
| GitHub | Reviewed reads plus exact administrator-selected collaboration and repository writes, off by default, using classic or fine-grained PATs, admin-connected device-flow OAuth tokens or GitHub App installation tokens on GitHub.com, `*.ghe.com` or GHES. Artium previews each write without sending it; repeat the exact request with its returned `--confirm` value to execute. Installation tokens cannot access gists or user-only endpoints. Deletes, secret set, merge --admin, API non-GET, GraphQL escape paths, local git, setup/update, watch, downloads and local files stay blocked. Issue lock/unlock is unsupported by the pinned upstream combination; repo-edit visibility is unavailable. Only gist create/edit with `--filename` accepts stdin. Repository commands require `-R OWNER/NAME`; URL selectors and host-qualified repository names are refused. Repo creation requires a positional `OWNER/NAME`; project writes require `--owner OWNER` for recovery scope. Repo list/create, gist commands, search repos and api reject the `-R` selector. The bare dashboard and `home` remain refused because pinned gh-axi swallows dashboard read errors. SSH keys authenticate git transport, never the API used by gh-axi. See [GitHub setup](tool-credentials.md#github) for the operation tiers, device flow and token lifecycle. |
| Azure | Reviewed resource mutations; administrator `allowWrites: true` plus native command gates. |
| Graph | Native mutations only with administrator `writes.allowWrites: true` and an explicit operations allow-list, plus native gates. |
| Vectra | Administrator `writes.allowWrites: true` and an explicit operations allow-list, native preview, `--execute`, exact `--confirm` and redacted journaling. Artium enforces the native read-only override while write access is off. |
| Azure DevOps | Reviewed mutations with administrator `allowWrites: true`; raw `api` defaults to GET. POST/PATCH/PUT/DELETE additionally require a server-listed method/path and bounded JSON body; every raw mutation decision is journaled (TD-067). |
| AWX | Launch/cancel/relaunch, workflow approval/denial, project/inventory-source sync and notification tests require `allowWrites: true`. Independent `allowConfigurationWrites: true` permits reviewed ordinary create/edit and additive associations for inventories, hosts, groups, sources, templates, projects, schedules and workflows/nodes, plus template and workflow copies. Both controls default off; execution requires `--confirm` plus AWX permission for the operation and each referenced resource. Disabled configuration calls, including previews but excluding help, are refused before controller contact. Configuration flags for credentials, variables, extra vars, source vars and SCM URLs, all files/stdin, deletes, removals, bulk, organization administration, execution-environment and notification-template configuration, users, teams, roles and tokens stay blocked. The [generated inventory](../tools/inventories/awx-axi.json) owns the exact reviewed command and flag boundary. |
| Tenable One | Business writes and export-job creation with administrator `writes.allowWrites: true`, an explicit operations allow-list, native preview, `--execute`, exact `--confirm` and durable journaling; downloads and local configuration stay blocked. |
| Check Point Email Security | Email and exception writes require administrator `writes.allowWrites: true`, exact selected operations and native preview, execute, confirmation and journal gates. Name-only event actions require their exact `event.action.<name>` scope. The six malware/URL/DLP remove/clear operations and click-time clear remain refused. Three separately selected downloads use [authenticated CLI saving](client-reference.md#check-point-email-and-attachment-saving) with host-owned confirmation and independent SHA-256 verification; native download journal fields remain empty. Ordinary tool-run downloads and credential/origin overrides stay blocked. Live API contracts remain uncommissioned. |
| Hybrid Analysis | Sandbox submissions, YARA create/update/delete, consuming hunting matches and the four reviewed archive downloads require administrator `writes.allowWrites: true`, independently selected operations, native preview, `--execute`, exact `--confirm` and durable journaling. Downloads are limited to `hash-download-bin`, `report-download-bin`, `report-download-dropped-files` and `report-download-memory`, through the [authenticated CLI verified-save path](client-reference.md#hybrid-analysis-archive-saving) after the [operator prerequisites](runbook.md#scope-and-prerequisites) pass. All operations default off; enabling other writes never enables downloads or grants upstream entitlement. The browser provides warnings, command guidance and metadata/save status only. Ordinary tool-run downloads, local configuration and credential/origin overrides are blocked. |

Hybrid Analysis quick scans transmit the supplied sample or URL as read exceptions without a write gate; sandbox submission previews disclose that samples and reports can become visible to the community.
Consuming hunting matches is account-wide across all rules, with no rule selector, and irreversibly marks every returned match delivered; reconcile ambiguous outcomes using the audit ID, durable native journal and returned read-back guidance before retrying.
Updating a YARA rule with `reset_counter:true` resets its all-time match counter and changes its rule ID; use the returned ID for subsequent commands.
Labs hunting and search contracts are experimental.

There is no universal Artium confirmation flag.
Use authenticated tool help and the [write-access runbook](runbook.md#roles-credentials-and-health) for operation-specific gates.
After an unknown write outcome, inspect state using returned guidance before retrying.

## Initial read permissions

| Initial read | Required upstream permission |
| --- | --- |
| Falcon detections | `Alerts:read` |
| Vectra credential test | Health reads plus permissions for intended data |
| Azure subscription list | Application access to intended subscriptions; data-plane roles separately |
| Graph first-user read | Application `User.Read.All` with administrator consent |
| LDAP | Bind identity with directory read access |
| Azure DevOps project list | Identity permitted to view the organization/project |
| AWX job list | Token identity with job read access |
| Tenable One card list | See [Tenable One credential permissions](tool-credentials.md#tenable-one). |
| Hybrid Analysis quota | A valid API key; resource permissions vary by key level. See [Hybrid Analysis setup](tool-credentials.md#hybrid-analysis). |
| Check Point doctor | Regional authentication and one bounded email search. See [Check Point setup and commissioning](tool-credentials.md#check-point-email-security). |

See [tool credentials](tool-credentials.md) for dedicated identities, permissions and safe credential entry.
## Storage and execution boundaries

Artium stores shared service credentials encrypted with AES-256-GCM and never returns saved secrets to clients.
The data volume also holds the plaintext master key beside SQLite: protect the entire volume and keep offline escrow separate.
Linux client sessions use a mode-0700 directory and mode-0600 file under `${XDG_CONFIG_HOME:-~/.config}/artium-axi`.
Access tokens last one hour, with 12-hour local or 8-hour SSO CLI families; password changes revoke sessions.

Requests, bounded tool input and uploads travel to the server; enabled tools contact their upstream APIs using shared service identities.
Audit excludes injected credentials, request bodies, stdin, uploaded contents and output streams; see [upload audit metadata](admin-guide.md#audit-screen-and-api) for retained file metadata.
Failed-run diagnostics use separate administrator-only storage; see [diagnostic storage and retention](runbook.md#scripted-administrator-sessions) for limits, exclusions and backup handling.
The runner scans known secret encodings and discards output on a match; unknown upstream-minted tokens cannot be identified by exact-value scanning.
Its restricted environment, private directories and process limits are not a complete sandbox; descendants starting a new session can escape process-group termination.
