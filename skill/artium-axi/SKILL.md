---
name: artium-axi
description: Discover and run managed commands through Artium, using the signed-in account and its granted tools.
---

Use artium-axi tools first for requests involving data from Artium-managed tools.
Run `artium-axi tools` to discover the tools available to this account before choosing a tool.
Run `artium-axi tools show <tool>` for its commands and a vetted example, then run `artium-axi <tool> <args>`.
Follow the returned next commands; they already include the Artium prefix.
Keep upstream arguments intact and use the managed credentials rather than configuring an upstream CLI directly.
See [client input handling](https://github.com/knowttl/artium-axi/blob/main/docs/client-reference.md#command-surface-and-subcommands) for Azure stdin selection and Tenable local uploads or explicit stdin.

If artium-axi is absent from PATH, use the installed command below in place of `artium-axi` in every example:
On Windows, choose the labelled PowerShell or Git Bash command for your shell.

<!-- artium-axi executable -->
The setup command records the standalone bundle's Node invocation here.
<!-- /artium-axi executable -->

If sign-in is required, ask the user to sign in with their SSO or local account.
Never request or print tokens or put passwords in arguments.
An empty tool list means no enabled runtime tool is available through the account's roles; ask an administrator to check grants and enabled tools.
Use `artium-axi doctor` for connection or cached health diagnostics.
Do not retry an uncertain command outcome, especially a write.

## Investigation quick guide

Start with these reads using an already signed-in account, without running help first.
Artium is a managed transport; vendor investigation syntax and one-call pivots belong to the tool skills installed by setup.
Use the matching installed skill once you know the granted tool.

| Read command and example | What it answers |
| --- | --- |
| `artium-axi` | Identity, roles and available tools together in one call. |
| `artium-axi tools` | Granted enabled tools, status, pinned version and `readOnly`; no flags required. |
| `artium-axi tools show falcon-axi` | One tool's reviewed command inventory, vetted upstream help and first read example; substitute a granted tool name. |
| `artium-axi whoami` | Identity, roles, session expiry and server; no flags required. |
| `artium-axi doctor` | Connection, certificate, token, version and cached tool health; does not run a fresh upstream credential test. |
| `artium-axi falcon-axi detection list` | First endpoint detection read when Falcon is granted; keep all upstream arguments after the tool name. |

The home view combines identity and tool discovery, so skip separate whoami and tools calls when it already answers the question.
Tools show combines command inventory, vetted help and a first call, avoiding help probes for every listed command.
Artium has no generic batch, start-and-wait, list-with-details or lookup-and-pivot flag.
Use only single-call forms documented by the granted tool's installed skill and supported by its pinned command inventory; upstream support does not imply managed availability.

### Keep output small

Client discovery has no `--fields`, `--limit` or `--full` flags.
Tools already returns only `name`, `status`, `version` and `readOnly`; use tools show for one tool's details only when needed.
Forward tool-specific filters, `--fields` and `--limit` only where its skill documents them.
Prefer identifiers, status, timestamps and summary fields; fetch long descriptions only for relevant records.
Upstream `--full`, where supported, restores text but never bypasses redaction, execution budgets or output caps.
The default managed stream cap is 4 MiB per stream; heed stderr truncation notices and narrow the query rather than treating partial output as complete.

### Help is recovery

Use help for a command that fails or whose arguments are unclear, not to start an investigation.
`artium-axi --help` returns the local client command list, usage, flags and an example without signing in.
Client command help, such as `artium-axi tools --help`, `artium-axi tools show --help`, `artium-axi whoami --help` and `artium-axi doctor --help`, describes only that client command.
`artium-axi --help falcon-axi` is local entry help describing forwarding and managed boundaries.
`artium-axi falcon-axi --help` and `artium-axi falcon-axi detection list --help` authenticate and forward help to the pinned tool at the requested level.
The same before/after-tool distinction applies to other granted tools.

### Read allowlist and state changes

The six reads above are candidates for a reviewed allowlist, scoped to their exact argument forms.
Authenticated reads can refresh local session tokens and create server audit records.
Never allow an unrestricted tool prefix merely because its discovery row says `readOnly`.
Login, passwd and logout change session/account state; setup writes skills/hooks; update replaces the executable; download prepares transfers or saves artifacts.
Forwarded writes and job creation need separate review and administrator enablement where supported.
Hybrid Analysis quick scans can transmit samples or URLs even with managed writes disabled.
Native preview, execute and exact confirmation gates still apply; there is no universal Artium confirmation flag.

### Failures and next action

Artium errors are TOON on stdout with `error.code`, `source`, `message` and `next`; follow `next` rather than retrying blindly.
Exit 0 means success, 2 means usage/configuration error and 1 means authentication/server/transport failure; upstream exit status passes through.

| Code | Action |
| --- | --- |
| `INVALID_INPUT`, `FLAG_BLOCKED` | Correct syntax or remove destination, tenant, credential and local configuration overrides; use the failing command's help if needed. |
| `CLIENT_CONFIG_INVALID`, `CERTIFICATE_INVALID` | Correct the HTTPS server/CA settings; never disable certificate verification. |
| `TOKEN_INVALID`, `TOKEN_EXPIRED`, `PASSWORD_CHANGE_REQUIRED` | Have the account owner sign in again or change the temporary password first. |
| `TOOL_DISABLED`, `TOOL_NOT_GRANTED`, `CREDENTIAL_NOT_CONFIGURED`, `UPSTREAM_AUTH_FAILED` | Ask the administrator to check enablement, grants or managed credentials; changing upstream login locally cannot repair them. |
| `CLI_OUTDATED` | Follow the returned installation-specific update instructions. |
| `TOO_MANY_CALLS`, `SESSION_BUSY` | Wait for the active call/session holder to finish; avoid parallel retries. |
| `TIMEOUT`, `UNKNOWN_OUTCOME`, `SERVER_UNAVAILABLE` | Inspect current state before trying again, especially after a write. |
| `OUTPUT_LIMIT` | Narrow filters or reduce the upstream result limit. |

## Commands

This table is kept identical to the [command reference](https://github.com/knowttl/artium-axi/blob/main/docs/commands.md).
Tool reference links describe upstream commands; Artium controls availability, credentials and permissions.

| Command | Purpose |
| --- | --- |
| `artium-axi` | Show identity, roles and available tools. |
| `artium-axi --help [<command>]` | Show local client or tool-entry help without authentication. |
| `artium-axi --version` | Print the client package version. |
| `artium-axi login --username <username> [--password-stdin]` | Sign in with a local account using protected password input. |
| `artium-axi login --sso` | Sign in through browser approval of the terminal code. |
| `artium-axi passwd [--password-stdin]` | Change the account password, then sign in again. |
| `artium-axi logout` | Remove local tokens and attempt server-session revocation. |
| `artium-axi whoami` | Show identity, roles, session expiry and server. |
| `artium-axi tools` | List granted enabled tools with status and pinned versions. |
| `artium-axi tools show <tool>` | Show one available tool, vetted upstream help and a first call. |
| `artium-axi doctor` | Check the server, certificate, token, client version and cached tool health. |
| `artium-axi update` | Download and verify the server client, replace this file and retain a .bak backup; npm installs use npm instead. |
| `artium-axi download --operation <operation> --selector <selector> --type <type> --destination <absolute-new-path> [--transfer <id> --execute --confirm <exact-confirm>] [--password-stdin\|--sso]` | Preview or explicitly verify and save administrator-enabled Hybrid Analysis archives, Check Point emails/attachments or Graph mail exports; see `artium-axi download --help` for guards. |
| `artium-axi setup --host <claude\|codex\|opencode\|pi> [--hook] [--force]` | Install skills for the signed-in account's granted tools and an optional Claude Code hook. |
| `artium-axi --managed-session <command> [<args>]` | Supply and persist caller-owned sessions through private pipes; see `artium-axi --managed-session --help`. |
| `artium-axi falcon-axi [<args>]` | Run Falcon commands with managed credentials; [tool reference](https://github.com/knowttl/falcon-axi#readme). |
| `artium-axi vectra-axi [<args>]` | Run Vectra commands with managed credentials; [tool reference](https://www.npmjs.com/package/@knowttl/vectra-axi). |
| `artium-axi az-axi [<args>]` | Run Azure commands with the managed identity; [tool reference](https://www.npmjs.com/package/@knowttl/az-axi). |
| `artium-axi mg-axi [<args>]` | Run Microsoft Graph commands with the managed identity; [tool reference](https://www.npmjs.com/package/@knowttl/mg-axi). |
| `artium-axi ldap-axi [<args>]` | Read directory data with the managed LDAP bind identity; [tool reference](https://www.npmjs.com/package/@knowttl/ldap-axi). |
| `artium-axi ado-axi [<args>]` | Run Azure DevOps commands with managed credentials; [tool reference](https://www.npmjs.com/package/@jeffreyhaen/ado-axi). |
| `artium-axi awx-axi [<args>]` | Inspect AWX automation with managed credentials; [tool reference](https://www.npmjs.com/package/awx-axi). |
| `artium-axi tenable-axi [<args>]` | Investigate Tenable One with managed API keys; [tool reference](https://www.npmjs.com/package/@knowttl/tenable-axi). |
| `artium-axi hybrid-axi [<args>]` | Investigate Hybrid Analysis with a managed API key; [tool reference](https://www.npmjs.com/package/@knowttl/hybrid-axi). |
| `artium-axi checkpoint-axi [<args>]` | Investigate Check Point Email Security with managed regional credentials; [tool reference](https://www.npmjs.com/package/@knowttl/checkpoint-axi). |
| `artium-axi gh-axi [<args>]` | Read and update GitHub data with managed credentials; [tool reference](https://www.npmjs.com/package/gh-axi). |
