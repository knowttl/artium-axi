# artium-axi

Client CLI and embedded skill for the Artium managed tools server.

[![npm](https://img.shields.io/npm/v/@knowttl/artium-axi)](https://www.npmjs.com/package/@knowttl/artium-axi) [![License: MIT](https://img.shields.io/github/license/knowttl/artium-axi)](LICENSE) [![Node](https://img.shields.io/badge/Node-%3E%3D24.11.0-green)](package.json) [![npm provenance](https://img.shields.io/badge/npm-provenance-blue)](https://github.com/knowttl/artium-axi/attestations) [![AXI](https://img.shields.io/badge/AXI-TOON-blue)](https://github.com/knowttl/axi)

[Why this exists](#why-this-exists) · [Quickstart](#quickstart) · [Use with your agent](#use-with-your-agent) · [What it covers](#what-it-covers) · [Safety](#safety) · [Configuration](#configuration) · [Output and exit codes](#output-and-exit-codes) · [Troubleshooting](#troubleshooting) · [Contributing](#contributing) · [Security](#security) · [License](#license)

## Why this exists

Separate vendor CLIs put credentials, access controls and API guesswork on every agent host.
Artium runs pinned tools on a shared server for agents and the humans running them, checking roles and supplying server-held credentials after audited admission.
Bounded execution, TOON discovery and contextual next steps help agents find a permitted read before attempting a gated write.
Administrators deploy and configure the server; client users sign in and discover their granted tools.

## Quickstart

Use Linux with Node **24.11.0+** and a trusted HTTPS server URL and account from your administrator.

```sh
npm install --global @knowttl/artium-axi
artium-axi doctor
# Without a global install: npx -y @knowttl/artium-axi doctor
```

Before configuration, doctor reports failures such as `fail: server address (CLIENT_CONFIG_INVALID)`.
Configure and sign in, then discover a first read:

```sh
export ARTIUM_AXI_URL='https://artium.example.test'
artium-axi login --username synthetic-user
artium-axi
artium-axi tools show falcon-axi
artium-axi falcon-axi detection list
```

Login prompts privately for a password; replace the synthetic account and choose a tool granted to you.
For SSO, use `artium-axi login --sso` and approve only your terminal's browser code.
For a private CA, set `ARTIUM_AXI_CA_FILE` to a readable PEM file before login.
Login saves connection settings; shared service credentials and tool profiles are configured by administrators.
See [verified server downloads and updates](docs/client-reference.md#verified-client) or [server deployment](docs/admin-guide.md#set-up-a-host).

## Use with your agent

After sign-in, install managed skills and the optional Claude Code discovery hook:

```sh
artium-axi setup --host claude --hook
```

For Codex, OpenCode or Pi, use `--host codex`, `--host opencode` or `--host pi` without `--hook`.
The Claude `SessionStart` hook injects `tools` output; skills teach managed command discovery and grant no permissions.
Artium's authenticated setup fetches granted tools' adapted skills; a standalone skill installer does not configure this server account.
See the [base SKILL.md](skill/artium-axi/SKILL.md), [command reference](docs/commands.md) and authenticated `artium-axi tools show <tool>` for commands.
Re-run setup after moving the executable or changing grants.
To remove the hook, delete only objects labelled `statusMessage: "artium-axi managed tools"` from `hooks.SessionStart` in the Claude host's `settings.json`.
See [installation paths and manual skill removal](docs/client-reference.md#agent-installation).

<a id="features"></a>
<a id="commands"></a>

## What it covers

All eleven managed tools start disabled; role grants, enabled tools and upstream permissions determine access.
Write capabilities below require administrator opt-in.

| Group | Purpose | Access | Reference |
| --- | --- | --- | --- |
| Discovery and sessions | Identity, login, tools, doctor, update and setup | Client/session operations | [Commands](docs/commands.md) |
| Falcon | Endpoint investigations, guarded RTR and MalQuery | Reads; selected execution/search | [Capabilities](docs/safety.md#write-gates-by-tool) |
| Vectra | Hosts, detections and response workflows | Reads; selected writes | [Credentials](docs/tool-credentials.md#vectra) |
| Azure | Subscriptions, resources and queries | Reads; reviewed writes | [Credentials](docs/tool-credentials.md#azure) |
| Microsoft Graph | Entra, optional mail and hunting packs | Reads; selected writes | [Capabilities](docs/safety.md#microsoft-graph) |
| LDAP | Directory investigation over verified TLS | Read-only | [Credentials](docs/tool-credentials.md#ldap) |
| Azure DevOps | Organization and project workflows | Reads; reviewed writes | [Credentials](docs/tool-credentials.md#azure-devops) |
| GitHub | Repository investigation and collaboration | Reads; selected writes | [Credentials](docs/tool-credentials.md#github) |
| AWX | Jobs, workflows and operational actions | Reads; selected writes | [Credentials](docs/tool-credentials.md#awx) |
| Tenable One | Exposure investigation and export jobs | Reads; selected writes | [Credentials](docs/tool-credentials.md#tenable-one) |
| Hybrid Analysis | Sandbox investigations, YARA and archives | Reads; selected writes/saves | [Credentials](docs/tool-credentials.md#hybrid-analysis) |
| Check Point Email Security | Email investigation and response | Reads; selected writes/saves | [Credentials](docs/tool-credentials.md#check-point-email-security) |

[Reviewed inventories](tools/inventories) own the pinned command boundary.
The [client reference](docs/client-reference.md#command-surface-and-subcommands) covers forwarding and inputs; [commands](docs/commands.md) lists client operations.

## Safety

Managed writes are off by default: administrator capability alone grants no tool access.
Enabled tools are read-only by default, with documented exceptions such as Hybrid Analysis quick scans that transmit samples or URLs.
There is no universal Artium confirmation flag or `ARTIUM_AXI_READ_ONLY` environment switch.
Administrators keep writes disabled or narrow operation allowlists; native gates can require preview, `--execute` and exact `--confirm`.
After an unknown outcome, inspect state before retrying.
Shared credentials are encrypted and never returned to clients; protect the entire data volume because it also holds the plaintext master key.
Client tokens are stored privately; never share session files or paste credentials into chat.
Linux client and Linux amd64 container paths have fake-service acceptance; Windows/macOS execution and agent-host loading remain unverified.
See [per-tool gates, storage and limits](docs/safety.md), [permissions](docs/tool-credentials.md), [deployment prerequisites](docs/runbook.md#scope-and-prerequisites) and [security boundaries](docs/admin-guide.md#security-and-acceptance-boundaries).

## Configuration

Connection settings are saved in `config.json` beside `session.json`; tool profiles and upstream credentials live on the server.

| Platform | Client configuration directory |
| --- | --- |
| Linux/macOS | `${XDG_CONFIG_HOME:-~/.config}/artium-axi` |
| Windows | `%APPDATA%\artium-axi` (execution unverified) |

| Client environment variable | Purpose | Default |
| --- | --- | --- |
| `ARTIUM_AXI_URL` | HTTPS server URL override | Saved URL; required initially |
| `ARTIUM_AXI_CA_FILE` | Additional PEM CA file | Saved CA path or Node trust |
| `ARTIUM_AXI_PASSWORD` | Ordinary login password, before terminal prompt | Unset; refused in managed mode |
| `ARTIUM_AXI_CURRENT_PASSWORD` | Ordinary password-change current password | Terminal prompt |
| `XDG_CONFIG_HOME` | Linux/macOS config base | `~/.config` |
| `APPDATA` | Windows config base | Required on Windows |
| `CLAUDE_CONFIG_DIR` | Claude setup directory | `~/.claude` |
| `PI_CODING_AGENT_DIR` | Pi setup directory | `~/.pi/agent` |
| `ARTIUM_AXI_TEST_HTTP` | Test-only loopback HTTP when `1` | Disabled |
| `ARTIUM_AXI_SESSION_ACL_PATH`, `ARTIUM_AXI_SESSION_ACL_KIND` | Internal Windows ACL subprocess inputs | Set by client; do not configure |

Prefer hidden password prompts or protected `--password-stdin`; clear password environment values after use.
See [client settings and refresh behavior](docs/client-reference.md#client-settings) and [server settings](docs/admin-guide.md#server-settings-and-custody) for the separate server environment and profile reference.

<a id="toon-output-and-errors"></a>

## Output and exit codes

Discovery and Artium errors use TOON on stdout; progress uses stderr.
Upstream stdout, stderr and exit status pass through, subject to managed suggestion adaptation and hosted status filtering.
Hosted status omits server paths and secret references expose only their source kind; malformed or truncated hosted status is withheld with `INVALID_RESPONSE`.
Tool output limits vary; `--full` restores supported text within byte/time budgets and secret redaction.

| Artium exit | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Authentication, server or transport failure |
| 2 | Usage or configuration error |

See [output behavior](docs/client-reference.md#toon-output-behavior) and the generated [error catalogue](docs/errors.md).

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| `CLIENT_CONFIG_INVALID` | Set the HTTPS URL and a readable CA file if needed, then sign in. |
| `PASSWORD_CHANGE_REQUIRED` | Run `artium-axi passwd`, then sign in again. |
| `CLI_OUTDATED` | Follow [installation-specific update guidance](docs/client-reference.md#verified-client). |
| No available tools | Ask an administrator to check enabled tools and role grants. |
| `CERTIFICATE_INVALID` | Check server TLS and the [private CA setup](docs/runbook.md#proxy-and-certificate-trust). |

<a id="verified-client"></a>
<a id="npm-client-alternative"></a>
<a id="build-from-source"></a>
<a id="platform-limits"></a>

Installation details live in the [client reference](docs/client-reference.md#verified-client), [source-build guide](CONTRIBUTING.md#build-from-source) and [platform limits](docs/runbook.md#platform-limits).

## Contributing

Use Linux and follow [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).
Development and release validation run locally through no-mistakes with fakes and synthetic identities; there is no hosted test CI.

## Security

See [SECURITY.md](SECURITY.md) for security boundaries and handling sensitive reports.

## License

[MIT](LICENSE).
