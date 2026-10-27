# artium-axi

Managed command-line tools for agents and the humans running them, with one sign-in, role-based access and server-held service credentials.

[![License: MIT](https://img.shields.io/github/license/knowttl/artium-axi)](LICENSE)
[![npm](https://img.shields.io/npm/v/@knowttl/artium-axi)](https://www.npmjs.com/package/@knowttl/artium-axi)
[![Node](https://img.shields.io/badge/Node-%3E%3D24.11.0-green)](package.json)
[![Release provenance](https://img.shields.io/badge/release-provenance-blue)](https://github.com/knowttl/artium-axi/attestations)

[Quickstart](#quickstart) • [Use with your agent](#use-with-your-agent) • [Features](#features) • [Safety](#safety) • [Configuration](#configuration) • [Commands](#commands)

```mermaid
flowchart LR
  Agent[Agent or human] --> CLI[Artium CLI]
  CLI -->|HTTPS and Artium identity| Server[Artium server]
  Admin[Administrator] -->|Browser administration| Server
  Server --> Store[Encrypted credentials and audit]
  Server --> Runner[Bounded tool runner]
  Runner --> APIs[Vendor APIs]
```

## Why this exists

Separate vendor CLIs require separate credentials and access controls on every agent host.
Artium runs pinned tools on a shared server, checks each user's roles and supplies the service credential after audited admission.
Agents keep a command-line interface with TOON discovery rather than implementing each vendor's REST authentication or an MCP integration.

## Features

- **Access:** local or browser SSO sign-in, role grants and session revocation.
- **Credentials:** encrypted shared service identities, private per-call profiles and credential tests.
- **Discovery:** available tools, cached health, pinned versions and contextual first-call suggestions.
- **Agent setup:** managed skills for Claude Code, Codex, OpenCode and Pi; optional Claude Code session hook.
- **Audit:** authentication, administration and tool-call records with filtered CSV/JSON-lines export.
- **Limits:** reviewed command inventories, write switches, bounded runtime, output and concurrency.

### Supported pinned tools
| Tool | Managed access |
| --- | --- |
| Falcon | API client; see [supported capabilities](#safety) |
| Vectra | Token or OAuth; optional allow-listed writes |
| Azure | Application identity and resource-token broker |
| Microsoft Graph | Application identity; optional allow-listed writes |
| LDAP | Verified TLS simple bind; read-only |
| Azure DevOps | PAT or application identity |
| AWX | Pasted token or one-time password sign-in; optional operational writes |
| Tenable One | Access and secret API keys; optional allow-listed business writes and export jobs |
| Hybrid Analysis | Managed API key; investigation reads and optional allow-listed submissions, YARA mutations and consuming matches |

[Package pins](tools/package.json) and the [Falcon source pin](tools/falcon-source.json) own bundled versions; [reviewed inventories](tools/inventories) define the supported command boundary.

## Quickstart

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

For manual deployment, follow the [administrator guide](docs/admin-guide.md#set-up-a-host).

### Verified client
Use Linux with Node **24.11.0+**, curl and sha256sum, and obtain the trusted HTTPS URL and account from your administrator.
For a private CA, set `ARTIUM_AXI_CA_FILE` to a readable PEM file and add `--cacert "$ARTIUM_AXI_CA_FILE"` to both curl commands.

```sh
export ARTIUM_AXI_URL='https://artium.example.test'
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

Stop if a download or checksum fails.
The checksum detects corruption and mixed releases; trust still comes from the HTTPS server.

```sh
artium-axi login --username synthetic-user
artium-axi tools
artium-axi tools show falcon-axi
artium-axi falcon-axi detection list
```

Replace the synthetic username with your account; login uses a hidden terminal password prompt.
For `PASSWORD_CHANGE_REQUIRED`, run `artium-axi passwd`, then log in again.
For SSO, use `artium-axi login --sso` and approve only the browser code matching your own terminal.
After ordinary login, later commands, installed hooks and skills use [saved connection settings](docs/client-reference.md#client-settings).
After a server upgrade, run `artium-axi update` if your client has that command, then `artium-axi --version`.
For clients without `update`, repeat the verified download and checksum check above to install the server's current client.
For `CLI_OUTDATED`, the server uses the client version header to select the update hint or safe download guidance; the capability boundary is defined by `firstVersionWithUpdate` in [the version contract](src/shared/version.ts).
The updater uses those connection settings, verifies the server download’s SHA-256, replaces the running client file and keeps the previous client beside it as `<client-file>.bak`.
The client file and its directory must be writable.
The Falcon read requires an enabled tool, a role grant and API permissions; choose the example from an available tool's detail view.

With no enabled tools granted, `artium-axi tools` succeeds with:

```text
tools: 0 available
reason: No enabled runtime tool is available through your assigned roles.
contact: Ask an administrator to check your role assignments and enabled tools.
next[1]:
  - artium-axi whoami
```

### npm client alternative
The server download supplies its matching client; npm is an alternative client-only distribution.

```sh
npm install -g @knowttl/artium-axi
export ARTIUM_AXI_URL='https://artium.example.test'
artium-axi login --username synthetic-user
```

Login warns about version differences; minimum server API requirements still apply.
`artium-axi update` refuses npm installations; update them with `npm install -g @knowttl/artium-axi@latest`.
Install `@knowttl/artium-axi@<server-version>` or download from the server to match it.

### Build from source
Use Node 24.11.0+, pnpm 10.22.0, OpenSSL, Python 3, curl and sha256sum on Linux.

```sh
git clone https://github.com/knowttl/artium-axi.git
cd artium-axi
pnpm install --frozen-lockfile
pnpm build
node dist/cli/artium-axi.mjs --help
```

Use `node dist/cli/artium-axi.mjs` in place of `artium-axi` for the same login and discovery steps.
The root install also installs frozen upstream dependencies; native build approval is limited to argon2, better-sqlite3 and esbuild.
`pnpm build:npm` stages the public client in `dist/npm`; `npm pack --dry-run ./dist/npm` inspects its contents.

## Use with your agent

After signing in, install the base skill and your granted tools' adapted skills:

```sh
artium-axi setup --host claude --hook
```

Use `--host codex`, `--host opencode` or `--host pi` without `--hook` for those hosts.
Only Claude Code supports the optional `SessionStart` hook, which injects the `tools` discovery output.
Setup preserves unrelated settings and refuses edited/unmanaged skills unless `--force` is explicit.
Re-run setup after moving the executable or changing grants; skills for removed grants are retained and reported.
On Windows, installed skills include labelled PowerShell and Git Bash invocations; use the command for your shell.
See [installation paths and manual removal](docs/client-reference.md#agent-installation) before uninstalling.
Artium's authenticated setup fetches managed skills; a standalone skill installer does not configure this server account.

## Safety

All tools start disabled; write access defaults to off.
Administrator capability alone grants no tool access; upstream permissions remain an additional boundary.

Microsoft Graph defaults to the `entra` pack.
Administrators can opt in to the single read-only `security hunting query` command for Defender XDR advanced hunting with `enabledPacks: ["entra", "security"]` in the managed tool settings.
Hunting accepts exactly one UTF-8 plain-text upload named `query.kql`, at most 64 KiB, through `artium-axi mg-axi security hunting query --file query.kql`.
See [client input handling](docs/client-reference.md#command-surface-and-subcommands) for local file paths and upload restrictions.
Queries must use the upstream restricted read-only KQL subset.
The existing mg-axi role grant is required; other security commands remain unavailable.
See [Graph credential setup](docs/tool-credentials.md#microsoft-graph) for hunting permissions and consent; tenant acceptance remains unverified.

Falcon investigation reads include detection lineage, process details and trees, existing sandbox reports, FileVantage changes and device-control policy details.

Vectra supports selected QUX/RUX writes for detection close/open and mark-fixed, host/account close, key assets, tags, notes (including bulk notes), assignments and outcomes, triage labels and rules, groups and membership, proxies, threat feeds, internal-network settings, syslog/Kafka, notification destinations and Match, subject to deployment support in the [reviewed inventory](tools/inventories/vectra-axi.json).
User, role, API-client and credential administration remains blocked.
Review the [Vectra grant warnings](docs/admin-guide.md#browser-administration) before enabling operations.
See [client input handling](docs/client-reference.md#command-surface-and-subcommands) for Vectra file inputs.

| Tool | Write capability and unlock |
| --- | --- |
| Falcon | Separate, off-by-default capabilities for guarded RTR execution and bounded MalQuery exact/fuzzy literal search. RTR retains the standard read-only command allowlist and profile narrowing. Host changes, scripts, hunt and file transfers remain unavailable. See [Falcon execution setup](docs/runbook.md#falcon-rtr-execution). |
| LDAP | Fixed read-only. |
| Azure | Reviewed resource mutations; administrator `allowWrites: true` plus native command gates. |
| Graph | Native mutations only with administrator `writes.allowWrites: true` and an explicit operations allow-list, plus native gates. |
| Vectra | Administrator `writes.allowWrites: true` and an explicit operations allow-list, native preview, `--execute`, exact `--confirm` and redacted journaling. Artium enforces the native read-only override while write access is off. |
| Azure DevOps | Reviewed mutations with administrator `allowWrites: true`; raw `api` remains GET-only. |
| AWX | Launch/cancel/relaunch, workflow approval/denial, project/inventory-source sync and notification tests with `allowWrites: true` and upstream `--confirm`; configuration, deletion and security writes stay blocked. |
| Tenable One | Business writes and export-job creation with administrator `writes.allowWrites: true`, an explicit operations allow-list, native preview, `--execute`, exact `--confirm` and durable journaling; downloads and local configuration stay blocked. |
| Hybrid Analysis | Sandbox submissions, YARA create/update/delete, consuming hunting matches and the four reviewed archive downloads require administrator `writes.allowWrites: true`, independently selected operations, native preview, `--execute`, exact `--confirm` and durable journaling. Downloads are limited to `hash-download-bin`, `report-download-bin`, `report-download-dropped-files` and `report-download-memory`, through the [authenticated CLI verified-save path](docs/client-reference.md#hybrid-analysis-archive-saving) after the [operator prerequisites](docs/runbook.md#scope-and-prerequisites) pass. All operations default off; enabling other writes never enables downloads or grants upstream entitlement. The browser provides warnings, command guidance and metadata/save status only. Ordinary tool-run downloads, local configuration and credential/origin overrides are blocked. |

Hybrid Analysis quick scans transmit the supplied sample or URL as read exceptions without a write gate; sandbox submission previews disclose that samples and reports can become visible to the community.
Consuming hunting matches is account-wide across all rules, with no rule selector, and irreversibly marks every returned match delivered; reconcile ambiguous outcomes using the audit ID, durable native journal and returned read-back guidance before retrying.
Updating a YARA rule with `reset_counter:true` resets its all-time match counter and changes its rule ID; use the returned ID for subsequent commands.
Labs hunting and search contracts are experimental.

There is no universal Artium confirmation flag.
Use authenticated tool help and the [write-access runbook](docs/runbook.md#roles-credentials-and-health) for operation-specific gates.
After an unknown write outcome, inspect state using returned guidance before retrying.

| Initial read | Required upstream permission |
| --- | --- |
| Falcon detections | `Alerts:read` |
| Vectra credential test | Health reads plus permissions for intended data |
| Azure subscription list | Application access to intended subscriptions; data-plane roles separately |
| Graph first-user read | Application `User.Read.All` with administrator consent |
| LDAP | Bind identity with directory read access |
| Azure DevOps project list | Identity permitted to view the organization/project |
| AWX job list | Token identity with job read access |
| Tenable One card list | See [Tenable One credential permissions](docs/tool-credentials.md#tenable-one). |
| Hybrid Analysis quota | A valid API key; resource permissions vary by key level. See [Hybrid Analysis setup](docs/tool-credentials.md#hybrid-analysis). |

See [tool credentials](docs/tool-credentials.md) for dedicated identities, permissions and safe credential entry.
Artium stores shared service credentials encrypted with AES-256-GCM and never returns saved secrets to clients.
The data volume also holds the plaintext master key beside SQLite: protect the entire volume and keep offline escrow separate.
Linux client sessions use a mode-0700 directory and mode-0600 file under `${XDG_CONFIG_HOME:-~/.config}/artium-axi`.
Access tokens last one hour, with 12-hour local or 8-hour SSO CLI families; password changes revoke sessions.

Requests, bounded tool input and uploads travel to the server; enabled tools contact their upstream APIs using shared service identities.
Audit excludes injected credentials, request bodies, stdin, uploads and output streams.
The runner scans known secret encodings and discards output on a match; unknown upstream-minted tokens cannot be identified by exact-value scanning.
Its restricted environment, private directories and process limits are not a complete sandbox; descendants starting a new session can escape process-group termination.

## Configuration

| Setting or flag | Purpose |
| --- | --- |
| `ARTIUM_AXI_URL`, `ARTIUM_AXI_CA_FILE` | Connection overrides; see [client settings](docs/client-reference.md#client-settings) |
| `XDG_CONFIG_HOME` | Linux session-storage base, default `~/.config` |
| `--password-stdin` | Login/new password via protected stdin |
| `--host`, `--hook`, `--force` | Setup host, optional Claude hook, explicit skill replacement |
| `--managed-session` | Caller-owned tokens through private pipes; see client reference |
| `--help`, `--version` | Local discovery without sign-in |

See the [client reference](docs/client-reference.md) for password inputs, refresh behavior, uploads and managed sessions.
Server settings, SSO and browser administration live in the [administrator guide](docs/admin-guide.md).
Recovery, rotation, retention, backups and release gates live in the [operations runbook](docs/runbook.md).

## Commands

This summary follows the [CLI help registry](src/cli/help.ts); `artium-axi --help` prints its complete current command list.

| Command | Purpose |
| --- | --- |
| `artium-axi` | Identity, roles and available tools |
| `login --username <username>` / `login --sso` | Local password / browser approval |
| `passwd` / `logout` | Change password / remove local tokens and attempt revocation |
| `whoami` | Identity, roles, [session and access-token expiry](docs/client-reference.md#toon-output-behavior) and server |
| `tools` / `tools show <tool>` | Granted enabled tools / pinned help and first call |
| `doctor` | Server, TLS, token, version and cached health; five-second request deadlines |
| `update` | Update the [server-downloaded client](#verified-client) |
| `download` | Preview and explicitly verify/save administrator-selected Hybrid Analysis archives through the local CLI. Run `artium-axi download --help` for guards and warnings. |
| `setup --host <host>` | Install managed skills and optional Claude hook |
| `<tool> <args>` | Run any of the nine managed tools above |
| `--managed-session --help` | Private-pipe session protocol |

`artium-axi --help falcon-axi` is local help; `artium-axi falcon-axi --help` authenticates and calls upstream.
The [full client reference](docs/client-reference.md#command-surface-and-subcommands) describes forwarding and supported input.

### TOON output and errors
Discovery and Artium errors use TOON on stdout; progress uses stderr.
Upstream stdout, stderr and exit status pass through, subject to managed suggestion adaptation and hosted status filtering.
Hosted home and authentication status omit server executable and configuration paths; secret references report only their source kind, `env` or `file`.
Malformed or truncated hosted status output is withheld with `INVALID_RESPONSE`.
Artium exits 0 for success, 2 for usage/configuration errors and 1 for authentication/server/transport failures.
See the generated [error catalogue](docs/errors.md) for actionable codes and retry guidance.

## Platform limits

Linux client and Linux amd64 container paths have local fake-service acceptance.
Windows/macOS execution, token storage and actual agent-host loading remain unverified.
Local tests do not establish live vendor permissions or production host acceptance.
LDAP uses simple bind over verified TLS; ambient Kerberos, per-user upstream credentials and external secret stores are unsupported.
Azure has reviewed bounded input/upload support; ADO and AWX reject stdin and file uploads.
See [client input handling](docs/client-reference.md#command-surface-and-subcommands) for Hybrid Analysis uploads and explicit JSON stdin, and [Safety](#safety) for its capability boundaries.
See [adapter limits](docs/tool-credentials.md) and [deployment requirements](docs/runbook.md#scope-and-prerequisites).

## Contributing

Use Linux and run `pnpm check`; every change uses local no-mistakes validation, with no hosted test CI.
See [CONTRIBUTING.md](CONTRIBUTING.md) for hygiene checks, conditional container acceptance and the mandatory release container gate.

## License

[MIT](LICENSE).

If this project saved you time or helped your workflow, please consider giving it a ⭐ on GitHub to help others find it!
