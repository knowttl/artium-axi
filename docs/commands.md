# Commands

This table follows the [CLI help registry](../src/cli/help.ts).
Tool reference links describe upstream commands; Artium controls availability, credentials and permissions.
See [client input handling](client-reference.md#command-surface-and-subcommands) for local file uploads and stdin selection.

| Command | Purpose |
| --- | --- |
| `artium-axi` | Show identity and available tools, with roles for full sessions or a delegation label for delegated sessions. |
| `artium-axi --help [<command>]` | Show client or tool-entry help; delegated home, tool and download discovery require authentication. |
| `artium-axi --version`, `-v`, `-V` | Print only the client package version without configuration or sign-in. |
| `artium-axi login --username <username> [--password-stdin]` | Sign in with a local account using protected password input. |
| `artium-axi login --sso` | Sign in through browser approval of the terminal code. |
| `artium-axi login --token-stdin` | Exchange a delegated token using protected stdin. |
| `artium-axi token create\|list\|revoke` | Manage delegated tokens. See [delegated tokens](client-reference.md#delegated-tokens) and [capability boundaries](safety.md#delegated-sessions). |
| `artium-axi passwd [--password-stdin]` | Change the account password, then sign in again. |
| `artium-axi logout` | Remove local tokens and attempt server-session revocation. |
| `artium-axi whoami` | Show identity, session expiry and server, with roles for full sessions or a delegation label for delegated sessions. |
| `artium-axi tools` | List granted enabled tools with status and pinned versions. |
| `artium-axi tools show <tool>` | Show one available tool, vetted upstream help and a first call; delegated sessions receive its permitted command list. |
| `artium-axi doctor` | Check the server, certificate, token, client version and cached tool health, including the server's category for each failed tool. |
| `artium-axi update` | Download and verify the server client, replace this file and retain a .bak backup; npm installs use npm instead. |
| `artium-axi download --operation <operation> --selector <selector> --type <type> --destination <absolute-new-path> [--transfer <id> --execute --confirm <exact-confirm>] [--password-stdin\|--sso]` | Preview or explicitly verify and save administrator-enabled artifacts; see the [supported capability boundaries](safety.md) and `artium-axi download --help` for operations and guards. |
| `artium-axi setup --host <claude\|codex\|opencode\|pi> [--hook] [--force]` | Install skills for the signed-in account's granted tools and optional ambient context for Claude Code, Codex or OpenCode on Linux. |
| `artium-axi session-context` | Emit current tool grants without session identity, or an explicit unavailable diagnostic; exits 0 so hosts can deliver failure context. |
| `artium-axi unifi-axi [<args>]` | Read UniFi data and preview administrator-selected native writes; execute with exact confirmation and a stable request ID. |
| `artium-axi proxmox-axi [<args>]` | Use managed authentication for reads and JSON writes, with independent grants, native confirmation, private results and durable recovery. |
| `artium-axi proxmox-axi result take <operation> <id>` | Retrieve a one-time private result through `PROXMOX_AXI_RESULT_FD`; follow the [private delivery contract](client-reference.md#proxmox-private-results). |
| `artium-axi proxmox-axi stream limits` | Inspect authenticated host byte, staging, deadline and concurrency limits. |
| `artium-axi proxmox-axi stream -- transfer\|duplex <native arguments>` | Use [private managed byte channels](client-reference.md#proxmox-managed-streams) for reviewed transfers and console/migration operations. |
| `artium-axi technitium-axi [<args>]` | Read Technitium DNS data and use native confirmed writes with managed credentials and private result retrieval. |
| `artium-axi shodan-axi [<args>]` | Read Shodan account and investigation data or run a bounded stream session with managed credentials; see [usage](#shodan). |
| `artium-axi gitea-axi [<args>]` | Read Gitea metadata and perform administrator-enabled native writes with preview, confirmation and reconciliation. |
| `artium-axi kubernetes-axi [<args>]` | Read Kubernetes resources or use administrator-enabled [mutation and bounded byte workflows](safety.md#kubernetes-reads), caller-owned workspaces and managed credentials with pinned kubectl. |
| `artium-axi ssh-axi [<args>]` | Discover granted SSH hosts, check authentication and run [confirmed managed commands](#ssh). |
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

Kubernetes workspace and byte-session commands have local help through `artium-axi kubernetes-axi workspace --help` and `session --help`.
Use `workspace create <directory>` to upload a regular file tree with immutable byte counts and digests.
Use `session start exec -- exec <pod> -- <command>` for bounded execution, or add `--workspace <id>` and use `workspace:<path>` in a native file argument.
Mutation starts return a native preview; inspect it and run `session confirm <id> --digest <exact-digest>` without adding a second generic confirmation.
Read sessions start immediately: use `session start logs -- logs <pod> --follow` or `session start watch -- get pods --watch-only` without confirmation.
`session show <id> --wait` reports the final remote exit code, while `session output <id> --after <sequence> --wait` retrieves bounded stdout/stderr chunks with sequence and byte offsets.
Use `--stdin-file <file>` for at most 512 KiB of inline input, or `--input-workspace <id> --input-path <path>` for a staged input artifact up to 100 MiB.
For copy, use `session start cp --workspace <id> -- cp workspace:<path> <pod>:/absolute/path` or `session start cp -- cp <pod>:/absolute/path artifact:<path>`, then confirm the returned digest.
Copy requires `tar` in the container.
For forwarding use `session start port-forward -- port-forward <pod> 0:<remote-port>`, inspect the preview and confirm its exact digest.
Use `session show <id> --ready` to await native readiness, then `tunnel <id> --port <remote-port>` to bind a local 127.0.0.1 listener.
The tunnel prints each remote port and its assigned local port; connect to that local port.
Repeat `--port` for up to eight distinct approved remote ports; Ctrl+C closes local listeners without replaying the remote operation.
Cancel the session explicitly when finished.
With administrator Allow writes and `acquireCredential: true`, use `prepare -- create token <service-account> --duration 600s`, preview and exact-digest confirmation to obtain a protected result reference.
Use `credential <result-id> --credential-fd <fd>` with an already open private writable pipe or socket numbered 5 or higher.
Only that pipe receives token bytes; public output reports metadata.
References bind the issuing sign-in family and can be consumed once; see the [retention runbook](runbook.md#retention-and-export) for expiry and uncertain issuance or delivery recovery.
`session artifact <id> <path> --output <absolute-file>` and `workspace download <id> <path> --output <absolute-file>` save exact bytes with verified hashes into a new file in a private directory.
See the [Kubernetes capability boundary](safety.md#kubernetes-reads) for workspace access and session grants, and the [delegated scope rules](safety.md#delegated-sessions) when selecting these commands for a temporary token.
Use `session list` to recover a lost start reply, `session cancel <id> --confirm` to stop work and discard results, and `workspace delete <id>` to remove staged files.
No command automatically reconnects, replays an uncertain operation or resumes after a server restart.

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

The [full client reference](client-reference.md#command-surface-and-subcommands) describes help, delegated discovery, forwarding and supported input.
GitHub PR details support field selection, for example `artium-axi gh-axi pr view 42 -R OWNER/NAME --fields number,title,mergeStateStatus,body`.
The [reviewed GitHub inventory](../tools/inventories/gh-axi.json) owns the accepted command and flag boundary.

For AWX, the [generated parity matrix](awx-parity-matrix.md) compares pinned upstream commands and flags with the reviewed Artium boundary.
With the [tenant write switch](safety.md#write-gates-by-tool) enabled, use `--dry-run` to preview a configuration command, then `--confirm` to execute it.
Configuration commands without `--help`, `--dry-run` or `--confirm` are refused; operational commands without `--confirm` remain previews.
Previews are read-classified, and `--dry-run` takes precedence over `--confirm`.
Delegated read-only sessions refuse previews of commands classified as writes, including AWX configuration previews.
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
`job stdout <id> --download <name>` delivers the whole redacted log as a protected `result.path` in the decoded tool stdout; retrieve it with an authenticated GET under the [AWX result security boundary](safety.md#write-gates-by-tool).
The name only labels the result: use 1-64 ASCII letters, digits, dots, underscores or hyphens, starting with a letter or digit.
Downloads cannot combine with `--tail`, `--lines`, `--full` or `--ansi`; see [result limits and recovery](runbook.md#retention-and-export) for oversized or unavailable logs.
The pinned `awx-axi` accepts `--fields` on 17 list commands, `--full` and `--ansi` on `job stdout`, and `--type` on `job events` but applies its fixed output, so Artium admits them as no-ops for parity.
Waits (`job watch`, and `--wait` on launch and sync commands) last at most 50 seconds within the runner lifetime; omit `--timeout` for that default, larger values are refused, and `job watch <id>` resumes a wait that ended early.
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

Create an execution environment with `artium-axi awx-axi execution-environment create synthetic-runner --image registry.example/automation/runner:stable --dry-run`, then replace `--dry-run` with `--confirm`.
Create/edit accept `--name`, `--image`, `--description`, `--organization <id|name>`, `--pull <policy>` and `--credential <id|name>` for an existing AWX registry credential.
Registry passwords and tokens belong in AWX credentials, never in image references or command arguments.
Both ordinary image configuration and credential attachment follow the [AWX write boundary](safety.md#write-gates-by-tool).
Inspect images and associated templates with `execution-environment list` and `execution-environment show <id|name>`; reads remain available with writes disabled.
The pinned upstream read output does not expose the attached registry credential or pull policy.
After an unknown create or rename outcome, follow [AWX recovery guidance](runbook.md#retention-and-export).

Create or edit organizations with `organization create|edit`, using `--name`, `--description`, `--max-hosts` and `--default-environment <id|name>`.
Organization associations use `user-add|remove`, `admin-add|remove`, `team-add|remove`, `galaxy-credential-add|remove`, `instance-group-add|remove`, `execution-environment-add|remove` and `notification-template-add|remove` with the matching resource flag.
Admin associations use `--user`; Galaxy credential associations use `--credential`.
Use `organization notification-add|remove` with `--notification-template` and `--event started|success|error` for event-specific notifications.
For example, preview `artium-axi awx-axi organization admin-add 42 --user 7 --dry-run`, then replace `--dry-run` with `--confirm`.

Create a notification template with `artium-axi awx-axi notification-template create synthetic-webhook --organization 7 --notification-type webhook --configuration-file configuration.json --messages-file messages.json --dry-run`, then replace `--dry-run` with `--confirm`.
Update it with `notification-template edit <id|name>` and the same configuration flags; `--config-file` is a synonym for `--configuration-file`.
Configuration and messages files must contain JSON objects and are uploaded privately; keep tokens, passwords and message secrets in protected local files, never command arguments.
Both preview and execution require the tenant writes switch; execution also requires AWX permission, confirmation and audit.
Use `notification-template test <id|name> --dry-run`, then `--confirm`, to send a test notification under the same switch.
Inspect templates and deliveries with `notification-template list|show` and `notification list|show`; reads remain available with writes disabled, and list commands retain `--limit`, `--all` and `--max-rows` pagination.
After an unknown create or rename outcome, follow [AWX recovery guidance](runbook.md#retention-and-export).

Create or edit teams with `team create|edit --name synthetic-team --organization <id|name> --description <text>`, supplying the existing team ID or name after `edit`.
Use `team user-add|remove <team-id|name> --user <id|name>` for membership.
Create users with `user create synthetic-person`, or edit them with `user edit <id|username>`.
Both accept `--username`, `--first-name`, `--last-name`, `--email`, `--is-superuser` and `--is-system-auditor`; editing also accepts `--no-superuser` and `--no-system-auditor` to remove those privileges.
Passwords use a protected local `--password-file password.txt` or bounded stdin with `--password-file -`, never command arguments.
Grant or revoke a role with `role grant|revoke <role-id|name> --user <id|username>` or `--team <id|name>`.
All these writes require the tenant writes switch and the same `--dry-run` / `--confirm` flow, including membership removals and privilege changes.
Inspect current state with organization, user and team list/show commands, `team users`, `role users` and `role teams`; these reads remain available with writes disabled.
The pinned upstream organization read output does not enumerate association membership.
After an interrupted user rename, follow [AWX recovery guidance](runbook.md#retention-and-export).

Revoke an upstream PAT with `artium-axi awx-axi user token-revoke <numeric-token-id> --dry-run`, then replace `--dry-run` with `--confirm`.
This explicit revoke flow is the managed logout equivalent; raw `auth logout` directs callers to it.
See the [AWX security boundary](safety.md#write-gates-by-tool) for authorization and managed-account behavior, and [recovery guidance](runbook.md#retention-and-export) for token lookup limitations.

Create a PAT with `artium-axi awx-axi user token-create <user-id|username> --scope read|write --dry-run`, then replace `--dry-run` with `--confirm`.
Confirmed creation returns token metadata and a protected `result.path` in the decoded tool stdout.
Save the result bytes through an authenticated GET to that path using the requesting caller's Artium bearer session, keeping authentication headers in protected input rather than process arguments.
Follow the [AWX security boundary](safety.md#write-gates-by-tool) for retrieval scope, expiry and one-time consumption, and [AWX recovery guidance](runbook.md#retention-and-export) if delivery fails.

Create hosts in bulk with `artium-axi awx-axi inventory host-bulk-create --inventory <id|name> --hosts-file hosts.json --dry-run`, where the file is a JSON array of host objects, then replace `--dry-run` with `--confirm`.
Each host requires a `name`; optional `variables` must be JSON/YAML text, not an object or array, for example `[{"name":"synthetic-host","variables":"{\"ansible_host\":\"192.0.2.10\"}"}]`.
Delete hosts in bulk with `artium-axi awx-axi inventory host-bulk-delete --hosts-file ids.json --dry-run`, where the file is a JSON array of numeric host IDs, then replace `--dry-run` with `--confirm`.
Both use the single tenant writes switch, and previews hide the file contents.
See [bulk outcome recovery](runbook.md#retention-and-export) for partial or interrupted operations and readback before retrying.

## Technitium DNS

Run `artium-axi tools show technitium-axi` for admitted commands and each command with `--help` for its required selectors.
For native write inputs, pass `--input-file <absolute-private-file>` containing the package's typed JSON envelope (`parameters`, optional `baseline`, `upload` and `encoding`).
The client uploads the file privately; native `upload.file` and app `parameters.config.file` paths refer to local private files whose bytes are uploaded with the envelope, never server paths.
Files must be owned regular files with mode 0600, without symlinks; limits are 1 MiB per file, 4 MiB total and eight files per request.
Operation secrets use explicit `TECHNITIUM_INPUT_*` environment SecretRefs or private local file SecretRefs; the client resolves them into the private envelope's `secrets` map, limited to 64 KiB total.
Direct API callers supply that map and uploaded logical asset names explicitly; the server never resolves caller-selected environment names or file paths.
With both exact grants enabled, preview `artium-axi technitium-axi allowed add --input-file <absolute-private-file> --json`, then repeat the same input with `--execute --confirm <preview.digest>`.
Keep the original input and confirmation for `--reconcile <audit-id> --confirm <original-digest>` where native reconciliation is supported; see [recovery and journal custody](runbook.md#retention-and-export).
`dns-client resolve` uses the same typed input and native preview/confirmation flow; only `parameters.import: true` requires the `OP-077.import` write grant.
Successful write executions return native response bytes through the same private result retrieval used by reads; preview receipts remain public protocol metadata.
Native boolean parameters take explicit `true` or `false` values; `--include-zones` also accepts the native empty selection.
Successful authenticated reads return their normal safe projection and an operation-bound `result` reference.
For JSON reads, result downloads contain only the package's redacted projection, encoded as JSON or TOON according to the invocation's `--json` flag; native text, CSV and ZIP downloads contain the exported bytes.
Retrieve `result.path` once with an authenticated GET to the Artium server using an Artium bearer token for the same user, with a current tool grant and the same credential revision.
This retrieval is separate from `artium-axi download`; the CLI does not automatically save the result.
Failed or incomplete reads remain failures; do not infer empty data.
If a write outcome is unknown, follow the [recovery guidance](runbook.md#retention-and-export).
For authentication or managed-configuration failures, ask an administrator to update the stored credential and connection settings.
See the [capability boundary](safety.md#technitium-dns) and [retention, limits and retrieval failures](runbook.md#retention-and-export).

## Shodan

Run `artium-axi shodan-axi info` for API plan and credit information or `artium-axi shodan-axi account profile` for the account profile.
The bare `artium-axi shodan-axi` also performs the account-information read.
These reads accept `--json` and `--help`; `--help` shows bounded hosted discovery without an account read.
For host investigation, counts, search and domain lookups:

```sh
artium-axi shodan-axi host 192.0.2.1 --json
artium-axi shodan-axi count 'port:443' --json
artium-axi shodan-axi search 'port:443' --allow-operation OP-003 --query-credit-budget 1 --json
artium-axi shodan-axi domain example.test --allow-operation OP-040 --query-credit-budget 1 --json
```

Use `artium-axi shodan-axi host --help` or `search --help` for command-specific flags.
See the [supported boundary](safety.md#shodan) for available read families and credit requirements.
Use `artium-axi shodan-axi version` to print the packaged version or `version --help` for help; `version` does not accept `--json`.
For stream session access and quotas, ask an administrator to configure the [Shodan session policy](tool-credentials.md#shodan).
For example, `artium-axi shodan-axi stream session preview --operation OP-047 --selector --asn --value AS64496 --limit 10 --max-bytes 4096 --timeout 10000 --idle-timeout 5000 --accept-unknown-cost --json` validates a native plan without starting a stream.
Use `artium-axi shodan-axi stream session preview --help` for the full set of bounds.
The required `--accept-unknown-cost` acknowledges that cost cannot be determined; the response reports the selected operation, selector, bounds and effective limits with `status: preview` and `cost: unknown`.
Optional `--events`, `--bytes`, `--retention` and `--lease` values may lower administrator ceilings; retention and lease values are in seconds, while timeout values are in milliseconds.
The required `--limit`, `--max-bytes` and `--timeout` must fit the effective event, byte and lease limits.
To start, repeat the preview arguments with `start` and `--confirm` set to the returned confirmation.
The confirmation is single-use, expires after fifteen minutes and is replaced by a new preview from the same sign-in family; obtain a fresh preview after a failed start.
Use `artium-axi shodan-axi stream session status <id>`, `artium-axi shodan-axi stream session read <id>` and `artium-axi shodan-axi stream session stop <id>` to inspect, consume and stop the returned session ID.
Use `artium-axi shodan-axi radar --session <id>` to display retained locations interactively.
Start radar before any session reads: it consumes output using the same single-use continuation and cannot resume an existing reader's cursor.
Radar stops at `--max-events <count>` (1 to 10000, default 10000) or when the session is cleaned and no retained pages remain.
Press `q` or Ctrl+C to cancel interactively; SIGINT and SIGTERM also cancel, including in non-interactive mode.
On exit, radar attempts to stop the hosted session, including after reaching its event cap or encountering an error.
For non-interactive use, both `--max-events <count>` and `--output <absolute-new-path>` are required; interactive use also accepts `--output`.
Saving requires Linux and a new normalized absolute path in an existing directory owned by the current user with mode 0700 and no symlink components; the output file has mode 0600 and is never overwritten.
The saved JSON contains a 36-by-18 location grid, plotted and ignored point counts, consumed event count, loss reports and the last observed session state; it does not archive individual events.
Events without valid latitude and longitude count toward the event cap but are ignored in the grid.
With `--output`, radar attempts to save the accumulated summary on completion, cancellation and read failures before reporting errors; a failed session exits unsuccessfully.
If saving fails, choose a valid new destination for a new session; consumed output cannot be replayed.
Use `artium-axi shodan-axi radar --help` or `-h` for local help without contacting the server.
To extend a running lease, use `artium-axi shodan-axi stream session extend <id> --seconds <seconds>`.
The seconds are added to the current session deadline, rather than measured from the extension request.
Apply the preview with `artium-axi shodan-axi stream session extend <id> --confirm <token>`.
The resulting deadline must remain within the session's reserved lease limit from the preview time; event, byte and retention limits remain unchanged.
An extension confirmation is single-use, expires after fifteen minutes and is replaced by a new extension preview for that session.
Confirm before the current session deadline expires; an extension cannot restart an ended session.
If extension confirmation returns `INVALID_INPUT`, inspect the session status and obtain a fresh extension preview if it is still running.
The first read omits `--continuation`; each later read must pass the most recently returned token as `--continuation <token>`.
After a session is cleaned, continue reading while `hasMore` is true to consume all retained pages.
Reads consume output and rotate the continuation even when no items are returned, so save each response before reading again; consumed output cannot be replayed.
Read accepts `--limit` to bound returned items and `--wait` to wait for new output or session cleanup.
Responses report lost records and cumulative upstream loss; `complete: false` and `upstreamCompleteness: unverified` never establish complete upstream delivery, even after a clean stop.
All session actions accept `--json`; the default output is TOON.
The session's initial `expiresAt` deadline starts at admission and is bounded by `--timeout` and the effective lease.
See [session retention and recovery](runbook.md#retention-and-export) for output expiry, cleanup and capacity recovery.
Exceeding a ceiling returns `INVALID_INPUT`; exhausted preview or session capacity returns `TOO_MANY_CALLS`.
For a missing or expired start confirmation (`NOT_FOUND`), obtain a fresh preview; for changed start arguments (`INVALID_INPUT`), repeat the exact preview arguments with the new confirmation.
For authentication failures, ask an administrator to replace the managed key using [Shodan credential setup](tool-credentials.md#shodan).
See [package recovery](runbook.md#roles-credentials-and-health) for inventory or package mismatches.

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

## SSH

Discover available hosts with `artium-axi ssh-axi host list`, inspect one with `host show <host>` and check authentication without running a remote command with `doctor <host>`.
After [administrator setup](tool-credentials.md#ssh), run a confirmed command:

```sh
artium-axi ssh-axi exec synthetic-host --command 'uname -s' --confirm
```

Every arbitrary command requires `--confirm`, including commands intended only to read remote state.
`--sudo` uses the separately approved sudo binding under the [SSH capability boundary](safety.md#ssh-reads).
`--timeout 30s` selects a deadline from 1s to 600s, default 60s, within the host ceiling.
`--output-limit <bytes>` accepts 0-1048576, default 65536, within the host ceiling; managed output samples have a separate [retention cap](runbook.md#ssh-execution-recovery-and-retention).
By default the CLI waits for a terminal result; `--detach` returns the current execution status after submission.
Ctrl-C requests cancellation of the accepted execution; local teardown does not prove remote descendants stopped.
Use `artium-axi ssh-axi execution show` to inspect the latest local receipt, `execution show <id>` for a known execution or `execution show --request-key <key>` for a saved request key.
See [SSH recovery and retention](runbook.md#ssh-execution-recovery-and-retention) before acting on an interrupted or uncertain result.
Use `--json` for JSON status and `--help` on each command for accepted flags.
Use `execution list` for retained jobs and `execution cancel <id> --confirm` to request cancellation.
Use `connection open <host> [--idle-timeout 10m] [--sudo]`, `connection list`, `connection show <id>` and `connection set <id> --idle-timeout 5m` for reusable transports.
Select a transport with `exec <host> --connection <id> --command <text> --confirm`; it must match the host and ordinary/sudo binding.
`connection close <id>` closes an idle transport; active work additionally requires `--confirm`.
Connections never reconnect automatically, and commands without `--connection` retain one-shot execution.
See the [connection capability boundary](safety.md#ssh-reads) for idle-timeout bounds, expiry and capacity limits.
