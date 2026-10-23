# Client reference

### Command surface and subcommands

| Command | Purpose |
| --- | --- |
| `artium-axi` | Show identity, roles and available tools. |
| `artium-axi --version` | Print only the client package version and a newline, then exit without configuration, sign-in or network access. |
| `artium-axi login --username synthetic-user` | Sign in with a local account. |
| `artium-axi login --sso` | Sign in through browser approval with an enabled SSO provider; works on headless and SSH hosts. |
| `artium-axi passwd` | Change your password, then sign in again. |
| `artium-axi whoami` | Show identity, roles, session and access-token expiry, and server URL. |
| `artium-axi tools` | List enabled runtime tools granted through your roles. |
| `artium-axi tools show falcon-axi` | Show cached status, vetted pinned help and a first-call example. |
| `artium-axi doctor` | Check server address, certificate, token, CLI version and cached tool health, with a five-second deadline per request. Stop dependent probes after address or TLS connection failure. |
| `artium-axi update` | Update the [server-downloaded client](../README.md#verified-client); see the [npm alternative](../README.md#npm-client-alternative) for npm installations. |
| `artium-axi logout` | Remove local tokens and attempt server-session revocation. |
| `artium-axi setup --host claude --hook` | Install your granted skills and optional Claude Code hook after sign-in. |
| `artium-axi falcon-axi detection list` | Run a Falcon read through the managed adapter. |
| `artium-axi vectra-axi detection list` | Run a Vectra read through the managed adapter. |
| `artium-axi mg-axi entra user list --limit 1` | Run a bounded Graph read through the managed adapter. |
| `artium-axi ldap-axi user list --limit 1` | Run a bounded directory read through the managed adapter. |
| `artium-axi az-axi sub list` | Read managed Azure subscriptions. |
| `artium-axi ado-axi project list --limit 1` | Read a managed Azure DevOps project. |
| `artium-axi awx-axi job list --limit 1` | Read a managed AWX job. |
| `artium-axi tenable-axi card list --limit 1` | Read a managed Tenable One exposure card. |

Add `--help` to a local command to inspect its accepted flags.
Top-level help lists command purposes.
Unknown or unexpected local commands, arguments and flags are rejected before configuration, private-channel reads or network access, with valid choices for the relevant command.
Rejected tokens are named, except for `login` and `passwd` input, which is identified by position without printing its value because it may contain a password.
Tool help has two boundaries:

```sh
artium-axi --help falcon-axi
artium-axi falcon-axi --help
```

The first prints local Artium help without signing in or contacting the server.
The second forwards `--help` through the authenticated upstream adapter.
A bare `artium-axi falcon-axi` reads recent detections; use `artium-axi falcon-axi --help` for its command list.
A bare Vectra invocation shows upstream help; `artium-axi az-axi` and `artium-axi az-axi home` run the Azure dashboard with ARM authentication.
A bare `artium-axi ldap-axi` shows directory discovery with managed-credential guidance.
Arguments after a tool name belong to upstream, subject to adapter restrictions on credential, configuration and file paths.
Unknown Azure flags return `INVALID_INPUT` with the flag name, valid flags and a hosted help command.
The bundled CLI forwards argument tokens and local Azure files supplied through the reviewed `--file` and `--body-file` flags.
It captures bounded non-terminal stdin only for Azure `rg query` (also `graph query`), `logs query` (also `monitor log-analytics query`) and `api` calls.
Other Azure commands, including the dashboard and `home`, leave stdin unread; help and version calls also leave it unread.
Local upload paths become leaf names in the request; duplicate leaf names and oversized input are refused.
The API supports bounded stdin and named uploads through the [shared API contract](../src/shared/api.ts).

See [write-access administration](runbook.md#roles-credentials-and-health) for per-tool switches, native write gates and the current Falcon limitation.
Artium does not add a universal confirmation flag.

Azure writes whose outcome is unknown are not retried and return `UNKNOWN_OUTCOME` with state-check guidance; reads may still retry.
Artium also returns this error when its runner times out, cancels or receives a process signal after starting an executed Azure write; read timeouts remain `TIMEOUT`.
Before submitting the write again, follow the returned read commands and inspect the changed state.
Keep `--full` on recovery API GET commands so long changed values are not truncated, including both `Check current state before trying again` and `Verify with` suggestions.
Runner-generated recovery for Sentinel incident updates and comment creation first resolves the incident ID with the suggested `incident show` command, then uses that ID in the suggested API GET to inspect all incident fields or the comments collection.

### TOON output behavior

Discovery and Artium errors use TOON.
Tool listings include their count in the array header; an empty list returns `tools: 0 available` with a reason and next step.
Details read bundled manifests and stored health without fetching credentials or executing upstream help.
Discovery and administration show the server's bundled tool versions, as defined by the [API contract](../src/shared/api.ts).

The home view and `whoami` display `sessionExpiresAt` and `accessExpiresAt` as UTC timestamps with remaining whole hours and minutes, or `expired` when the deadline has passed.
`sessionExpiresAt` is the fixed session-family deadline; refreshing an access token does not extend it.
`accessExpiresAt` is the current access-token deadline; automatic refresh requires a refresh token, as described in [client settings](#client-settings).
Doctor includes the session deadline and remaining time in its token diagnostic.

Upstream calls preserve stdout, stderr and nonzero exit codes.
If a reader closes stdout or stderr early, the CLI suppresses `EPIPE` without changing the command's exit status or interrupting the other stream.
For managed tools, recognized TOON or JSON root `help` suggestions, plain upstream help and bundled tool-detail help use `artium-axi <tool>` commands, including examples originally invoking `npx -y @knowttl/<tool>`.
Recognized flag listings and command suggestions omit managed flags declared in each pinned [tool inventory](../tools/inventories/)'s `unsafeOverrides`, including Graph profile, config and scopes selectors.
Per-flag help removes each managed flag's entire description and preserves retained flag descriptions, including comma-separated defaults.
LDAP home output lists hosted commands, and recognized connection and TLS recovery hints direct callers to an administrator to update the [stored LDAP credentials](tool-credentials.md#ldap).
Unrelated content, literal argument values, unknown formats and truncated streams remain unchanged.
Capture is capped at 4 MiB per stream, with truncation diagnostics on stderr.
Artium failures withhold captured output and return exit 2 for usage or client configuration failures, or exit 1 for other failures.
See the [generated error reference](errors.md) for codes, HTTP status, CLI exit status and recovery steps.

Doctor reads cached tool health rather than running a fresh platform test.
Its certificate diagnostic reports whether the liveness request verified TLS, independently of the HTTP status or response body.
If the connection or CA-file read fails before verification, the certificate remains unverified.
Only `ok` passes; `unknown`, `unconfigured` and `error` require investigation.
If the client reports `CLI_OUTDATED`, follow the README's [client update guidance](../README.md#verified-client) or [npm alternative](../README.md#npm-client-alternative), according to your installation.

## Agent installation

Setup installs `skills/<name>/SKILL.md` under the following host directories:

| Host | Directory | Override |
| --- | --- | --- |
| Claude Code | `~/.claude` | `CLAUDE_CONFIG_DIR` |
| Codex | `~/.agents` | None |
| OpenCode | `~/.config/opencode` | None |
| Pi | `~/.pi/agent` | `PI_CODING_AGENT_DIR` |

The optional Claude hook lives in that directory's `settings.json`.
To remove it, delete only hook objects with `statusMessage: "artium-axi managed tools"` from `hooks.SessionStart`, preserving unrelated entries.
Remove only Artium-managed skill directories you intend to uninstall; inspect their content and managed checksum marker first.
There is no setup uninstall command.
Skills for granted but disabled tools can be installed; execution still returns `TOOL_DISABLED`.
Installation does not establish that an agent host has loaded the skill.

### Client settings

| Variable | Meaning |
| --- | --- |
| `ARTIUM_AXI_URL` | HTTPS base URL without credentials, query or fragment; overrides the saved URL. Required in managed mode. |
| `ARTIUM_AXI_CA_FILE` | Optional readable PEM CA file added to Node's certificate trust; overrides the saved CA path. |
| `ARTIUM_AXI_PASSWORD` | Ordinary login password source when `--password-stdin` is absent, before the terminal prompt; refused for [managed sign-in](#externally-managed-client-sessions). |
| `ARTIUM_AXI_CURRENT_PASSWORD` | Current password for an ordinary password change, before the terminal prompt. |
| `XDG_CONFIG_HOME` | Session-file base on Linux/macOS; otherwise `~/.config`. |
| `APPDATA` | Session-file base on Windows, whose execution remains unverified. |
| `ARTIUM_AXI_TEST_HTTP` | `1` permits loopback HTTP for tests only. |

Use `login --password-stdin` or `passwd --password-stdin` to supply the login or new password through stdin.
Stdin removes one final LF or CRLF and preserves all other spaces and Unicode.
Password arguments are refused; tokens are never printed to stdout or stderr.
Ordinary password changes also require the current password through the terminal prompt or `ARTIUM_AXI_CURRENT_PASSWORD`.
Clear password environment values after use.

By default, sessions live in `artium-axi/session.json` under the applicable base directory and are bound to the normalized server URL.
Ordinary password and SSO login save the server URL and optional absolute CA file path in the adjacent `config.json`, with the same private write protections.
For the first login, or to save settings for an existing session, set `ARTIUM_AXI_URL` and any required `ARTIUM_AXI_CA_FILE`, then sign in again.
Later commands use those saved settings when the corresponding environment variables are unset, including commands run by installed hooks and skills.
Agent hosts must use the same configuration directory, and any saved CA file must remain readable at its saved path.
`doctor` reports whether the address came from `ARTIUM_AXI_URL` or `config.json`.
Logout keeps these connection settings; managed mode neither reads nor writes them.
Callers that manage their own tokens can instead use [externally managed client sessions](#externally-managed-client-sessions).
POSIX directories use mode 0700 and files mode 0600; Windows uses a restricted ACL and refuses storage if it cannot establish it.
Do not export or share the session file.
CLI processes serialize refreshes through `session.lock`; after `SESSION_BUSY`, remove that lock directory only when every CLI process has exited.
Concurrent login or logout can produce `SESSION_CHANGED`; check the current session before repeating a command.
Logout removes local tokens even if remote revocation fails, reporting `remoteRevocation: unverified` in that case.

Certificate verification remains enforced even with `NODE_TLS_REJECT_UNAUTHORIZED=0`, and authenticated redirects are refused.
Only an explicit pre-execution `TOKEN_EXPIRED` response permits one serialized refresh and retry.
A network failure or uncertain command outcome is never retried automatically.

### Externally managed client sessions

Callers that keep credentials outside the CLI can opt in with one leading flag: `artium-axi --managed-session <command> <args>`.
The caller supplies inherited pipes or sockets: fd 3 for session input on authenticated calls and fd 4 for private new-session and rotation output.
Stdin remains available for tool input; stdout and stderr retain their normal command formats.
Do not pass tokens in arguments or environment variables, connect fd 4 to a log or public output, or redirect either private channel to a disk file.
The CLI refuses regular files as private channels and never reads, creates, locks, updates or deletes `session.json` in this mode.

For authenticated calls, send one UTF-8 JSON object of at most 64 KiB to fd 3, then close the input pipe:

```json
{"serverUrl":"https://artium.example.test","accessToken":"CANARY-access","refreshToken":"CANARY-refresh"}
```

`serverUrl` must match the normalized `ARTIUM_AXI_URL`, allowing a final slash.
`accessToken` is required and nonempty; `refreshToken` is optional and nonempty when supplied.
The optional fields `status: "authenticated"`, `accessExpiresAt` and `familyExpiresAt` (integer Unix milliseconds) allow a rotation record to be reused as input; other fields are refused.
The caller owns expiry policy, refresh serialization across processes and secure persistence.
Managed mode supports `login`, the home view, `whoami`, `tools`, `tools show`, `doctor` and tool commands.
`passwd`, `logout`, `setup` and `update` are refused before configuration, private-channel reads or network access; ordinary sign-in and its server-version warning remain unchanged without the flag.
Help is available without private channels through `artium-axi --help`; use `artium-axi --managed-session --help` or `artium-axi login --help` for the pipe protocol.

To obtain the first session, run `artium-axi --managed-session login --username <username> --password-stdin` with the password on protected inherited stdin, or `artium-axi --managed-session login --sso` for browser approval.
Login does not read or require fd 3; it requires a writable private pipe or socket on fd 4 before contacting the server.
Password arguments and `ARTIUM_AXI_PASSWORD` are refused, including when `--password-stdin` is present; unset that variable before managed sign-in.
Password input follows the stdin rules in [client settings](#client-settings).
SSO displays the approval URL and user code immediately so the user can approve while the CLI waits.
Both sign-in methods return the new session as one newline-terminated JSON object on fd 4, using the same envelope shown below for rotations, and create nothing under the config or session paths.
The login server-version warning still appears on stderr when versions differ.
If a local account requires a password change, fd 4 instead receives `{serverUrl, status: "password-change-required", passwordChangeToken, passwordChangeExpiresAt}` and the command returns `PASSWORD_CHANGE_REQUIRED` (exit 1).
That restricted record is not valid managed-session input; the caller must complete the password change through the server API and sign in again.

Only an explicit `TOKEN_EXPIRED` response permits a single refresh and retry of that request.
Without a refresh token, or if refresh is refused, the CLI returns the authentication error for the caller to handle.
Network failures and uncertain outcomes are never automatically retried.
After a successful refresh, fd 4 receives one newline-terminated JSON object before the request is retried:

```json
{"serverUrl":"https://artium.example.test","status":"authenticated","accessToken":"CANARY-new-access","refreshToken":"CANARY-new-refresh","accessExpiresAt":1800000000000,"familyExpiresAt":1800003600000}
```

Every rotation is delivered even if the subsequent request fails; an authenticated invocation without rotation writes no record.
Consume fd 4 concurrently with stdout and stderr, and retain new sessions and rotations regardless of the command's exit status.
If new-session or rotation delivery fails, the CLI returns `INVALID_INPUT` (exit 2); the caller must recover the session.
After failed rotation delivery, the CLI refuses to retry the request; do not reuse the consumed refresh token.
Managed public output is buffered and scanned against supplied, newly issued and rotated tokens and their canonical encodings before printing; a match withholds both buffered streams and returns `SECRET_IN_OUTPUT`.
SSO approval instructions are displayed before session issuance; managed password input and the private SSO device code are also checked against buffered output.

Exit codes are 0 for success, 2 for invalid input, client configuration or private channels and refused commands, and 1 for authentication, server-binding, transport or output-scanning failures.
Tool exit codes pass through as usual.
Missing or closed descriptors, invalid JSON and mismatched server bindings fail before network access; no failure falls back to a session file.
