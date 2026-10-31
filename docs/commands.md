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
With the applicable administrator control enabled, use `--dry-run` to preview a configuration command, then `--confirm` to execute it.
Configuration commands without either flag are refused; operational commands without `--confirm` remain previews.
Previews are read-classified, and `--dry-run` takes precedence over `--confirm`.
Run a command with `--help` for its reviewed flags and required AWX resource permissions.
See its [scope and managed equivalents](awx-parity.md) for client-local exceptions and planned delivery slices, and the [write boundary](safety.md#write-gates-by-tool) for current permissions.

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
