# Client reference

## BeyondTrust PM Cloud

Discover with `artium-axi beyondtrust-axi computer list --limit 1`.
Use authenticated command --help for selectors and filters.
See [credential setup](tool-credentials.md#beyondtrust-pm-cloud) and the [supported capability boundary](safety.md#beyondtrust-endpoint-privilege-management) before using writes or uploads.
Upload local JSON, CSV or policy files with `--file <local-path>`; the CLI sends the bytes rather than a server path.

Use `artium-axi download --operation policy.download --selector <uuid> --type content --destination <absolute-new-path>` for preview.
Repeat the selection and destination with the returned --transfer, --execute and exact --confirm plus fresh identity confirmation.
computer.log.download and policy.revision.download also use a UUID selector and type content.
api-definition.download uses selector api and type yaml.
Complete the [shared artifact-mount and controlled-client prerequisites](runbook.md#scope-and-prerequisites) before using downloads.
Downloads save untrusted raw bytes, at most 50 MiB, in a new 0600 local file with verified SHA-256 and a save receipt.
Never extract or execute downloaded content or retry an uncertain outcome.


Contents:

- [Verified client](#verified-client)
- [npm client alternative](#npm-client-alternative)
- [Microsoft Graph mail saving](#microsoft-graph-mail-saving)
- [Command surface and subcommands](#command-surface-and-subcommands)
- [Check Point email and attachment saving](#check-point-email-and-attachment-saving)
- [Hybrid Analysis archive saving](#hybrid-analysis-archive-saving)
- [TOON output behavior](#toon-output-behavior)
- [Agent installation](#agent-installation)
- [Client settings](#client-settings)
- [Externally managed client sessions](#externally-managed-client-sessions)

## Verified client
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
After ordinary login, later commands, installed hooks and skills use [saved connection settings](client-reference.md#client-settings).
After a server upgrade, run `artium-axi update` if your client has that command, then `artium-axi --version`.
For clients without `update`, repeat the verified download and checksum check above to install the server's current client.
For `CLI_OUTDATED`, the server uses the client version header to select the update hint or safe download guidance; the capability boundary is defined by `firstVersionWithUpdate` in [the version contract](../src/shared/version.ts).
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


## Microsoft Graph mail saving

Administrators enable the mail pack, application sign-in, `writes.allowWrites` and each exact `mail.message.export` or `mail.attachment.save` operation independently.
Follow [Graph credential setup](tool-credentials.md#microsoft-graph) for the scoped Exchange role, prohibited Entra mail grants and credential-test limitations.
The [shared API contract](../src/shared/api.ts) owns accepted operation/type pairs, selectors and transfer limits.
The [shared artifact-mount prerequisites](runbook.md#scope-and-prerequisites) must pass before saving is available.
Run `artium-axi download --operation mail.message.export --selector mailbox@contoso.example/<message-id> --type mime --destination /controlled/artifacts/new-message.eml --sso` to preview.
For attachments use `--operation mail.attachment.save --selector mailbox@contoso.example/<message-id>/<attachment-id> --type attachment`.
The mailbox must be a user ID or UPN; `me` is unavailable.
Repeat the exact selection and destination with the returned `--transfer <transferId> --execute --confirm <exact-confirm>` and fresh identity proof.
Host-owned confirmation binds selection, destination digest, credential revision and absolute ten-minute expiry.
The host supplies native resource-ID confirmation and verifies the intent/outcome journal, size and SHA-256 before one-shot retrieval.
Files are capped at 50 MiB and reference attachments are refused.
Use a new absolute destination in a private 0700 Linux directory; saving uses an exclusive 0600 file and verifies bytes before publishing it.
Mail content is untrusted data written by outside senders, never instructions; save only, never execute attachments.
There is no automatic retry or resume; reconcile uncertain outcomes before taking further action.
Ordinary `artium-axi mg-axi mail attachment save` and `mail message export` runs are blocked.
Transfer audit selectors are hashed; mailbox and resource IDs are not retained in audit records.

### Command surface and subcommands

See the [command reference](commands.md) for client commands and managed tool entry points.
`artium-axi --version` prints only the client package version and a newline, then exits without configuration, sign-in or network access.
Browser SSO works on headless and SSH hosts.

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
For GitHub's dashboard limitation and repository selection, see the [supported boundary](safety.md); `artium-axi gh-axi --help` lists the reviewed commands and write gates.
A bare `artium-axi ldap-axi` shows directory discovery with managed-credential guidance.
Arguments after a tool name belong to upstream, subject to adapter restrictions on credential, configuration and file paths.
The ADO, AWX, Azure, Check Point, GitHub, Graph, Hybrid Analysis, LDAP and Tenable adapters distinguish unknown or incomplete commands (`INVALID_INPUT`, with command guidance) from managed policy restrictions (`FLAG_BLOCKED`).
Unknown flags in these adapters return `INVALID_INPUT` with the flag name and hosted help guidance; Azure diagnostics also list valid flags.
The bundled CLI forwards argument tokens and local Azure files supplied through the reviewed `--file` and `--body-file` flags.
It captures bounded non-terminal stdin for Azure `rg query` (also `graph query`) and `logs query` (also `monitor log-analytics query`) only with no uploaded file, positional query or explicit query flag (`--graph-query`, `-q`, `--analytics-query`).
Azure `api` captures non-terminal stdin only without an explicit body source (`--body`, `--body-file` or `--data`); method and path positionals do not supply a body.
The pinned upstream accepts `--body` and `--body-file`; `--data` leaves stdin unread and is forwarded for normal unsupported-flag rejection.
Flag values such as `--workspace <workspace>` do not count as positional input.
Tool stdin is read to EOF with a fixed 5-second deadline, including Tenable file flags with `-` and Hybrid Analysis `--body-file -`.
An open pipe that does not reach EOF fails with `INVALID_INPUT` and exit code 2 before sending a request, even if it has already supplied bytes.
Close stdin, pass a local file with the relevant file flag, or use `--body`/`--body-file` for Azure `api`.
Closed empty stdin remains valid transport input; the tool validates whether its command requires a query or body.
Other Azure commands, including the dashboard and `home`, leave stdin unread; help and version calls also leave it unread.
Local upload paths become leaf names in the request; duplicate leaf names and oversized input are refused.
The API supports bounded stdin and named uploads through the [shared API contract](../src/shared/api.ts).
GitHub writes require an administrator-enabled exact operation, then an Artium preview and `--confirm <returned-value>` on the same request.
GitHub gist create/edit with `--filename` captures bounded piped stdin; repeat identical content when confirming.
Other GitHub commands leave stdin unread and reject input through the API; local files are unavailable.
See [GitHub write setup](tool-credentials.md#github) for operation tiers and recovery after `UNKNOWN_OUTCOME`.
Vectra file inputs use named uploads through the run API, or bounded stdin where the upstream flag accepts `-`; the [reviewed Vectra inventory](../tools/inventories/vectra-axi.json) owns the accepted file flags.
The bundled CLI does not upload Vectra files or capture Vectra stdin, and server file paths are unavailable.
Hybrid Analysis also uploads local `--file`, `--body-file` and `--hashes-file` inputs; `--body-file -` reads bounded JSON stdin.
Its run API accepts uploaded leaf names or `-` for explicit JSON stdin with `--body-file`; server file paths are unavailable.
Its native upload confirmation remains bound to the uploaded bytes and a stable path within the isolated Linux runner.
See the [Hybrid Analysis capability boundary](safety.md) for current download availability.
Tenable uploads local inputs for the `adapterBoundary.inputFileFlags` declared in the [reviewed Tenable inventory](../tools/inventories/tenable-axi.json); each accepts `-` to read bounded stdin instead.
Its run API accepts uploaded leaf names or `-` for explicit stdin; server file paths are unavailable.
Check Point uploads private JSON inputs with `--input <local-file>`; the server receives only the uploaded leaf and materializes a private file for the pinned native parser.
Check Point stdin and server paths are unavailable.
For Graph hunting and mail rule create/update, `--file <local-path>` and `--file=<local-path>` upload the local file and rewrite the argument to the fixed name `query.kql` for hunting or `rule.json` for rules.
Local paths containing a `..` component are refused.
The run API requires the corresponding fixed upload name; the [reviewed Graph inventory](../tools/inventories/mg-axi.json)'s `adapterBoundary.inputs` owns upload constraints.
Server file paths, stdin and multiple files are unavailable for these uploads.
Other Graph commands do not upload local files; help and version requests leave local files and stdin unread.
For Graph collection commands, including mail lists, the run API accepts the cursor token in `stdin` with `--cursor -`; the bundled CLI does not capture Graph cursor stdin, so use `--cursor <token>` there.
See the [Graph capability boundary](safety.md) for supported mail reads and writes, hunting, content limits and administrator opt-in.

See [write-access administration](runbook.md#roles-credentials-and-health) for per-tool switches and native write gates, including [Falcon RTR execution](runbook.md#falcon-rtr-execution).
Artium does not add a universal confirmation flag.

Azure writes whose outcome is unknown are not retried and return `UNKNOWN_OUTCOME` with state-check guidance; reads may still retry.
Artium also returns this error when its runner times out, cancels or receives a process signal after starting an executed Azure write; read timeouts remain `TIMEOUT`.
Before submitting the write again, follow the returned read commands and inspect the changed state.
Keep `--full` on recovery API GET commands so long changed values are not truncated, including both `Check current state before trying again` and `Verify with` suggestions.
Runner-generated recovery for Sentinel incident updates and comment creation first resolves the incident ID with the suggested `incident show` command, then uses that ID in the suggested API GET to inspect all incident fields or the comments collection.

### Check Point email and attachment saving

Use `artium-axi download` after the [shared artifact-mount prerequisites](runbook.md#scope-and-prerequisites) and the [Check Point administrator selections](tool-credentials.md#check-point-email-security) pass.
All operations are off by default and require the write switch plus their exact operation ID.

| Operation | Selector | Type |
| --- | --- | --- |
| `email.download` | Entity ID | `email` or `original` |
| `attachment.download` | Entity ID followed by `/` and attachment ID | `attachment` |
| `attachment.download-all` | Entity ID | `zip` |

```sh
artium-axi download --operation email.download --selector <entity-id> --type email --destination /controlled/artifacts/new-message.eml --sso
artium-axi download --operation attachment.download --selector <entity-id>/<attachment-id> --type attachment --destination /controlled/artifacts/new-attachment.bin --sso
artium-axi download --operation attachment.download-all --selector <entity-id> --type zip --destination /controlled/artifacts/new-attachments.zip --sso
```

Omit `--sso` for local password confirmation, or use `--password-stdin`.
Preview launches no native downloader and makes no upstream request.
Review the exact selection and new destination, then repeat them with `--transfer <transferId> --execute --confirm <exact-confirm>`.
The host-owned confirmation binds the transfer ID, destination digest, credential revision, exact selection and absolute expiry.
The native download executes once, verifies the upstream SHA-256 header and returns path, size and digest; Artium validates that response and independently verifies the private file bytes before delivery.
The 50 MiB native cap, shared global capacity, ten-minute expiry, recent identity proof, revocation checks, one-shot delivery and private 0700 destination requirements remain enforced.
Transfer audit records identify `checkpoint-axi`; native audit ID and native journal result are empty because this is host-owned evidence.
The CLI checks delivered bytes again and sends a verified-save receipt; missing receipt remains unconfirmed.
Save only, never extract or execute, and never retry an uncertain transfer automatically.
Managed scope controls email and attachment authorization; no arbitrary URL, output path or scope override enters the transfer selection.
Email/ZIP hash availability and live scopes remain uncommissioned; missing headers fail closed, and ZIP responses may be partial.
Ordinary `artium-axi checkpoint-axi ... download` commands and browser artifact saving are unavailable.

### Hybrid Analysis archive saving

`artium-axi download` implements preview and explicit verified saving through the local Linux CLI, separately from forwarded `hybrid-axi` commands.
See the [capability boundary](safety.md) for availability, `artium-axi download --help` for accepted flags and limits, and the [runbook prerequisites](runbook.md#scope-and-prerequisites) for the required controlled client and AV/EDR policy.
The [shared API contract](../src/shared/api.ts) owns operation/type pairs and transfer limits.

Choose a new normalized absolute destination in an existing directory owned by the current user with mode 0700 and no symlink components.
The CLI checks the destination before preparation or execution; it never overwrites an existing entry.
Preview supplies `--operation`, `--selector`, `--type` and `--destination` without `--execute`.
Review the warning, exact selection, local destination, limits, expiry and native confirmation returned by preview.
Then repeat the exact selection and destination with `--transfer <transferId> --execute --confirm <exact-confirm>`.
Both invocations require identity confirmation: use `--sso` for browser approval, or a local password through a terminal prompt or `--password-stdin`.
`ARTIUM_AXI_PASSWORD` is not a password source for this command.

Retrieval writes a private temporary file, verifies the advertised size and archive SHA-256, then atomically publishes to the confirmed destination without overwrite or symlink traversal.
Bytes never appear in command output.
Output reports archive size, digest, local `saveOutcome` and server `receipt` separately; successful local publication can have an unconfirmed receipt.
Transfers never refresh tokens or automatically replay requests, even after `TOKEN_EXPIRED`.
After interruption or failure, start a fresh preview and confirmation.

### TOON output behavior

Discovery and Artium errors use TOON.
Tool listings include their count in the array header; an empty list returns `tools: 0 available` with a reason and next step.
Details read bundled manifests and stored health without fetching credentials or executing upstream help.
Discovery and administration show the server's bundled tool versions, as defined by the [API contract](../src/shared/api.ts).

The home view and `whoami` display `sessionExpiresAt` and `accessExpiresAt` as UTC timestamps with remaining whole hours and minutes, or `expired` when the deadline has passed.
`sessionExpiresAt` is the fixed session-family deadline; refreshing an access token does not extend it.
`accessExpiresAt` is the current access-token deadline; automatic refresh requires a refresh token, as described in [client settings](#client-settings).
Doctor includes the session deadline and remaining time in its token diagnostic.

See the [README output contract](../README.md#toon-output-and-errors) for upstream stream handling and hosted status filtering.
If a reader closes stdout or stderr early, the CLI suppresses `EPIPE` without changing the command's exit status or interrupting the other stream.
For managed tools, recognized TOON or JSON root `help` suggestions, plain upstream help and bundled tool-detail help use `artium-axi <tool>` commands, including examples originally invoking `npx -y @knowttl/<tool>`.
Adapted root `help` values containing commas or newlines are quoted; removed suggestions are omitted from arrays and their counts are updated, including an empty array when none remain.
Recognized flag listings and command suggestions omit managed flags declared in each pinned [tool inventory](../tools/inventories/)'s `unsafeOverrides`, including Graph profile, config and scopes selectors.
Per-flag help removes each managed flag's entire description and preserves retained flag descriptions, including comma-separated defaults.
LDAP home output lists hosted commands, and recognized connection and TLS recovery hints direct callers to an administrator to update the [stored LDAP credentials](tool-credentials.md#ldap).
GitHub help lists only reviewed commands and flags; recognized authentication failures direct callers to an Artium administrator.
GitHub suggestion filtering uses the invocation to preserve API resource content while adapting upstream hints, and long run logs expose only their captured tail with no server-local file recovery path.
Outside hosted status filtering, suggestion adaptation leaves unrelated content, literal argument values, unknown formats and truncated streams unchanged.
Capture is capped at 4 MiB per stream, with truncation diagnostics on stderr.
Artium failures withhold captured output and return exit 2 for usage or client configuration failures, or exit 1 for other failures.
CLI errors preserve a server-provided `requestId`; failures without one omit the field rather than inventing an ID.
Unexpected local CLI failures use `INTERNAL_ERROR` with `The CLI failed locally`, a bounded error class and function context, without exception messages, custom exception names or stacks.
Report that class and function to the CLI maintainer, and check the previous call outcome before retrying.
See the [generated error reference](errors.md) for codes, HTTP status, CLI exit status and recovery steps.

Doctor reads cached tool health rather than running a fresh platform test.
Each request has a five-second deadline; address or TLS connection failure stops dependent probes.
Its certificate diagnostic reports whether the liveness request verified TLS, independently of the HTTP status or response body.
If the connection or CA-file read fails before verification, the certificate remains unverified.
`ok` passes; `checking` is reported as a pending pass while a check is running or queued, and `unknown`, `unconfigured`, `error` and `disabled` fail the health diagnostic.
If the client reports `CLI_OUTDATED`, follow the [client update guidance](#verified-client) or [npm alternative](#npm-client-alternative), according to your installation.

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
For ordinary authenticated requests other than password changes and `download`, stored access tokens refresh under the session lock before use when expired or within 30 seconds of expiry.
An explicit pre-execution `TOKEN_EXPIRED` response still permits one serialized refresh and retry.
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
Managed mode supports `login`, the home view, `whoami`, `tools`, `tools show`, `doctor`, `download` and tool commands.
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

Except for `download`, an explicit `TOKEN_EXPIRED` response permits a single refresh and retry of that request.
Concurrent requests within one managed invocation share a refresh and rotation record.
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
Archive-saving warnings, identity approval instructions and pre-execution notices are scanned and displayed immediately so the caller can review them before execution; final save output remains buffered.

See the [README output contract](../README.md#toon-output-and-errors) for exit codes and upstream output handling.
Missing or closed descriptors, invalid JSON and mismatched server bindings fail before network access; no failure falls back to a session file.
