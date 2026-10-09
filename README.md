# artium-axi

artium-axi is one container that fronts several agent-ergonomic command-line tools behind a single login.
It adds role-based access to those tools and a command-line client that follows the AXI design principles.

Status: under construction.
The API supports local sign-in, password change, refresh rotation, logout, rate limits, account lockout and bearer password reauthentication.
User administration supports paginated listing, creation, account edits, unlock and temporary password reset with atomic audit and revision checks.
Tool administration supports fixed native settings, encrypted credential replacement and audited manual health tests with the same local login and reauthentication requirements.
Administrators can browse and filter records through the [Audit screen and API](#audit-screen-and-api).
The bundled CLI supports local login, password change, identity, logout, serialized session refresh, home/tool discovery, consistent help, `doctor` diagnostics and agent setup.
Browser sign-in, sign-out, password change and password confirmation use server-rendered forms and server-side sessions.

The development scaffold requires Node 22.12 or later and pnpm 10.22.0, pinned in `package.json`.
The local HTTPS tests also require OpenSSL on `PATH` to create ephemeral test certificates.
On POSIX, the CLI terminal-input tests require `python3` on `PATH` for their pseudo-terminal driver.
Run `pnpm install --frozen-lockfile`, then `pnpm check` for generated error-reference freshness, strict type checking, the Vitest suite, TypeScript compilation into `dist/` and the AXI/distribution checklist.
`pnpm lint` performs only static checking, `pnpm test` runs the full suite, and `pnpm build` compiles the scaffold.
See [test-speed verification](docs/verification-test-speed.md) for the controlled-clock stalled-request checks and file-parallelism profiling.
Compilation is reused only for the same head, Node version, source/toolchain input digest and intact compiled-output digest.
Run `pnpm test:containers` for the full fake-only container acceptance block after `pnpm check`.
It completes compilation before probes, runs the runner resource checks, walking skeleton and both fake-service modes, and removes its unique `artium-test-*` images and private tmpfs BuildKit cache.
The task-owned worker uses two CPUs, a 4 GiB memory bound and an executable 3 GiB tmpfs cache with overlayfs, retaining layers across the block's image builds until final cleanup.
Image builds verify the task worker's root and ownership token and remove each exported temporary archive; the block owns worker/cache cleanup.
Standalone image builds instead create and remove their own private worker/cache and exported archive without touching the shared Docker builder.
The block emits head/input/output evidence and individual image-build timings.
Use `pnpm test:containers --measure-cache` to additionally measure an identical-input warm runner build with the same resource probes.
Keep this output with candidate verification evidence; changed relevant inputs invalidate earlier container results.
The executable toolchain tests compile synthetic TypeScript and run its emitted ESM with Node, and verify strict null checking rejects an invalid assignment.
`pnpm test:security` selects tests whose names contain `security`.
It includes the synthetic hygiene checker and streaming secret-scanner tests.

`src/shared/` owns the run schemas and error catalogue, `src/server/` contains the runner, Falcon, Vectra and internal Azure adapters and encrypted credential store, and `src/cli/` contains the bundled client and its discovery views.
`test/` holds scaffold, hygiene and synthetic upstream tests.
The pinned container, development server, bundled CLI and Falcon and Vectra adapters are available, while the remaining adapters arrive in later slices.
See [`.no-mistakes.yaml`](.no-mistakes.yaml) for the configured pipeline commands.
All application validation will use fakes and synthetic data, with live acceptance deferred.

`pnpm build` produces the standalone `dist/cli/artium-axi.mjs`, requiring Node 22.12 or later and no sibling files or `node_modules`.
Set `ARTIUM_AXI_URL` to the server's HTTPS base URL.
Sign in with `node dist/cli/artium-axi.mjs login --username <username> --password-stdin`, piping the password into stdin.
Without `--password-stdin`, login reads `ARTIUM_AXI_PASSWORD`, then uses a hidden prompt at a terminal.
Password arguments are refused and tokens are never printed.
Stdin removes one final LF or CRLF, preserving all other spaces and Unicode.
The client no longer reads `ARTIUM_AXI_DEV_TOKEN_FILE`.

After sign-in, run `node dist/cli/artium-axi.mjs` to see your user, roles, available tools, cached status, pinned versions and next commands.
Use `node dist/cli/artium-axi.mjs tools` for the counted list, `node dist/cli/artium-axi.mjs tools show falcon-axi` for vetted pinned help and an adapter-compatible example, and `node dist/cli/artium-axi.mjs whoami` for identity, roles, server and access expiry.
An empty tool list explains that no enabled runtime tool is available through your assigned roles and asks an administrator to check grants and enabled tools.
Tool details read the bundled manifest and stored server status without retrieving credentials or running upstream help.
Artium commands support `--help` with usage, purpose, flags and one example, including before sign-in.
Use `node dist/cli/artium-axi.mjs --help falcon-axi` for Artium's local tool help without signing in or contacting the server.
Arguments after a tool name belong to upstream, so `node dist/cli/artium-axi.mjs falcon-axi --help` and a bare tool invocation use the authenticated adapter boundary.

The [generated error reference](docs/errors.md) records every catalogue code, source, HTTP status, CLI exit code and next step.
Artium errors withhold captured output and use TOON on stdout, with exit 2 for usage or client configuration failures and exit 1 for other failures.
Completed upstream calls return separate stdout and stderr streams and preserve the upstream exit code, including nonzero exits, with the upstream tool as the HTTP envelope source.
The CLI prefixes commands for the invoked tool with `artium-axi` only within the recorded root `help` suggestion field in recognised TOON or JSON output.
Rewriting is idempotent and preserves every unrelated byte, including quoting, escaping and line endings.
Unknown formats, unsupported suggestion shapes and truncated streams remain unchanged; each stream is handled independently.
See [S44 verification](docs/verification-s44.md) for synthetic captures and bundled stream checks.
Truncation diagnostics precede upstream stderr while stdout remains parseable.
Regenerate the reference with `pnpm errors:generate` after changing [the catalogue](src/shared/errors.ts).
See [S43 verification](docs/verification-s43.md) for First call, No access, help, error mapping and freshness evidence.
It stores tokens bound to the normalized server URL in `artium-axi/session.json` under `%APPDATA%` on Windows, `$XDG_CONFIG_HOME` when set on Linux/macOS, or `~/.config` otherwise.
POSIX directories use mode 0700 and files mode 0600.
Windows storage uses PowerShell to restrict the ACL to the current user, SYSTEM and local administrators before writing tokens, and fails if the ACL cannot be established.
File replacement is atomic.
Each stored session includes a UUID `loginGeneration`, replaced on every login and preserved during refresh.
Files from earlier builds without this field require a new login.
Session reloads during authenticated requests and password changes stop with `SESSION_CHANGED` if a concurrent login or logout replaces their originating session.
Local CLI processes serialize refreshes through `session.lock`, reload the session after acquiring it and reuse a rotation completed by another process.
If a process dies holding the lock, the next command reports `SESSION_BUSY` after 100 seconds.
Remove that directory only after all CLI processes have exited.
Changing `ARTIUM_AXI_URL` never sends the previous server's stored tokens to the new URL.
`logout` removes local tokens even when remote revocation fails and prints `remoteRevocation: unverified` in that case.
For a temporary password, login stores only the restricted password-change token and reports `PASSWORD_CHANGE_REQUIRED`.
Run `passwd --password-stdin` with the new password, then log in again before using tools.
An ordinary `passwd` also reads the current password from `ARTIUM_AXI_CURRENT_PASSWORD` or a hidden terminal prompt.
New passwords use stdin or the terminal prompt.
`whoami` prints the current identity, roles, access expiry and server URL through `GET /v1/me`.
The URL cannot contain credentials, a query or a fragment.
The client uses Node's certificate trust, optionally extended with `ARTIUM_AXI_CA_FILE`; certificate verification remains enforced even with `NODE_TLS_REJECT_UNAUTHORIZED=0`.
Authenticated redirects are refused.
Only an explicit pre-execution `TOKEN_EXPIRED` response permits one serialized refresh and one retry.
A network failure or uncertain command outcome is never retried.
Only loopback HTTP test traffic may opt in with `ARTIUM_AXI_TEST_HTTP=1`.
Run `node dist/cli/artium-axi.mjs tools` or `node dist/cli/artium-axi.mjs falcon-axi detection list`.
For the advertised command, use the standalone launcher installation below.
The client preserves argument tokens; output and error handling follow the [generated error reference](docs/errors.md) and CLI guidance above.
The server serves the current bundle at `/cli/artium-axi.mjs` and its SHA-256 file at `/cli/artium-axi.mjs.sha256`, without authentication or CLI version gating.
The download carries `X-Artium-Cli-Version`, `X-Artium-Cli-Sha256`, a JavaScript content type and an attachment filename.
The checksum covers the exact downloaded bytes.

### Download and first call

Linux requires Node 22.12 or later on `PATH`, curl and sha256sum.
Set `ARTIUM_AXI_URL` to your HTTPS server URL and configure your certificate trust before downloading.
For a private CA, give curl `--cacert /absolute/path/to/ca.crt` on both downloads and set `ARTIUM_AXI_CA_FILE` to that CA file for the CLI.
The HTTPS endpoint and checksum must come from the trusted server; the checksum detects corruption and mismatched releases.

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
artium-axi setup --host claude --hook
artium-axi login --username <username> --password-stdin
# Supply the temporary password on stdin. If PASSWORD_CHANGE_REQUIRED is returned:
artium-axi passwd --password-stdin
# Supply the new password on stdin, then sign in again with it:
artium-axi login --username <username> --password-stdin
artium-axi tools
artium-axi tools show falcon-axi
artium-axi falcon-axi detection list
```

Stop if either download or checksum verification fails; do not launch the downloaded file.
Choose `--host codex` or `--host opencode` for their skill installation, without `--hook`.
Choose a first call from your available tools and its displayed example.
The executable is the bundle itself with a Node shebang, so launch and setup need no npm install or sibling assets.
Keep it at the installed path; if it moves, rerun setup to repair its recorded invocation.

PowerShell download and launcher example, requiring Node 22.12 or later on `PATH`:

```powershell
Invoke-WebRequest "$env:ARTIUM_AXI_URL/cli/artium-axi.mjs" -OutFile artium-axi.mjs
Invoke-WebRequest "$env:ARTIUM_AXI_URL/cli/artium-axi.mjs.sha256" -OutFile artium-axi.mjs.sha256
$expected = ((Get-Content artium-axi.mjs.sha256 -Raw).Trim() -split '\s+')[0]
$actual = (Get-FileHash artium-axi.mjs -Algorithm SHA256).Hash.ToLowerInvariant()
if ($expected -notmatch '^[a-f0-9]{64}$' -or $actual -ne $expected) { throw 'CLI checksum mismatch; do not launch' }
$env:ARTIUM_AXI_BUNDLE = (Resolve-Path artium-axi.mjs).Path
function artium-axi { & node $env:ARTIUM_AXI_BUNDLE @args }
artium-axi setup --host codex
```

The PowerShell function is for the current shell; a persistent launcher must retain the absolute bundle path.
Windows and macOS execution remain unverified, including token storage and actual agent host loading.
This Linux acceptance does not certify them.
Unknown setup hosts are refused with the supported host list, and unsupported hooks explain the limitation before writing any files.
Do not adapt a host by guessing its configuration path or hook schema; verify its current documentation first.
See [S46 verification](docs/verification-s46.md) for the executable checklist, clean Linux image journey and human review boundary.
Run `node /absolute/path/to/artium-axi.mjs setup --host <claude|codex|opencode>` to install the embedded [artium-axi skill](skill/artium-axi/SKILL.md) without npm or sibling source files.
The skill directs agents to discover their granted tools first and records the current Node/bundle invocation for sessions where `artium-axi` is absent from PATH.
For Claude Code, add `--hook` to install a `SessionStart` hook that runs `tools` and provides its output as session context.
Setup always installs the skill; the hook is optional.
Setup merges settings through an atomic file replacement, preserves unrelated settings and hooks, and repeats without rewriting unchanged files.
It repairs managed paths when the bundle moves, but refuses to replace an edited or unmanaged skill unless `--force` is explicit.
Codex and OpenCode support skill installation; requesting their hooks fails with a clear explanation and writes no files.
See [S45 verification](docs/verification-s45.md) for the verified host paths, hook schema and isolated checks.
See [S36+S37 verification](docs/verification-s36-37.md) for Linux process and storage evidence and deferred Windows/macOS acceptance.

Run `pnpm test:walking-skeleton` for mandatory fake-only container-to-CLI acceptance.
See [S20+S21 verification](docs/verification-s20-21.md) for the harness, resource cleanup and deferred captain checks.
The same harness now exercises pinned Vectra reads, native write gates and durable logs through the production server entry point.
See [S22+S23 verification](docs/verification-s22-23.md) for Vectra acceptance and output-redaction limits.

Azure secret and certificate token minting, the resource token cache and the [Azure adapter](src/server/adapters/az.ts) are implemented internally.
Azure commands remain unavailable through the runtime registry because pinned az-axi 0.1.4 retries ambiguous writes.
See [S24 verification](docs/verification-s24.md) for authentication, [S25 verification](docs/verification-s25.md) for caching and [S26 verification](docs/verification-s26.md) for profile preparation, inputs, native gates and six fixed-origin fake reads.
Live authentication, scope forms, reads and permission acceptance remain captain checks.

Before publishing any candidate, set `ARTIUM_AXI_HYGIENE_DENY_LIST_FILE` to an absolute path to the private deny list outside the checkout, then run `pnpm hygiene:check` from the candidate repository root after committing and building.
The UTF-8 list contains one literal term per line, matched case-insensitively after trimming surrounding whitespace, with blank lines and duplicate terms ignored.
An unset, unreadable, empty or in-tree list fails the check.
Never copy real terms or the private list into this repository.
Record only its revision or SHA-256 alongside the candidate commit and pass/fail result.

The checker scans the whole current tree, including tracked, untracked and ignored files, generated narrative, build logs, bundles and source maps.
Only `.git` metadata and installed `node_modules` directories are excluded.
It also scans all commit messages reachable from `HEAD`.
Pass any intended assets outside the checkout explicitly, for example `pnpm hygiene:check /path/to/release-assets /path/to/build.log`.
Symlinks and unreadable files fail rather than silently reducing coverage.
BOM-marked UTF-16 and UTF-32 candidate files and supplied assets fail with an unsupported-encoding error; convert them to UTF-8 before checking.
Keep the deny list outside every supplied asset directory too.
Matches report the file or commit, one-based line and column, and entry number in the normalized, deduplicated list, without excerpts or term values.
A diagnostic label containing a matching path term is replaced entirely with `[redacted]`.
Synthetic tests prove checker behaviour, while the real private scan supplies candidate hygiene evidence.
The check cannot guarantee absence of unknown sensitive values and does not approve publication.

See [the evidence ledger](docs/evidence-ledger.md) for local implementation, pinned-upstream fake-service evidence and the deferred captain live acceptance gates.
No live gate is satisfied by a fake-service result.

The upstream Node packages are pinned separately in [`tools/package.json`](tools/package.json) and `tools/pnpm-lock.yaml`.
The root install runs their frozen installation.
Root native build approval is limited to `argon2`, `better-sqlite3` and `esbuild` in `package.json`, while upstream tool build scripts remain disabled.
[`tools/integrity.json`](tools/integrity.json) records the pinned upstream versions and npm SHA-512 values.
mg-axi is inventoried for phase 8, with no production adapter enabled.
`pnpm test` checks the generated parser inventories against the installed catalogues before running Vitest.
Regenerate them with `node scripts/upstream-inventory.mjs --write` when deliberately changing a pin.
These inventories record provisional flag dispositions, route-specific aliases, accepted short flags, positional inputs, native environment defaults, profile-selected credential variables, native profile write settings and suggestion fields, not a production allow-list.
Native write-setting records include hashes of the pinned configuration and permission-gate sources.
The [Azure inventory](tools/inventories/az-axi.json) also owns reviewed route resource requirements and their pinned source hashes; [S25 verification](docs/verification-s25.md) describes conditional resource selection.
Its adapter boundary classifies every global flag and `AZ_AXI_*` variable, records reviewed input transports and hashes the pinned parser sources.
The native write gates remain upstream-owned.

The [Vectra adapter](src/server/adapters/vectra.ts) accepts QUX v2.5 token or OAuth credentials and RUX v3.4 OAuth credentials.
Each record contains `kind`, `apiVersion`, HTTPS `origin`, `auth`, and either `token` or `clientId` plus `clientSecret`.
Optional fields are PEM `caBundle`, QUX `applianceRelease`, and the native `writes: { allowWrites, operations }` policy.
Artium carries the validated write policy into its generated profile and never sets `VECTRA_AXI_READ_ONLY`.
The runner creates the profile and CA beside each other with mode 0600, sets `VECTRA_AXI_CONFIG`, injects the referenced secret variable, and removes the private call directory on completion.
Caller config/profile overrides and local setup commands are blocked before credential retrieval.
Reviewed `--tags-file`, `--ids-file` and `--note-file` inputs accept uploaded names or the upstream stdin marker `-`, rather than server paths.
The development server stores native Vectra JSONL write logs under `tool-logs/vectra-axi/writes.log` beside its database, normally `/data/tool-logs/vectra-axi/writes.log`.
These mode 0600 logs survive call cleanup and use the pinned tool's exclusive lock for daily 90-day retention, preserving intent/outcome pairs and their native format.
Before accepting runs, startup removes abandoned lock and retention files and runs native-log maintenance.
The [startup recovery contract](src/server/adapters/native-log.ts) requires exclusive server ownership of the journal; the supported Docker restart leaves no prior child writers running.
Malformed journals remain untouched and emit a safe `AUDIT_UNAVAILABLE` retention diagnostic while the API remains available.
Native logs complement the requesting user's Artium audit.
Platform grants, API-version compatibility and other native write families remain unverified captain acceptance.

The Falcon adapter is [falcon.ts](src/server/adapters/falcon.ts), implementing the shared [adapter contract](src/server/adapters/types.ts).
Create it with `createFalconAdapter(secretSource)`, then call `adapter.prepare(args, credentialReference)` after authorization and identity selection.
Its zod credential schema accepts `clientId`, `clientSecret`, `region` and optional `memberCid`.
It refuses unsafe overrides before secret retrieval, injects only `FALCON_CLIENT_ID` and `FALCON_CLIENT_SECRET`, and adds the managed region and optional member CID.
Pass its executable, arguments, environment, scan values and limits to the runner.
Falcon requires no temporary files and has no caller flags with server-checked allowed values, because its managed region and member flags are blocked from caller input.
`prepareFalcon(args, { clientIdFile, clientSecretFile, region, memberCid? })` remains the file-backed compatibility entry point and shares the same preparation logic.
The [generated Falcon manifest](tools/inventories/falcon-axi.json) owns the reviewed command and credential boundary, metadata, health read and resource requirements.
Regenerate or verify it with `node scripts/falcon-inventory.mjs /path/to/pinned-source --write` or the same command without `--write`, respectively.
The source checkout must match `tools/falcon-source.json`.
[S12 verification](docs/verification-s12.md) covers the actual pinned parser and canary detection reads using `node scripts/fake-services.mjs --falcon` with the locally built `artium-axi:local` image.
Live Falcon acceptance remains unverified.

The [credential store](src/server/store/db.ts) exposes `openStore(file, keyProvider?)`, returning a SQLite connection only after transactional numbered migrations and authentication of every stored credential.
Use a database file in a dedicated data directory, such as `/data/artium.db`, and close the connection during shutdown.
The directory and database use modes 0700 and 0600, respectively.
SQLite uses foreign keys, WAL, FULL synchronous writes and a 5-second busy timeout.
The default [KeyProvider](src/server/store/key-provider.ts) reads exactly 32 raw bytes from `ARTIUM_AXI_MASTER_KEY_FILE`, or canonical base64 from `ARTIUM_AXI_MASTER_KEY` when no file is configured.
An unreadable configured file does not fall back to the environment key.
Its key ID is the full SHA-256 digest.
Missing, invalid or mismatched store keys fail with `MASTER_KEY_INVALID`, while an unauthenticatable credential fails with `CREDENTIAL_INVALID`.
Store metadata binds the database to its active key ID even before any credential is configured.
See [the upgrade runbook](docs/runbook.md#upgrading-stores-without-a-key-binding) for legacy-store binding requirements and refusal handling.
[Credential encryption](src/server/store/crypto.ts) uses AES-256-GCM with a fresh 12-byte nonce, a 16-byte authentication tag and canonical JSON associated data `[schemaVersion, tool, credentialId, keyId]`.
The [credential schema](src/server/store/migrations/001-credentials.sql) owns the stored fields and constraints; credential plaintext must be encrypted before insertion.
The `tools` table holds pinned versions, enabled state, validated native settings and revisions.
Store startup inserts missing supported tools disabled with an empty version until configured, preserving existing tool settings.
The caller owns native settings validation before storage.
The build copies numbered SQL migrations beside the compiled store.
[S13 verification](docs/verification-s13.md) covers real database reopen, persisted corruption, row binding, startup key refusal and migration rollback.
The [credential-store boundary](src/server/store/credential-store.ts) exposes credential references and parsed values without SQLite types.
Create it with `createCredentialStore(connection, keyProvider)` using the same provider as `openStore`.
Resolved credential references carry the persisted revision, and reads reject a reference with a mismatched revision before decryption.
The reference type keeps revision optional for compatibility; reads without a revision are not bound to a credential version.
Credential reads combine encrypted JSON fields with the tool's native settings to match the adapter's credential schema.
Creating the credential store moves legacy native settings out of encrypted JSON into the tool configuration, preserving already-stored tool settings when both contain the same key.
Version 1 uses one shared service credential per tool in the embedded encrypted database; external secret sources and per-user credentials remain deferred.
The [SharedIdentityResolver](src/server/policy/identity-resolver.ts) selects that credential with `resolve(userId, tool)`, whoever the user is.
The [EmbeddedSecretSource](src/server/store/secret-source.ts) retrieves that reference through `getCredential(reference)` and decrypts it in memory through the store boundary.
Selection does not grant access to a tool, so the owning server flow must authorize before resolution and retrieval.
[S14 verification](docs/verification-s14.md) covers fake-store unit tests and encrypted-store Falcon preparation after reopen, with the T1.5 tests unchanged.
Server startup opens and validates this store before listening.
See [the rotation runbook](docs/runbook.md) for offline master key rotation, including the local command, backup, one-shot container invocation, key switch and crash recovery.
See [S27 verification](docs/verification-s27.md) for local evidence.

Local accounts use Argon2id and reject exact matches in the [versioned common-password list](src/server/auth/common-passwords.v1.json).
Passwords allow spaces and Unicode, with 15 to 128 code points and at most 512 UTF-8 bytes, preserved without trimming.
`POST /v1/auth/login` accepts strict JSON `{ "username": string, "password": string }`.
Ordinary success returns HTTP 200 with `status: authenticated`, distinct 32-byte random `accessToken` and `refreshToken`, and Unix millisecond `accessExpiresAt` and `familyExpiresAt` timestamps.
Access lasts one hour and the family ends 12 hours after login.
`POST /v1/auth/refresh` accepts strict JSON `{ "refreshToken": string }` with a nonempty token and returns HTTP 200 with a new authenticated token pair.
Rotation consumes the refresh token atomically and preserves the original family deadline.
Older access tokens remain valid until their own expiry or family revocation, and new access expiry is capped by the family deadline.
Consumed refresh hashes remain stored for reuse detection through the family deadline.
Reusing a consumed refresh token before that deadline revokes the entire family, records a token-reuse audit event and returns `TOKEN_INVALID`.
`POST /v1/auth/logout` accepts a stored, unrevoked bearer access or refresh token, including an expired or consumed token, and returns 204 after audited family revocation.
Revocation includes every token and browser session in that family, leaving other families unchanged.
See [S31 verification](docs/verification-s31.md) for concurrent refresh, deadline and logout checks.
Login and password reauthentication share limits of 5 attempts per canonical username and 30 per verified client address within 15 minutes.
Successful attempts also consume these limits; each key's fixed window begins with its first admitted attempt.
The counters are held in memory per server and reset on restart; account lockout persists in the database.
Each counter map retains at most 4096 hashed keys, refuses fresh keys at capacity and expires entries after 15 minutes.
Five failed password attempts lock a known account for 15 minutes with an atomic lockout audit event; successful authentication resets its failure count.
Wrong passwords and unknown usernames both return `SIGN_IN_FAILED`; exhausted limits return `AUTH_RATE_LIMITED` and a persisted lock returns `ACCOUNT_LOCKED` when the attempt limit permits the request.
`POST /v1/auth/reauth` accepts an access token in `Authorization: Bearer <token>` and strict JSON `{ "password": string }` with `Content-Type: application/json`, returning HTTP 200 with `{ "ticket": string, "expiresAt": number }` after password confirmation.
`expiresAt` is a UTC Unix millisecond timestamp; refresh and restricted password-change tokens cannot authenticate this endpoint.
The server stores only the ticket hash, replaces the previous ticket for that session family and caps its 15-minute deadline at the family deadline.
Tickets survive refresh within their family and cannot be used with another family or after logout, refresh-token reuse revocation, password change or user disable.
See the user administration usage below for routes requiring these tickets.
See [S32 verification](docs/verification-s32.md) for rate-limit, lockout and ticket evidence.
Only SHA-256 token hashes and metadata are stored.
A must-change account receives `status: password-change-required`, a 10-minute `passwordChangeToken` and `passwordChangeExpiresAt`, without ordinary access or refresh tokens.
The restricted token is accepted only by `POST /v1/auth/password` and cannot list tools, run tools or authenticate administration.
`POST /v1/auth/password` takes the restricted token or a normal access token in `Authorization: Bearer <token>` and strict JSON `{ "newPassword": string, "currentPassword"?: string }` with `Content-Type: application/json`.
It changes only the authenticated user's password, clears the must-change flag, returns 204 and revokes existing CLI tokens and browser sessions atomically with its audit record.
The current password is required for a normal access token.
Restricted password change is single-use and requires a new login after success.
Sign-in success and failure are audited, and token issuance rolls back if its audit record fails.
The [server configuration](src/server/config.ts) owns hashing costs, concurrency, token lifetimes and authentication-limit defaults.
See [S28 verification](docs/verification-s28.md) and [S30 verification](docs/verification-s30.md) for local evidence checks.

The [authentication schema](src/server/store/migrations/002-authentication.sql) adds local users, roles, tool grants, direct assignments, session families, hashed-token metadata, browser sessions, audit records and a one-time bootstrap marker.
`users.username` stores the canonical lookup name with a unique constraint; `display_name` retains the entered name separately.
The account-writing flow owns canonicalization before insertion.
The `administrator` flag is a reserved account capability independent of role tool grants.
The schema provides revision fields for users and roles, alongside the existing tool and credential revisions.
See the administration usage below for account and role edit concurrency.
Token types are `access`, `refresh` and `password-change`, with consumed and revoked timestamps and family ownership enforced by foreign keys.
See the browser sign-in usage below for enforcement of session idle expiry and password confirmation.
Authentication and audit writers must store timestamps as UTC Unix milliseconds.
See [the bootstrap runbook](docs/runbook.md#first-administrator-and-offline-recovery) for the one-time marker and administrator safeguards.
[S15 verification](docs/verification-s15.md) covers empty-store creation, Phase 2 upgrades with encrypted data preserved, canonical-name uniqueness and foreign keys.
The [access-token verifier](src/server/auth/tokens.ts) looks up SHA-256 hashes and enforces access-token type, token and family deadlines, consumption and revocation.
The [tool policy](src/server/policy/policy.ts) reads the current enabled user, enabled tool and role grants on every call.
The [audited execution function](src/server/runner/run.ts) verifies the token, current policy and bounded request before persisting a start, resolving the shared identity and retrieving credentials through the adapter.
It rechecks the stored token synchronously immediately before child creation, after asynchronous preparation and temporary-file setup.
Expiry or revocation during setup returns the authentication error without creating a child and removes the prepared temporary files.
It executes through the runner and persists a terminal event before returning a completed result, including nonzero upstream exits.
The [error catalogue](src/shared/errors.ts) owns token and policy denial codes and their distinct responses.
The random [fixture issuer](test/fixtures/tokens.ts) lives only in the test harness and refuses execution outside `NODE_ENV=test`.
It stores only the token hash, sets a one-hour access-token expiry and a fixed 12-hour family deadline, and issues tokens checked by the production verifier in tests.
[S16 verification](docs/verification-s16.md) covers expiry and revocation, next-call role changes and proof that denied preparation retrieves no secret.

The [audit store](src/server/audit/audit.ts) records UTC Unix millisecond timestamps, actor IDs, tools, request IDs, verified client addresses, outcomes and safe run metadata.
`runTool(db, audit, runner, token, request, adapter, resolver, context, authenticate?)` owns admission and execution.
It defaults to the stored access-token verifier also used by the HTTP server.
The HTTP owner supplies a unique request ID, a verified client address and an optional disconnect signal through `context`.
Audit persistence failure returns `AUDIT_UNAVAILABLE`, prevents credential retrieval and child creation at admission, and withholds the completed result if terminal persistence fails.
Run failures record only stable error codes, duration and observed output sizes, including secret-output failures.
The [argument redactor](src/server/audit/redact.ts) hides sensitive separate and equals flag values and the positional indices identified by `adapter.sensitiveArguments(args)`.
It records at most 64 original arguments, caps each recorded value at 512 characters and escapes control characters.
Injected credential arguments, request bodies, stdin, uploaded contents, tokens, passwords and output streams never enter audit storage.

Create one `Audit` per server and call `recoverInterrupted()` before admitting requests at startup.
It appends interrupted terminal events for unmatched starts without replaying commands, using null exit codes and unknown output sizes.
Call `maintain()` from the server's daily maintenance tick.
It drains all events strictly older than the captured 90-day cutoff in batches of at most 500 events.
Each batch commits its deletion, cutoff and count in a separate short transaction, and rolls back that batch if its maintenance event cannot be stored.
Set `ARTIUM_AXI_AUDIT_STDOUT=1` to stream each committed record as one JSON line on stdout with exactly the persisted fields.
SQLite remains authoritative if the optional stream fails.
For export, capture that stream in a protected external collector before retention expires.
See [the runbook](docs/runbook.md) for database backup requirements and the remaining backup and restore work.

`audit.record(event)` supplies the record shapes for sign-in, sign-out, lockout, token reuse, password changes, credential tests and administration.
Authentication and admin producers must use metadata only.
Manual credential tests persist `checked_at`, `credential_revision` and `error_code` on admission-failure, run-start, run-terminal and credential-test records, independently of the replaceable health cache.
Times are UTC Unix milliseconds; the revision is null when no credential was found, and the error code is null at start or on success.
Startup recovery retains the tested revision on interrupted terminal records, with null check time and error code.
`audit.change(event, mutation)` commits a synchronous database mutation and its event together, then streams the committed event.
It preserves mutation errors and rolls the mutation back when audit persistence fails.
These operations reject calls inside another transaction with `AUDIT_UNAVAILABLE`, so streaming always follows commit.
There is no audit update or deletion interface for administrators.
[S17+S18 verification](docs/verification-s17-18.md) defines the local checks.

`node test/fake-tool/fake-axi.mjs <mode>` runs the deterministic test executable.
Modes are `env`, `print`, `sleep`, `stdout`, `stderr`, `memory`, `child`, `child-exit`, `descendant`, `exit`, `split`, `leak`, `signal` and `upstream`.
For example, `stdout 8388608` floods stdout, `split canary 3 stderr` splits stderr bytes, and `upstream az-axi error` emits a synthetic stream capture with an error status.
`leak` reads only `ARTIUM_TEST_CANARY`, with `raw`, `base64`, `base64url` or `url` encoding and an optional `stderr` argument.
`child` creates an ordinary descendant, while `descendant` starts a separate session.
`child-exit` leaves an ordinary descendant after the leader exits.
`descendant pipes` retains inherited output pipes, and `sleep 60000 ignore-term` ignores SIGTERM.
Lifecycle tests may set `ARTIUM_TEST_READY_FILE` to an owned fixture path to receive an atomic readiness record.
Callers must terminate both PIDs printed by those modes.
[`test/fake-tool/tool.ts`](test/fake-tool/tool.ts) supplies the executable and argument descriptor for runner tests, without a production fake-tool entry.

[`SecretScanner`](src/server/runner/scan.ts) is the standalone S07 runner component.
Create one per call with all known injected secret values, then call `scan('stdout' | 'stderr', chunk)` on every raw byte chunk before retention or rewriting, including chunks after the 4 MiB per-stream cap.
A `true` result stays true and requires the caller to discard both streams and report `SECRET_IN_OUTPUT` with only safe audit metadata.
The scanner checks raw UTF-8, canonical base64, base64url and `encodeURIComponent` forms, including short values, without retaining output bytes.
Each stream carries independent prefix-match positions, so split UTF-8 bytes work and interleaved streams cannot create a false combined match.
An empty supplied value is rejected, while an empty list is valid for a call with no injected secrets.
Exact-value scanning cannot identify unknown tokens minted inside an upstream tool.
The [runner](src/server/runner/runner.ts) now owns stream capture and scanner integration.
Create one `Runner` per server with `await Runner.create()`, before accepting calls.
It removes abandoned `artium-call-` entries from its private root without following symlinks.
Call `runner.run(userId, executable, args, environment, secrets, limits, input, files, beforeSpawn?)` with the authenticated user, adapter-provided environment values and all known preparation secrets.
The audited execution function supplies the synchronous `beforeSpawn` token recheck described above.
Admission covers call-directory setup, execution and cleanup, with no queue, at most 8 global calls and 2 per user.
The later owning server flow must enforce a separate 30-second preparation deadline for the [Falcon adapter](src/server/adapters/falcon.ts).
Credential tests and scheduled background health reads use this same runner, with an administrator identity for manual tests and named system accounting for background reads.
Excess calls reject immediately with `TOO_MANY_CALLS`.
It spawns an argument array without a shell in a detached Linux process group, using the fixed runtime PATH from `src/server/config.ts`.
Each call has a private mode-0700 directory for its working directory, HOME, TMPDIR and XDG paths, removed after completion or failure.
The child environment contains exactly the adapter-provided values with PATH, HOME, TMPDIR, XDG paths and NODE_OPTIONS overridden by the runner.
No parent environment variables are inherited.
The result preserves stdout, stderr and the upstream exit code, with duration, observed byte counts and per-stream truncation flags.
Capture defaults to 4 MiB per stream, drains subsequent output and scans every chunk before retention.
A secret match discards both streams and rejects with `SECRET_IN_OUTPUT`.
Failed spawn and signal termination reject safely without captured output.
The default child timeout is 60 seconds, with a trusted adapter override in `limits.timeoutMs` only after measured probe evidence.
Supply the caller's disconnect `AbortSignal` in `limits.signal` to cancel the call.
Timeout and cancellation reject with `TIMEOUT` and `CANCELLED`, without captured output or an invented upstream exit code.
Completed results retain the existing `timedOut: false` field.
At 64 MiB observed across both streams, the call stops with `OUTPUT_LIMIT`.
Termination sends SIGTERM to the whole Linux process group, allows 2 seconds, then sends SIGKILL, closes lingering pipes and waits for the leader's close event before releasing admission.
Normal leader exit also terminates surviving group descendants.
`await runner.shutdown()` stops admission, cancels runs and waits for their cleanup.
The development server wires HTTP disconnect and shutdown events to these public interfaces, then closes its store.
`TEMP_UNAVAILABLE` reports failure to create a call directory, adapter-owned files or uploaded inputs, including full tmpfs, without exposing filesystem diagnostics.
An upstream tmpfs write failure preserves its ordinary nonzero exit status and still removes the call directory.
Node children receive a 128 MiB heap limit.
The fixed Python launcher applies a 512 MiB address-space limit before executing Falcon, preserving its shebang interpreter.
Other trusted Python descriptors can set `limits.runtime: 'python'`.
Python is the only explicit runtime selector; Node heap limits apply to every call without a selector.
Heap and address-space limits are not total resident-memory caps or complete process isolation.
A descendant that starts a new session escapes the process group, including when it retains output pipes.
The runner bounds pipe cleanup but cannot kill or reap that escaped session.
Ordinary orphan descendants are reaped by the container init process, while the runner reaps its direct child.
The [shared contract](src/shared/api.ts) owns the exact request and response fields, input limits, validation rules and supported tool identifiers.
Requests support argument arrays, optional UTF-8 stdin and named base64 uploads.
The HTTP server enforces the exported body limit, JSON content type, schema validation and authorization before credential retrieval.
The [error catalogue](src/shared/errors.ts) owns the implemented error codes, HTTP status mapping and safe default messages and next steps.
Completed upstream calls use the success envelope even for nonzero exit codes.
Artium failures use the error envelope without captured output.
When building the HTTP success envelope, omit the runner's internal `timedOut` field.

Pass optional input as the seventh `runner.run` argument, with `stdin`, `files` and adapter-reviewed `fileArguments` indices.
Pass adapter-owned profile and CA files as the eighth argument using the [TemporaryFile contract](src/server/adapters/types.ts); the runner creates exclusive mode-0600 files in the call directory and refuses invalid leaf names or collisions.
The [input transport](src/server/runner/input.ts) validates inputs before creating the call directory, writes uploads into a separate mode-0700 `inputs/` directory as exclusive mode-0600 files, and substitutes only reviewed argument positions whose value exactly matches an uploaded name.
File arguments containing server paths or missing uploads are refused.
Adapters must normalize equals-form flags and supply the reviewed file-value positions after parser-aware validation.
The runner sends bounded UTF-8 stdin through a pipe and closes it, including when stdin is omitted, and cleans uploads with the call directory on success or failure.
The development HTTP endpoint uses this contract.
The CLI's command-specific stdin capture and remaining adapters' restrictions on credential/config/output paths arrive in later slices.
See [verification-s11.md](docs/verification-s11.md) for contract and input transport evidence.
See [verification-s09-10.md](docs/verification-s09-10.md) for lifecycle, resource and limitation evidence.
See [verification-s08.md](docs/verification-s08.md) for local runner acceptance checks.
See [verification-s07.md](docs/verification-s07.md) for the local acceptance checks.

Local HTTPS tests create an ephemeral CA and exercise the pinned Vectra native default refusal, preview, confirmed execution and ambiguous-write response against a loopback fake service.
They assert mutation counts and native write-log creation.
They do not prove real appliance permissions.

`pnpm test:fake-services` runs the separate Linux Docker TLS/DNS and outbound-denial check.
It requires Docker, OpenSSL and an image named `artium-test-node22` containing Node 22 or later.
Run `pnpm test:build-image` to build it from the digest-pinned official Node 22 bookworm-slim base in `test/fake-service/Dockerfile`.
The build requires an existing `moby/buildkit:buildx-stable-1` image and permits fetching the public Node base.
It uses a uniquely named, privileged `artium-test-` BuildKit container with bounded CPU and memory, and cache on private tmpfs.
See the container acceptance block above for standalone and combined worker/cache cleanup.
It refuses to replace an existing `artium-test-node22` image.
An existing suitable Node image can be tagged with `docker image tag <existing-node-image> artium-test-node22`.
The harness never pulls an image, builds one, publishes ports or alters existing containers.
It creates uniquely named `artium-test-` internal networks and containers, routes the fixed upstream names to the fake TLS service and trusts only its ephemeral test CA.
It tests outbound denial using a second synthetic service on a separate internal network, without probing a real endpoint.
Its finalizer removes its containers, networks and temporary certificates, and leaves the supplied image intact.
After a check using a freshly built test image, remove that owned image with `docker image rm artium-test-node22`.
No image or build cache is created by the network harness itself.
An unavailable image or Docker daemon produces a nonzero `unverified` result, which must be recorded in the evidence ledger.
The harness also records az-axi same-origin and cross-origin redirects, pagination and the actual mutation request count after an ambiguous 503.
See [the evidence ledger](docs/evidence-ledger.md) for the observed retry behaviour and Azure write-capability restriction.
The [Dockerfile](Dockerfile) owns the Falcon wheel build and install recipe, using the full commit in [`tools/falcon-source.json`](tools/falcon-source.json).
Python build and runtime dependencies have separate SHA-256 locks.
Python dependency downloads verify those hashes, and Python installation and wheel building run with no package index and no network.
The runtime contains Python 3.11, the pinned tools and UID 10001 (`artium`).
mg-axi is installed for inventory checks only and has no production tool path or adapter.
`src/server/config.ts` owns the three executable paths.

Run `node scripts/build-fake-service-image.mjs --production` to build `artium-axi:local` using the private BuildKit worker.
This larger build uses overlayfs and an executable 3 GiB tmpfs cache with a 4 GiB memory bound.
Worker/cache cleanup follows the standalone and combined ownership contract above.
An existing image is never replaced.
Run `docker run --rm --network none --read-only --tmpfs /tmp artium-axi:local node scripts/native-smoke.mjs` to verify SQLite persistence across reopen, Argon2id hash/verify and an esbuild bundle executed with Node.
Run the same command with `scripts/falcon-smoke.mjs` to verify unknown-origin refusal and explicit canary delivery to a loopback TLS fake.
Remove the owned image afterwards with `docker image rm artium-axi:local`.

[`compose.example.yaml`](compose.example.yaml) records the loopback port, read-only root, `/tmp` tmpfs, `/data` volume and file-backed Docker master-key secret.
It also sets an init process for orphan reaping, a 6 GiB memory limit, a 192-task limit and a 256 MiB `/tmp` tmpfs.
Run `pnpm test:runner-container` for the separate mandatory Linux cgroup and full-tmpfs checks.
It builds a unique `artium-test-runner-s09-10-<uuid>` image, tests a non-root read-only runtime without network access, and removes its containers and image on completion.
Worker/cache cleanup follows the standalone and combined ownership contract above.
The builder owns its Docker operation deadlines; the harness waits for its cleanup without an enclosing kill deadline.
The checks verify the configured 6 GiB bound and force a resident-memory OOM at a smaller synthetic 256 MiB cgroup bound, without stressing the host with a 6 GiB allocation.
They cover ENOSPC during upstream writes and directory creation under a tighter synthetic 1024-inode bound, cleanup and successful admission after storage is freed.
`docker compose -f compose.example.yaml config --quiet` validates it without creating resources or reading real secrets.
The image's default command starts the API described below.
The Compose example supplies only the master key; add the [first-start bootstrap settings](docs/runbook.md#first-administrator-and-offline-recovery) for a new store.
Compose publishes the internal HTTP listener on host loopback only.
An external connection requires a trusted HTTPS proxy.
See [verification-s05-06.md](docs/verification-s05-06.md) for packaging verification and deferred Falcon live checks.

After `pnpm build`, run `pnpm start` with `ARTIUM_AXI_MASTER_KEY_FILE` pointing to a synthetic 32-byte key file.
The server rejects `ARTIUM_AXI_DEV` and `ARTIUM_AXI_DEV_TOKEN_FILE`, including in production.
On first start, also set `ARTIUM_AXI_ADMIN_USERNAME` to a synthetic local username and `ARTIUM_AXI_ADMIN_PASSWORD_FILE` to a UTF-8 file containing the exact starting password, without an added newline.
See [the runbook](docs/runbook.md#first-administrator-and-offline-recovery) for bootstrap requirements, later-start behavior, administrator safeguards and offline audited recovery.
See [S29 verification](docs/verification-s29.md) for local startup and recovery evidence.
Use `ARTIUM_AXI_DATABASE_FILE` to select a dedicated local development database instead of `/data/artium.db`.
The [server configuration](src/server/config.ts) owns the listener and storage defaults.
All tools remain disabled until the development store is configured.
Use only synthetic encrypted credentials and fake upstream services during the build.
Never put a token or key in an argument, source file, image or log.

The [Fastify API](src/server/app.ts) implements the authentication endpoints described above, authenticated `GET /v1/tools` and JSON `POST /v1/tools/{tool}/run`.
Use an ordinary access token from local sign-in in `Authorization: Bearer <token>` and `Content-Type: application/json` for runs.
The [shared API contract](src/shared/api.ts) owns the tools listing schema as well as run requests and responses.
Tools listing includes enabled, granted adapters and reads cached health without contacting an upstream service.
Configured tools have `unknown` status until a health check records `ok` or `error`; missing credentials have `unconfigured` status.
Health records carry check time, credential revision and a safe error code, never upstream output.
The server checks enabled configured tools every 15 minutes and after credential or native-setting replacement.
Manual tests run the same checker and store completed check results subject to the cache rules below.
One check per tool can run at a time across both paths, including preparation and cleanup.
Replacement during a check queues one check of the latest revision after the current check finishes.
Background reads share global runner slots, with per-tool system accounting named `system:tool-health:<tool>`.
Their `health-check` audit record identifies `system:tool-health` in `action`, without creating a sign-in account.
Admission and authorization failures preserve the previous cache, and an old credential revision never replaces newer health.
Health status does not change platform permissions or hide permitted commands.

Run `node dist/cli/artium-axi.mjs doctor` to print one pass/fail line for the server address, certificate, token and CLI version.
When token and version checks pass, it also prints a line for each available tool's cached health; only `ok` passes.
After any failed check, diagnostics end with the first failure's catalogue error envelope and exit code from the [generated error reference](docs/errors.md); all passing checks exit 0.
Certificate trust is verified through HTTPS, and a local test HTTP connection reports a failed certificate check.
Doctor does not run platform checks or require administrator access.
Every CLI request carries `X-Artium-Cli-Version` from `package.json`.
The server accepts that release and newer versions, returning HTTP 426 `CLI_OUTDATED` with a download command for older or malformed version headers.
Browser requests, health routes and CLI download paths are exempt, and API clients without a CLI header remain supported.
The public download routes and installation instructions are described above.
See [S42 verification](docs/verification-s42.md) for fake-time exclusion, stored listing, version exemptions and bundled diagnostics.
Run responses use the exact shared success or error envelope, preserving upstream nonzero exit codes as HTTP 200.
Tool requests use the stored access-token verifier, with current database policy applied to every request.
Bearer user administration requires the current administrator capability and the ticket returned by `POST /v1/auth/reauth` in `X-Artium-Reauth-Ticket`.
Cookie-authenticated administration follows the browser sign-in rules below.
`GET /v1/admin/users` accepts `cursor` and `limit` (1 to 100); account fields exclude password hashes.
Pass the response's `nextCursor` as the next request's `cursor`; a null `nextCursor` marks the final page.
`POST /v1/admin/users` accepts `username`, `displayName`, `temporaryPassword`, `administrator` and `roleIds`, returning 201 with the public account and requiring a password change at first sign-in.
`PATCH /v1/admin/users/{id}` accepts `displayName`, `enabled` and/or `administrator`, together with `expectedRevision`.
`POST /v1/admin/users/{id}/unlock` clears account lockout; `POST /v1/admin/users/{id}/password-reset` accepts `temporaryPassword` and forces a password change.
Both clear the canonical username's in-memory attempt counter on the handling server after the database mutation and audit commit, allowing immediate sign-in subject to the unchanged per-address limit.
An audit failure preserves the lockout and username counter.
Creation and reset use the local password rules above, preserving passwords without trimming; creation canonicalizes the username for lookup and stores the supplied `displayName` separately.
Successful mutations other than creation return 200 with public account metadata and the new revision; stale edits return 409 and unknown accounts return 404.
Every mutation commits atomically with its metadata-only audit event.
Disabling and resetting revoke CLI and browser sessions in the same transaction as the audit event.
The last enabled administrator cannot be disabled or demoted, including concurrent edits.
The [shared API contract](src/shared/api.ts) owns the complete user inputs, public fields, pagination and audit actions; there is no account delete route.
See [S33 verification](docs/verification-s33.md) for real local login, authorization, audit rollback and concurrency evidence.
`PUT /v1/admin/users/{id}/roles` replaces `roleIds` with an `expectedRevision` shared with other account edits.
`GET /v1/admin/roles` uses the same `cursor`, `limit` and `nextCursor` pagination as users.
`POST /v1/admin/roles` accepts `name` and returns 201 with public role metadata.
`PATCH /v1/admin/roles/{id}` accepts `name` and `expectedRevision`.
`PUT /v1/admin/roles/{id}/tools` replaces `tools` with an `expectedRevision`, accepting only `falcon-axi`, `vectra-axi` and `az-axi`.
The [shared API contract](src/shared/api.ts) owns the complete role inputs, public metadata and audit actions.
Role administration follows the same authorization rules as user administration.
Role and assignment mutations commit with their audit event and return public metadata with the new revision; successful edits return 200.
Invalid references return 400, unknown targets return 404 and stale revisions return 409 without changes.
Tool grants never confer administrator capability, and role changes apply to the next tool call using existing tokens.
See [S34 verification](docs/verification-s34.md) for role, grant and assignment evidence.
`GET /v1/admin/tools` lists the three fixed tools with pinned versions, enabled state, native settings, revisions, change metadata and cached health without making an upstream call.
`PATCH /v1/admin/tools/{tool}` accepts `enabled`, `nativeSettings` and `expectedRevision`.
When supplied, `nativeSettings` replaces the entire settings object; `{}` clears it.
Falcon has no editable native write settings and accepts only `{}`.
Vectra accepts `writes: { allowWrites, operations }`; Azure accepts `subscriptions`, `managementGroup`, `workspaces`, `description` and `allowWrites`.
These shared schemas also validate the adapters' native profile settings.
No executable path, tool installation or caller-selected health command is accepted.
Azure configuration remains editable, but its runtime enable and test operations remain disabled until the pinned upstream retry issue is resolved.
`GET /v1/admin/tools/{tool}/credential` returns only allowlisted non-secret metadata, configuration state, revision and last change time/actor.
`PUT /v1/admin/tools/{tool}/credential` accepts a complete adapter-specific `value`, `expectedRevision` and `expectedToolRevision`, using credential revision `0` for the first credential and the tool revision observed in `GET /v1/admin/tools`.
Both revisions are checked atomically before either record changes, so a stale credential form cannot overwrite newer native settings even when the tool has no credential yet.
No response returns a credential value, token, private key or client secret; Falcon's client ID is also withheld because that adapter treats it as a scan secret.
The replacement splits native settings into the tool configuration and encrypts the remaining credential fields, updating both records with one audit commit.
Omitted native settings are cleared rather than preserved; include every setting to retain in the replacement `value`.
It advances the tool revision as well as the credential revision, clears cached health and immediately evicts old Azure resource tokens and pending acquisitions.
Native-settings patches also advance the configured credential revision so an old prepared profile cannot be reused by a manual test after the edit.
`POST /v1/admin/tools/{tool}/test` accepts only an empty body and runs the fixed Falcon `auth status`, Vectra `health list` or internal Azure `account list` read.
Configured disabled Falcon and Vectra tools can be tested before enabling them.
Manual tests never overlap for one tool and use the same global and per-administrator runner slots as ordinary calls.
They return only safe health fields and retain no upstream output; the audit contract is described above.
The health cache rules above also apply to manual tests.
Tool administration follows the same authorization rules as user administration.
Tool edits and credential replacements return public metadata and commit with their audit event.
See [S35 verification](docs/verification-s35.md) for the fake-only route, quota and cache evidence.

Open `/login` through the HTTPS reverse proxy to sign in from a browser.
Temporary passwords open `/password` and cannot access administration until changed, after which a new login is required.
Administrators land on `/admin`; ordinary users land on `/account` with password-change and sign-out forms.
The session cookie contains an opaque identifier with `Secure`, `HttpOnly` and `SameSite=Strict` attributes.
Sessions persist in SQLite and end after 30 minutes idle or 12 hours from login, whichever comes first.
Temporary-password sessions end after 10 minutes.
Every browser mutation requires a same-origin request and a CSRF token, including sign-in, sign-out, reauthentication and credential tests.
Browser administration uses the current administrator capability.
Sign-in counts as password confirmation.
After 15 minutes without password confirmation, an administration mutation opens `/reauth`; confirm the password and submit the action again.
Cookie-authenticated `POST /v1/auth/reauth` also confirms the password with CSRF and returns 204, while bearer callers retain their ticket response.
An ordinary password change accepts the current password or recent browser password confirmation.
See the password and user administration usage above for session revocation on password change, reset and disable.
Browser pages escape account data, send a Content Security Policy and prevent response caching.
See [S38 verification](docs/verification-s38.md) for fake-time expiry, CSRF and browser-flow evidence.
The Users screen at `/admin` creates local users, enables or disables accounts, clears lockouts, resets temporary passwords and replaces role assignments through the existing administration API.
Enable/disable and role replacement carry the displayed revision, and each account shows its last change actor and UTC time.
Enable, disable, unlock, reset and assignment actions ask for confirmation.
Stale edits and validation failures show the API message and next step without clearing the form.
See [S39 verification](docs/verification-s39.md) for HTML escaping, pagination and real browser evidence.

Use the administration navigation to open Tools at `/admin/tools`, Credentials at `/admin/credentials` and Roles at `/admin/roles`.
Tools shows each pinned version, enabled state, cached status, last check and last change actor/time.
Enable or disable Falcon and Vectra, or edit their native settings as a JSON object using the field guidance beside the editor.
Settings replace the entire object, and `{}` clears it.
Malformed JSON stays in the editor with an error, and the existing API validates the tool-specific native policy before saving.
Azure settings remain editable while runtime enable and Test remain unavailable.
Credentials accepts a complete replacement JSON object, including any native settings to retain.
Its editor always starts blank and never renders stored credential values.
The Test credential button runs the API's fixed harmless read within the existing manual-test quota, shows pass or fail and refreshes the cached status, check time and safe error code.
Roles creates and renames roles and replaces their tool grants from the fixed registry, including clearing all grants.
Use Users to assign or remove roles, with changes applying to the next call using existing tokens.
All three screens show change actor, UTC time and revision, and reuse the existing confirmations, CSRF, recent-authentication challenge and stale-edit handling.
See [S40 verification](docs/verification-s40.md) for secret-free rendered pages, native settings and the real browser role-removal flow.

### Audit screen and API

Open Audit at `/admin/audit` from the administration navigation to find changes made through Users, Tools, Credentials and Roles, as well as tool calls and authentication events.
Select a user or tool, enter an exact outcome such as `success`, `completed` or an error code, and optionally set inclusive From and To times as UTC ISO timestamps such as `2026-01-01T00:00:00Z`.
Records show the actor, UTC time, event, outcome, action, target, request ID, redacted arguments, verified client address and available execution, credential-test or retention metadata.
Next page retains the filters; Apply filters and Clear filters start a fresh page.
Browser reads require the current administrator capability without recent password confirmation.

`GET /v1/admin/audit` provides the same records with `user` (actor ID), `tool`, `outcome`, `from`, `to`, `limit` and `cursor` query parameters.
Bearer callers require the session-bound reauthentication ticket described above.
The [shared API contract](src/shared/api.ts) owns the query validation and response fields.
Pages default to 50 records and accept limits from 1 to 100, ordered by timestamp descending and then record ID descending.
Pass `nextCursor` as the next request's `cursor`, retaining the filters; null marks the final page.
Continuation cursors exclude later inserts, including backdated records; start without a cursor to see newly inserted records.
Successful reads append no audit event and do not modify records; API authorization denials append denial events.
There is no audit mutation or deletion route.
See [S41 verification](docs/verification-s41.md) for local fake-only API and browser evidence.

Public `GET /health/live` returns HTTP 200 with `{ "status": "ok" }`.
`GET /health/ready` checks that the local migrations table remains readable, returning HTTP 200 with `{ "status": "ok" }` or HTTP 503 with `{ "status": "unavailable" }`.
Readiness does not reload the key or contact remote services.
Set `ARTIUM_AXI_TRUSTED_PROXIES` only to a comma-separated list of verified proxy source IP addresses.
The default trusts none and rejects forwarding headers received directly from untrusted sockets.
The proxy must replace client forwarding headers.
Audit uses generated request IDs and the verified address, persists admission before credential retrieval or child creation, and withholds output when terminal persistence fails.
Startup recovers interrupted runs without replay and performs retention cleanup, followed by daily cleanup.
See [S19 verification](docs/verification-s19.md) for local HTTP, startup, proxy and validation evidence.
