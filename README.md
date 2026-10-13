<h1 align="center">artium-axi</h1>

<p align="center">
  <img alt="Status" src="https://img.shields.io/badge/status-under%20construction-orange?style=flat-square" />
  <img alt="Verified platform" src="https://img.shields.io/badge/verified%20platform-Linux-blue?style=flat-square" />
  <a href="https://github.com/kunchenguid/axi"><img alt="AXI" src="https://img.shields.io/badge/AXI-Agent%20eXperience%20Interface-green?style=flat-square" /></a>
</p>

Managed command-line tools for agents, behind one local sign-in.

artium-axi packages a server and CLI that give users role-based access to pinned upstream tools.
Administrators manage local accounts, roles, encrypted service credentials and audit records through a browser.
The client follows AXI (Agent eXperience Interface) conventions for discovery, help and structured errors.

**Status: under construction.**
Falcon, Vectra and Azure are wired into the production server entry point.
Graph has local fake-service evidence but is not registered there; live authentication, permissions and deployment remain unverified.
See the [evidence ledger](docs/evidence-ledger.md) for the acceptance boundaries.

## Agent Ergonomics

- Running without arguments shows identity, roles, available tools, cached health and pinned versions.
- Tool lists use a compact `name`, `status`, `version` schema and suggest a detail view and first call.
- Empty lists explain why no enabled tool is available and direct you to an administrator.
- Local help works before sign-in and includes usage, purpose, flags and an example.
- Artium errors use TOON on stdout; upstream calls preserve separate stdout, stderr and exit status.
- Embedded skills support Claude Code, Codex and OpenCode, with an optional Claude Code session hook.

## Quick Start

Use an existing Artium server and a local account supplied by its administrator.
For server provisioning, start with the [operations runbook](docs/runbook.md).
The Linux client requires Node **22.12 or later**, curl and sha256sum on `PATH`.
Windows and macOS execution, token storage and actual agent host loading remain unverified.

### Download and first call

Set the trusted HTTPS server URL before downloading:

```sh
export ARTIUM_AXI_URL='https://artium.example.com'
```

For a private CA, set `ARTIUM_AXI_CA_FILE` to its readable PEM file and add `--cacert "$ARTIUM_AXI_CA_FILE"` to **both** curl commands below.
Keep certificate verification enabled.
The bundle and checksum must come from the trusted server; the checksum detects corruption and mixed releases, not an untrusted server.

```sh
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

**Stop if either download or checksum verification fails.**
Do not launch the downloaded file after a failure.
The executable is a standalone Node bundle; it needs no npm install or sibling assets.

Sign in using the hidden terminal password prompt, replacing the synthetic username with your account:

```sh
artium-axi login --username synthetic-user
```

If login reports `PASSWORD_CHANGE_REQUIRED`, change the temporary password and sign in again:

```sh
artium-axi passwd
artium-axi login --username synthetic-user
```

Discover the tools granted to your account:

```sh
artium-axi
artium-axi tools
artium-axi tools show falcon-axi
artium-axi falcon-axi detection list
```

The Falcon example requires an enabled Falcon tool and a role granting access to it.
Choose your first call from the example shown for an available tool.

### Skill installation

Install the embedded skill after downloading the client:

```sh
artium-axi setup --host claude --hook
```

Use `--host codex` or `--host opencode` without `--hook` for those hosts.
Setup always installs the skill; only Claude Code supports the optional `SessionStart` hook, which runs `tools` to supply session context.
Unsupported hosts or hooks are refused before files are written.

Setup preserves unrelated settings and hooks and leaves unchanged managed files alone.
It refuses to replace an edited or unmanaged skill unless `--force` is explicit.
Keep the bundle at its installed path; rerun setup if it moves so recorded invocations are repaired.
Actual host loading and hook usefulness require separate acceptance.

## Other ways to install

### Build from source

The source toolchain requires Node **22.12 or later** and **pnpm 10.22.0**.
From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
node dist/cli/artium-axi.mjs --help
node dist/cli/artium-axi.mjs setup --host codex
```

The build produces the standalone `dist/cli/artium-axi.mjs`.
Set `ARTIUM_AXI_URL` and use the same login and discovery commands with `node dist/cli/artium-axi.mjs` in place of `artium-axi`.
The root package is private; server downloads and source builds are the installation paths described here.

## Usage

### Command surface and subcommands

| Command | Purpose |
| --- | --- |
| `artium-axi` | Show identity, roles and available tools. |
| `artium-axi login --username synthetic-user` | Sign in with a local account. |
| `artium-axi passwd` | Change your password, then sign in again. |
| `artium-axi whoami` | Show identity, roles, access expiry and server URL. |
| `artium-axi tools` | List enabled runtime tools granted through your roles. |
| `artium-axi tools show falcon-axi` | Show cached status, vetted pinned help and a first-call example. |
| `artium-axi doctor` | Check server address, certificate, token, CLI version and cached tool health. |
| `artium-axi logout` | Remove local tokens and attempt server-session revocation. |
| `artium-axi setup --host claude --hook` | Install the embedded skill and optional Claude Code hook. |
| `artium-axi falcon-axi detection list` | Run a Falcon read through the managed adapter. |
| `artium-axi vectra-axi detection list` | Run a Vectra read through the managed adapter. |

Add `--help` to a local command to inspect its accepted flags.
Tool help has two boundaries:

```sh
artium-axi --help falcon-axi
artium-axi falcon-axi --help
```

The first prints local Artium help without signing in or contacting the server.
The second forwards `--help` through the authenticated upstream adapter.
A bare Falcon or Vectra invocation shows upstream help; `artium-axi az-axi` and `artium-axi az-axi home` run the Azure dashboard with ARM authentication.
Arguments after a tool name belong to upstream, subject to adapter restrictions on credential, configuration and file paths.
The bundled CLI forwards argument tokens; the API additionally supports bounded stdin and named uploads through the [shared API contract](src/shared/api.ts).

Write permission remains subject to the pinned tool's native gates and the configured adapter policy.
Vectra writes require its configured allowlist and upstream confirmation; Artium does not add a universal confirmation flag.
Falcon has no editable native write settings.

Azure writes whose outcome is unknown are not retried and return `UNKNOWN_OUTCOME` with state-check guidance; reads may still retry.
Artium also returns this error when its runner times out, cancels or receives a process signal after starting an executed Azure write; read timeouts remain `TIMEOUT`.
Before submitting the write again, follow the returned read commands and inspect the changed state.
Keep `--full` on recovery API GET commands so long changed values are not truncated, including both `Check current state before trying again` and `Verify with` suggestions.
Runner-generated recovery for Sentinel incident updates and comment creation first resolves the incident ID with the suggested `incident show` command, then uses that ID in the suggested API GET to inspect all incident fields or the comments collection.

### TOON output behavior

Discovery and Artium errors use TOON.
Tool listings include their count in the array header; an empty list returns `tools: 0 available` with a reason and next step.
Details read bundled manifests and stored health without fetching credentials or executing upstream help.

Upstream calls preserve stdout, stderr and nonzero exit codes.
Recognized TOON or JSON root `help` suggestions are prefixed with `artium-axi` for the invoked tool; unrelated content, unknown formats and truncated streams remain unchanged.
Azure plain leaf help and embedded help also use hosted command examples and omit server-owned config, profile and tenant selectors.
Capture is capped at 4 MiB per stream, with truncation diagnostics on stderr.
Artium failures withhold captured output and return exit 2 for usage or client configuration failures, or exit 1 for other failures.
See the [generated error reference](docs/errors.md) for codes, HTTP status, CLI exit status and recovery steps.

Doctor reads cached tool health rather than running a fresh platform test.
Only `ok` passes; `unknown`, `unconfigured` and `error` require investigation.
If the client reports `CLI_OUTDATED`, download the current bundle and checksum from the server again.

### Browser administration

Open `/login` through the trusted HTTPS proxy.
Temporary passwords open `/password` and require a new login after changing them.
Administrators land on `/admin`; ordinary users land on `/account` for password change and sign-out.

| Screen | Purpose |
| --- | --- |
| `/admin` | Create users, change roles, enable or disable accounts, unlock accounts and reset temporary passwords. |
| `/admin/tools` | Review pinned versions and cached health; enable supported tools and edit native settings. |
| `/admin/credentials` | Replace credentials and run a fixed harmless credential test. |
| `/admin/roles` | Create or rename roles and replace their tool grants. |
| `/admin/audit` | Filter and page through authentication, administration and tool-call records. |

Administrator capability is separate from tool grants.
Role changes apply on the next call, including calls using existing tokens.
The last enabled administrator cannot be disabled or demoted.
Mutations use revision checks and audit commits; reload stale forms rather than overwriting newer changes.
After 15 minutes without password confirmation, administration mutations require reauthentication.

Credential editors start blank and never return stored values.
Vectra and Graph use schema-generated fields and validation from their published [AXI credential standard](docs/credential-standard.md) profile schemas.
Falcon uses the same editor when its pinned package ships that schema.
Enter secret values themselves, not SecretRefs; leave unused fields blank and enter object or array fields as JSON.
For Vectra, `origin` must be a canonical HTTPS origin, without a path, credentials or an explicit default port.
Enter PEM contents in `caBundle`, not a server file path; Artium writes a private CA file for each call.
The form exposes the schema's full requirements, including conditional requirements for the chosen authentication kind.
Azure retains its source-identity JSON editor because the host brokers resource tokens separately.
See the [hosted contract](docs/credential-standard.md#9-hosted-contract-artium-axi) for profile injection.
Pinned tools awaiting migration retain their current credential editor and injection path.
Replacements must include every native setting to retain: omitted settings are cleared.
Native settings also replace the entire object; `{}` clears it.
Credential changes clear cached health, and background checks run every 15 minutes for enabled configured tools.
Use **Test credential** for a current fixed read before enabling a configured Falcon, Vectra or Azure tool.
Graph remains unavailable in the production runtime.

### Audit screen and API

Audit supports user, tool, exact outcome and inclusive UTC From/To filters.
Records contain actor, UTC time, event, outcome, request ID, redacted arguments and safe execution metadata.
Pagination retains filters; starting a new search includes records inserted after the previous search began.

`GET /v1/admin/audit` exposes the same records with `user`, `tool`, `outcome`, `from`, `to`, `limit` and `cursor` parameters.
Pages default to 50 records and accept 1 to 100; pass `nextCursor` with the same filters until it is null.
Browser reads require administrator capability; bearer reads also require a session-bound recent-reauthentication ticket.
There is no audit mutation or deletion route.
See the [API contract](src/shared/api.ts) and [retention and export runbook](docs/runbook.md#retention-and-export).

## Configuration

### Client settings

| Variable | Meaning |
| --- | --- |
| `ARTIUM_AXI_URL` | Required HTTPS base URL without credentials, query or fragment. |
| `ARTIUM_AXI_CA_FILE` | Optional readable PEM CA file added to Node's certificate trust. |
| `ARTIUM_AXI_PASSWORD` | Login password source when `--password-stdin` is absent, before the terminal prompt. |
| `ARTIUM_AXI_CURRENT_PASSWORD` | Current password for an ordinary password change, before the terminal prompt. |
| `XDG_CONFIG_HOME` | Session-file base on Linux/macOS; otherwise `~/.config`. |
| `APPDATA` | Session-file base on Windows, whose execution remains unverified. |
| `ARTIUM_AXI_TEST_HTTP` | `1` permits loopback HTTP for tests only. |

Use `login --password-stdin` or `passwd --password-stdin` to supply the login or new password through stdin.
Stdin removes one final LF or CRLF and preserves all other spaces and Unicode.
Password arguments are refused; tokens are never printed.
Ordinary password changes also require the current password through the terminal prompt or `ARTIUM_AXI_CURRENT_PASSWORD`.
Clear password environment values after use.

Sessions live in `artium-axi/session.json` under the applicable base directory and are bound to the normalized server URL.
POSIX directories use mode 0700 and files mode 0600; Windows uses a restricted ACL and refuses storage if it cannot establish it.
Do not export or share the session file.
CLI processes serialize refreshes through `session.lock`; after `SESSION_BUSY`, remove that lock directory only when every CLI process has exited.
Concurrent login or logout can produce `SESSION_CHANGED`; check the current session before repeating a command.
Logout removes local tokens even if remote revocation fails, reporting `remoteRevocation: unverified` in that case.

Certificate verification remains enforced even with `NODE_TLS_REJECT_UNAUTHORIZED=0`, and authenticated redirects are refused.
Only an explicit pre-execution `TOKEN_EXPIRED` response permits one serialized refresh and retry.
A network failure or uncertain command outcome is never retried automatically.

### Server settings and custody

| Variable | Meaning |
| --- | --- |
| `ARTIUM_AXI_DATABASE_FILE` | SQLite database path; default `/data/artium.db`. |
| `ARTIUM_AXI_MASTER_KEY_FILE` | Initial or explicit master-key file containing exactly 32 raw bytes; takes precedence over other key sources. |
| `ARTIUM_AXI_MASTER_KEY` | Alternative canonical base64 encoding of exactly 32 key bytes. |
| `ARTIUM_AXI_ADMIN_USERNAME` | First-start local administrator username. |
| `ARTIUM_AXI_ADMIN_PASSWORD_FILE` | UTF-8 file containing the exact first-start password, without an added newline. |
| `ARTIUM_AXI_TRUSTED_PROXIES` | Comma-separated verified proxy source IP addresses; default trusts none. |
| `ARTIUM_AXI_AUDIT_STDOUT` | `1` streams committed audit records as JSON lines; SQLite remains authoritative. |

The server listens on HTTP port 8080 behind a trusted HTTPS reverse proxy.
The [Compose example](compose.example.yaml) publishes only on host loopback and supplies a master-key secret, not bootstrap credentials.
Follow the [first-administrator runbook](docs/runbook.md#first-administrator-and-offline-recovery) before starting a new store.
All tools start disabled until configured.
The proxy must replace incoming forwarding headers, and clients must not reach the HTTP listener directly.
Public `/health/live` checks liveness; `/health/ready` checks local migration-table access, not upstream services.

Startup validates the store's key binding and every encrypted credential before listening.
It saves the plaintext master key as canonical base64 in an owner-only `.env` beside the database, even when the key came from a mounted file.
**The data volume therefore contains both the encrypted database and its decryption key.**
Protect the whole volume and keep key escrow separate from database backups.
With no explicit key source, later starts and maintenance commands read the saved key; no key is generated or uploaded.
Invalid or mismatched keys fail startup.
See [backup, restore, rotation and rollback](docs/runbook.md#backup-restore-and-upgrade-rollback) for matching-key recovery, backup retention and unresolved owner custody choices.

### Security and acceptance boundaries

Development and verification use only fakes, synthetic identities and canary credentials.
Fake-service results do not establish live platform permissions or production readiness.
Never put tokens or keys in arguments, source files, images or logs.
The server refuses the removed development-authentication settings `ARTIUM_AXI_DEV` and `ARTIUM_AXI_DEV_TOKEN_FILE`.

Local passwords use Argon2id, require 15 to 128 code points and at most 512 UTF-8 bytes, preserve spaces and Unicode, and reject exact matches in the bundled common-password list.
Access tokens last one hour within a 12-hour family; refresh-token reuse revokes the family.
Password changes revoke existing CLI tokens and browser sessions.
Sign-in limits and persistent account lockout are enforced by the [authentication implementation](src/server/auth/local.ts) and [configured defaults](src/server/config.ts).
Browser sessions use Secure, HttpOnly, SameSite=Strict cookies and expire after 30 minutes idle or 12 hours overall; temporary-password sessions last 10 minutes.
Browser mutations require same-origin requests and CSRF tokens.

Credentials are encrypted with AES-256-GCM and retrieved only after authorization and audited admission.
Version 1 uses one shared service credential per tool; external secret sources and per-user credentials remain deferred.
Audit excludes injected credentials, request bodies, stdin, uploaded contents and output streams.
Failure to persist admission prevents execution; failure to persist the terminal event withholds the result.
Audit retention is 90 days, with startup recovery recording interrupted calls without replay.
Vectra's durable native write logs complement Artium audit and retain intent/outcome pairs.

The runner uses argument arrays without a shell, a restricted child environment, private per-call directories and bounded concurrency, runtime and output.
Known injected secrets are scanned in raw, JSON-escaped, base64, base64url and URL-encoded output, including beyond capture limits; a match discards both streams.
Exact-value scanning cannot identify unknown tokens minted upstream.
Heap and address-space limits are not complete process isolation: descendants starting a new session escape the runner's process group.
See [runner verification and limitations](docs/verification-s09-10.md) and [secret-scanner evidence](docs/verification-s07.md).

## Development & Testing

Use Linux with Node **22.12 or later**, **pnpm 10.22.0**, OpenSSL, Python 3, curl and sha256sum.
Container acceptance additionally requires Docker and the BuildKit prerequisites described in the [container evidence](docs/verification-s20-21.md).

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:containers
```

`pnpm check` verifies generated error-reference freshness, strict type checking, parser/schema inventory freshness, the Vitest suite, compilation and the AXI/distribution checklist.
The checklist exercises a fresh Linux download, checksum, setup, login, temporary-password change and first call against a local HTTPS fake.
It refuses unverified host platforms.

| Command | Scope |
| --- | --- |
| `pnpm lint` | Static TypeScript checking. |
| `pnpm test` | Inventory/schema freshness checks and the full Vitest suite. |
| `pnpm build` | Server compilation and standalone client bundle. |
| `pnpm test:security` | Tests whose names contain `security`. |
| `pnpm test:containers` | Mandatory fake-only runner, walking-skeleton, Graph headless and fake-service container acceptance. |
| `pnpm test:containers --measure-cache` | The container block plus an identical-input warm runner build measurement. |
| `pnpm errors:generate` | Regenerate the error reference after changing the catalogue. |

The container block builds before probing, emits head/input/output evidence and timings, and removes its uniquely owned test images and private BuildKit cache.
Do not touch shared Docker resources or use real service credentials.
Changed relevant inputs invalidate earlier container evidence.
Upstream pins and integrity records live in [tools/package.json](tools/package.json), [tools/integrity.json](tools/integrity.json) and [tools/falcon-source.json](tools/falcon-source.json).
The root install runs the frozen upstream install; native build approval is limited to argon2, better-sqlite3 and esbuild, with upstream build scripts disabled.

### Private hygiene check

Before publishing a candidate, commit and build it, then set `ARTIUM_AXI_HYGIENE_DENY_LIST_FILE` to an absolute path to the private deny list **outside the checkout** and run:

```sh
pnpm hygiene:check
```

The UTF-8 list contains one literal term per line, matched case-insensitively after trimming whitespace; blanks and duplicates are ignored.
Unset, unreadable, empty or in-tree lists fail.
Never copy real terms or the list into this repository.
Record only its revision or SHA-256, candidate commit and pass/fail result.

The check scans tracked, untracked and ignored files, generated output and every commit message reachable from `HEAD`, excluding only `.git` metadata and installed `node_modules` directories.
Supply intended release assets outside the checkout as additional `pnpm hygiene:check` arguments, keeping the list outside those directories too.
Symlinks, unreadable files and BOM-marked UTF-16/UTF-32 assets fail rather than reducing coverage; convert unsupported encodings to UTF-8.
Diagnostics report location and normalized entry number without secret excerpts, and redact labels whose paths match a term.
The scan cannot guarantee absence of unknown sensitive values and does not approve publication.

Further operational guidance lives in the [runbook](docs/runbook.md); local implementation and deferred live acceptance are tracked in the [evidence ledger](docs/evidence-ledger.md).
