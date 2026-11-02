# Commands

This table follows the [CLI help registry](../src/cli/help.ts) and is kept identical to the table in [SKILL.md](../skill/artium-axi/SKILL.md).
Tool reference links describe upstream commands; Artium controls availability, credentials and permissions.
See [client input handling](client-reference.md#command-surface-and-subcommands) for local file uploads and stdin selection.

| Command | Purpose |
| --- | --- |
| `artium-axi` | Show identity, roles and available tools. |
| `artium-axi --help [<command>]` | Show local client or tool-entry help without authentication. |
| `artium-axi --version`, `-v`, `-V` | Print only the client package version without configuration or sign-in. |
| `artium-axi login --username <username> [--password-stdin]` | Sign in with a local account using protected password input. |
| `artium-axi login --sso` | Sign in through browser approval of the terminal code. |
| `artium-axi passwd [--password-stdin]` | Change the account password, then sign in again. |
| `artium-axi logout` | Remove local tokens and attempt server-session revocation. |
| `artium-axi whoami` | Show identity, roles, session expiry and server. |
| `artium-axi tools` | List granted enabled tools with status and pinned versions. |
| `artium-axi tools show <tool>` | Show one available tool, vetted upstream help and a first call. |
| `artium-axi doctor` | Check the server, certificate, token, client version and cached tool health, including the server's category for each failed tool. |
| `artium-axi update` | Download and verify the server client, replace this file and retain a .bak backup; npm installs use npm instead. |
| `artium-axi download --operation <operation> --selector <selector> --type <type> --destination <absolute-new-path> [--transfer <id> --execute --confirm <exact-confirm>] [--password-stdin\|--sso]` | Preview or explicitly verify and save administrator-enabled Hybrid Analysis archives, Check Point emails/attachments, Graph mail exports or BeyondTrust endpoint content; see `artium-axi download --help` for guards. |
| `artium-axi setup --host <claude\|codex\|opencode\|pi> [--hook] [--force]` | Install skills for the signed-in account's granted tools and optional ambient context for Claude Code, Codex or OpenCode on Linux. |
| `artium-axi session-context` | Emit current tool grants without session identity, or an explicit unavailable diagnostic; exits 0 so hosts can deliver failure context. |
| `artium-axi unifi-axi [<args>]` | Read implemented UniFi application, inventory and policy commands with managed credentials. |
| `artium-axi proxmox-axi [<args>]` | Read ordinary Proxmox routes with a managed API token; writes and byte transports are unavailable. |
| `artium-axi technitium-axi [<args>]` | Read Technitium DNS data with managed credentials and authenticated one-time result retrieval. |
| `artium-axi gitea-axi [<args>]` | Read Gitea repositories, issues, pull requests and classified API metadata with managed credentials. |
| `artium-axi kubernetes-axi [<args>]` | Read Kubernetes resources, logs and passive authorization reviews with managed credentials and pinned kubectl. |
| `artium-axi ssh-axi [<args>]` | Discover granted SSH hosts and check authentication through dedicated ordinary bindings without remote execution. |
| `artium-axi --managed-session <command> [<args>]` | Supply and persist caller-owned sessions through private pipes; see `artium-axi --managed-session --help`. |
| `artium-axi falcon-axi [<args>]` | Run Falcon commands with managed credentials; [tool reference](https://github.com/knowttl/falcon-axi#readme). |
| `artium-axi vectra-axi [<args>]` | Run Vectra commands with managed credentials; [tool reference](https://www.npmjs.com/package/@knowttl/vectra-axi). |
| `artium-axi az-axi [<args>]` | Run Azure commands with the managed identity; [tool reference](https://www.npmjs.com/package/@knowttl/az-axi). |
| `artium-axi mg-axi [<args>]` | Run Microsoft Graph commands with the managed identity; [tool reference](https://www.npmjs.com/package/@knowttl/mg-axi). |
| `artium-axi ldap-axi [<args>]` | Read directory data with the managed LDAP bind identity; [tool reference](https://www.npmjs.com/package/@knowttl/ldap-axi). |
| `artium-axi ado-axi [<args>]` | Run Azure DevOps commands with managed credentials; [tool reference](https://www.npmjs.com/package/@knowttl/ado-axi). |
| `artium-axi awx-axi [<args>]` | Inspect AWX automation with managed credentials; [tool reference](https://www.npmjs.com/package/awx-axi). |
| `artium-axi tenable-axi [<args>]` | Investigate Tenable One with managed API keys; [tool reference](https://www.npmjs.com/package/@knowttl/tenable-axi). |
| `artium-axi hybrid-axi [<args>]` | Investigate Hybrid Analysis with a managed API key; [tool reference](https://www.npmjs.com/package/@knowttl/hybrid-axi). |
| `artium-axi beyondtrust-axi [<args>]` | Inspect BeyondTrust PM Cloud Endpoint Privilege Management with managed credentials; [tool reference](https://www.npmjs.com/package/@knowttl/beyondtrust-axi). |
| `artium-axi checkpoint-axi [<args>]` | Investigate Check Point Email Security with managed regional credentials; [tool reference](https://www.npmjs.com/package/@knowttl/checkpoint-axi). |
| `artium-axi gh-axi [<args>]` | Read and update GitHub data with managed credentials; [tool reference](https://www.npmjs.com/package/gh-axi). |

For Azure DevOps, the [reviewed ADO inventory](../tools/inventories/ado-axi.json) owns accepted commands, aliases and flags; see the [capability boundary](safety.md#write-gates-by-tool) for permissions and unsupported transfers.
Use `artium-axi ado-axi query run <saved-query-id-or-path>` for saved queries, and `area list` or `iteration list` for classification paths.
`artium-axi ado-axi work-item list --fields id,title,Custom.EventSeverity` selects aliases and field reference names; its count reports items shown, not an exhaustive match total.
`artium-axi ado-axi work-item get 42 --full` includes non-System fields keyed by reference name under `fields`; extra text fields remain truncated at 1200 characters.
Read the current revision with `work-item get 42` before `work-item delete 42 --if-rev <rev>` or `work-item link remove 42 --index <index> --if-rev <rev>`; obtain relation indexes from `work-item link list 42`.
Deletion moves the item to the recycle bin unless `--destroy --confirm-destroy` is also supplied.
The deletion revision check is a preflight read, not an atomic compare-and-swap; another writer can change the item before DELETE.
Run commands with `--help` for pipeline, repository, policy and audit-read selectors and native confirmation flags.

`artium-axi ado-axi api <relative-path>` defaults to GET without a body.
For a listed write, use `artium-axi ado-axi api _apis/wit/workitems/42 -X PATCH --content-type json-patch --body '[{"op":"add","path":"/fields/System.Title","value":"Synthetic title"}]' --no-project`.
Select POST, PATCH, PUT or DELETE with `-X <method>`, `--method <method>` or a positional method before the path; if both forms are supplied, they must agree.
Writes require the [supported write permissions](safety.md#write-gates-by-tool) and [server method/path allow list](admin-guide.md#server-settings-and-custody).
The path is relative to the managed organization and selected project, or organization only with `--no-project`.
Writes refuse `--host` and `--query`; use `--api-version` for the REST version.
The required `--body` must be valid JSON within [the adapter's `ADO_API_BODY_MAX_BYTES` limit](../src/server/adapters/ado-api.ts), measured in UTF-8 bytes including whitespace.
`--content-type` accepts `json`, `json-patch` or `merge-patch`, or their media types `application/json`, `application/json-patch+json` or `application/merge-patch+json`.
GET refuses `--body` and `--content-type`, and continues to accept `--host` and `--query`.
See [audit decision records](admin-guide.md#audit-screen-and-api) for mutation journaling.

`artium-axi --help falcon-axi` is local help; `artium-axi falcon-axi --help` authenticates and calls upstream.
The [full client reference](client-reference.md#command-surface-and-subcommands) describes forwarding and supported input.
GitHub PR details support field selection, for example `artium-axi gh-axi pr view 42 -R OWNER/NAME --fields number,title,mergeStateStatus,body`.
The [reviewed GitHub inventory](../tools/inventories/gh-axi.json) owns the accepted command and flag boundary.

For AWX, the [generated parity matrix](awx-parity-matrix.md) compares pinned upstream commands and flags with the reviewed Artium boundary.
With the [tenant write switch](safety.md#write-gates-by-tool) enabled, use `--dry-run` to preview a configuration command, then `--confirm` to execute it.
Configuration commands without `--help`, `--dry-run` or `--confirm` are refused; operational commands without `--confirm` remain previews.
Previews are read-classified, and `--dry-run` takes precedence over `--confirm`.
Run a command with `--help` for its reviewed flags and required AWX resource permissions.
AWX `--help` returns native help before private input handling; unused structured values are ignored and local input files are not read.
See its [scope and managed equivalents](awx-parity.md) for client-local exceptions and planned delivery slices, and the [write boundary](safety.md#write-gates-by-tool) for current permissions.

Host and group mutations use canonical inventory commands: `host-create`, `host-edit`, `group-create`, `group-edit`, `group-add-host`, `group-remove-host`, `group-add-child` and `group-remove-child`.
Use these spellings in place of upstream nested aliases such as `inventory group add host`.
Create a host with `artium-axi awx-axi inventory host-create synthetic-host --inventory 7 --variables @host.yml --dry-run`, then replace `--dry-run` with `--confirm`.
For inline JSON/YAML and `--variables @local-file` handling, see [AWX structured inputs](client-reference.md#command-surface-and-subcommands).
Associate a host with `artium-axi awx-axi inventory group-add-host 42 --host 43 --confirm`, or a child group with `artium-axi awx-axi inventory group-add-child 42 --child 44 --confirm`; the matching `group-remove-host` and `group-remove-child` commands remove membership while preserving the resources.
Inspect the resulting state with `host show`, `group show`, `inventory hosts` or `inventory groups`; these reads remain available when writes are disabled.

Inventory creation and editing use `inventory create` and `inventory edit` with private `--variables` input.
For sources, use canonical `inventory source-create` and `inventory source-edit` with `--source-vars`, `--source-project` and `--credential` as needed.
Both accept `--update-on-launch`; editing also accepts `--no-update-on-launch`.
For example, preview `artium-axi awx-axi inventory source-create synthetic-source --inventory 7 --source scm --source-project 8 --credential 9 --source-vars @source.json --dry-run`, then replace `--dry-run` with `--confirm`.
Use `inventory source-credential-add` or `inventory source-credential-remove` with `--credential` for credential associations.
Use `inventory source-notification-add` or `inventory source-notification-remove` with `--notification-template` and `--event started|success|error` for notification associations.
Delete resources with `inventory delete <id|name>` or `inventory source-delete <id|name>`, using the same preview and confirmation flow.
Inspect state with `inventory show`, `inventory sources`, `inventory-source list`, `inventory-source show` and `inventory updates`; these reads remain available with writes disabled.
`inventory-source show` includes redacted configuration and update history.
`inventory sync <source-id|name>` targets a source, supports preview and confirmation, and accepts `--wait` to wait for completion.

Create a project with `artium-axi awx-axi project create synthetic-project --organization 7 --scm-type git --scm-url https://scm.example/repo --scm-branch main --credential 9 --dry-run`, then replace `--dry-run` with `--confirm`.
Use `project edit <id|name>` with the same SCM flags to update it; see [client input handling](client-reference.md#command-surface-and-subcommands) for URL file input and the [AWX safety boundary](safety.md#write-gates-by-tool) for URL restrictions and credential guidance.
`project sync <id|name> --confirm` starts an update; add `--wait` to wait for completion.
Inspect it with `project updates <id|name>` and `job stdout <update-id> --type project-update`, optionally using `--tail` or `--lines`.
Project notification associations use `project notification-add|notification-remove <id|name> --notification-template <id|name> --event started|success|error` with the preview and confirmation flow.
`project copy <id|name> --name synthetic-copy` and `project delete <id|name>` use that flow too.
Project list/show and updates remain available with writes disabled; after an unknown write outcome, follow [AWX recovery guidance](runbook.md#retention-and-export) and reconcile list/show before retrying, including the new name after a rename.

Credential creation accepts a private JSON object of credential inputs: `artium-axi awx-axi credential create synthetic-machine --credential-type Machine --organization 7 --inputs-file machine.json --dry-run`.
Replace `--dry-run` with `--confirm` to create it; AWX validates the credential type and permissions.
Use `credential edit <id|name> --inputs-file machine.json --dry-run` to preview an input update, or `--inputs-file -` on credential create/edit to read bounded stdin.
Keep SSH keys and passwords in the protected file or stdin, never command arguments.
`team credential-create <team-id|name> --name synthetic-machine --credential-type Machine --inputs-file machine.json --dry-run` previews team credential creation using an uploaded file; this upstream command does not accept stdin.
`credential copy <id|name> --name synthetic-copy --dry-run` previews a controller-side copy without downloading its secrets.
For each preview, replace `--dry-run` with `--confirm` to execute under the [tenant write switch](safety.md#write-gates-by-tool).
For unknown outcomes, follow [AWX recovery guidance](runbook.md#retention-and-export).
Credential list/show remain available with writes disabled and return metadata without credential inputs.

Create or edit templates and workflows with `template create|edit` or `workflow create|edit`, using `--extra-vars @variables.yml` for private JSON/YAML variables.
Preview each change with `--dry-run`, then replace it with `--confirm`.
Templates support `credential-add|remove`, `label-add|remove`, `instance-group-add|remove` and `notification-add|remove` associations.
Workflows support label and notification associations; notification events are `started`, `success`, `error` and, for workflows, `approval`.
For example, attach a machine credential with `artium-axi awx-axi template credential-add 42 --credential 7 --confirm`, then launch the configured connectivity playbook with `artium-axi awx-axi template launch 42 --confirm`.

Manage editable workflow graphs with `workflow node-create`, `node-edit`, `node-link`, `node-unlink` and `node-add-approval`.
Node create/edit accept private `--extra-vars` plus template, inventory, limit, branch, job type, tags and verbosity inputs.
For example, preview `artium-axi awx-axi workflow node-create 42 --template 7 --inventory 8 --extra-vars @node.json --dry-run`.
Link nodes with `workflow node-link 51 --to 52 --on success --confirm`; `node-unlink` removes that edge, and `--on` also accepts `failure` or `always`.
Use `node-credential-add|remove`, `node-label-add|remove` and `node-instance-group-add|remove` for node associations.
`workflow node-add-approval 52 --name synthetic-approval --timeout 300 --dry-run` previews an approval template on an existing node.
Inspect editable graph state with `workflow template-nodes <workflow-id|name>` and `workflow template-node <node-id>`, including after an unknown write outcome; these reads remain available with writes disabled.
`workflow nodes` inspects nodes of an executed workflow run.

Create a schedule with `artium-axi awx-axi schedule create synthetic-daily --template 7 --rrule 'DTSTART:20270101T000000Z RRULE:FREQ=DAILY' --extra-vars @schedule.yml --dry-run`, then replace `--dry-run` with `--confirm`.
Schedule create/edit accept private JSON/YAML extra variables, `--inventory`, `--limit`, `--job-tags` and `--skip-tags` when the template permits the corresponding launch prompts.
See [structured input handling](client-reference.md#command-surface-and-subcommands) for protected local files and response redaction.
Use `schedule edit <id|name> --enabled|--disabled` with the same preview and confirmation flow to change its enabled state; omitting `--rrule` preserves the recurrence rule.
Schedules support `credential-add|remove`, `label-add|remove` and `instance-group-add|remove`, using `--credential <id|name>`, `--label <id>` and `--instance-group <id>` respectively.
Inspect timing and enabled state with `schedule show <id|name>` and `schedule list`; these reads remain available with writes disabled.
The pinned upstream show/list output does not expose extra variables or association membership.
After an unknown write outcome, follow [AWX recovery guidance](runbook.md#retention-and-export) and reconcile the schedule through list/show before another mutation.

## Technitium DNS

Run `artium-axi tools show technitium-axi` for admitted commands and each command with `--help` for its required selectors.
Native boolean parameters take explicit `true` or `false` values; `--include-zones` also accepts the native empty selection.
Successful authenticated reads return their normal safe projection and an operation-bound `result` reference.
For JSON reads, result downloads contain only the package's redacted projection, encoded as JSON or TOON according to the invocation's `--json` flag; native text, CSV and ZIP downloads contain the exported bytes.
Retrieve `result.path` once with an authenticated GET to the Artium server using an Artium bearer token for the same user, with a current tool grant and the same credential revision.
This retrieval is separate from `artium-axi download`; the CLI does not automatically save the result.
Failed or incomplete reads remain failures; do not infer empty data.
For authentication or managed-configuration failures, ask an administrator to update the stored credential and connection settings.
See the [capability boundary](safety.md#technitium-dns) and [retention, limits and retrieval failures](runbook.md#retention-and-export).

## Check Point Email Security

The [reviewed Check Point inventory](../tools/inventories/checkpoint-axi.json) owns accepted flags, their defaults and bounds.
Run each command with `--help` for selectors and limits.
`artium-axi checkpoint-axi email search --expand` and `artium-axi checkpoint-axi event list --expand` opt in to read-only show details on returned rows.
`--expand-limit` caps detail attempts; `--expand-requests` caps total HTTP requests including authentication, list pages, details and retries.
Both limits require `--expand`.
Expansion shares the native transport budgets with listing; inspect `expansion.complete` and `expansion.notExpanded` for partial results.
Partial expansion preserves list rows and successful details; list completion and cursors describe pagination separately.

Use `artium-axi checkpoint-axi task show <id> --wait --timeout 30` for read-only polling of an existing task.
`--timeout` is required with `--wait`; `--poll-interval` sets seconds between status reads, and `--wait-requests` caps total HTTP requests including authentication and retries.
All wait limit flags require `--wait`.
Inspect `wait.terminal` and `wait.reason` even on exit 0; a timeout or budget stop can return the last non-terminal snapshot, and a terminal task may have failed or stopped.
Use `--timeout 50` or less to leave startup and output time within Artium's [runner limit](../src/server/config.ts).
A wait using the native maximum timeout may be cut off with `TIMEOUT` before its final snapshot returns; read `task show` again rather than resubmitting an action.
The [client request deadline](../src/cli/http.ts) does not extend the runner limit.
