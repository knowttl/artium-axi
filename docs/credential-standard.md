# AXI Credential Standard - v2 (agreed)

Contents:

- [0. Terms](#0-terms)
- [1. Paths](#1-paths)
- [2. Environment variables](#2-environment-variables)
- [3. Profile model](#3-profile-model)
- [4. Permissions](#4-permissions)
- [4.1 Linux and macOS](#41-linux-and-macos)
- [4.2 Windows](#42-windows)
- [4.3 Both platforms](#43-both-platforms)
- [5. Precedence](#5-precedence)
- [6. Secret storage](#6-secret-storage)
- [7. Commands](#7-commands)
- [8. Redaction](#8-redaction)
- [9. Hosted contract (artium-axi)](#9-hosted-contract-artium-axi)
- [Per-tool host-facing schemas](#per-tool-host-facing-schemas)
- [10. Migration](#10-migration)

Status: AGREED.
The [connection-lifetime amendment](#opt-in-connection-lifetime-amendment) records the separate SSH approval and its release-at-close requirement.
The owner approved the base standard on the board in round 3, writing "if everything looks good you can finalize the report and hand it back".
This is the agreed contract; current host rollout and remaining tool migrations are tracked in [credential-migration.md](credential-migration.md).
Round 2 added the owner's requirement that credential storage work the same on Windows and Linux.
Round 3 recorded all six board decisions:

- D1 (standard): C.
- D2 (vendor-native env names): rename to `P_*`, with aliases governed by the [compatibility policy](../CONTRIBUTING.md#compatibility-policy).
- D3 (stored secrets): a protected `credentials.json` only.
- D4 (legacy paths): a **hard cut**.
- D5 (azure-axi): an ambient-credential tool.
- D6 (Windows DACL): set on every write, verified by `auth status` and `doctor`.

The text where each decision applies is marked `[D#]`.

Applies to every credential-bearing knowttl `*-axi` tool.
artium-axi is the host that consumes the standard (section 9).
The key words MUST, SHOULD and MAY are used as described in RFC 2119.

## 0. Terms

- **Tool prefix `P`**: the tool name in upper case, with `-` replaced by `_`.
- **Profile**: one named set of non-secret settings, made of one endpoint or tenant and one identity, together with references to its secrets.
- **SecretRef**: a JSON value that says where a secret comes from, defined in section 3.
- **Host**: a program that runs the tool on someone else's behalf, for example artium-axi.

## 1. Paths

1. The config dir MUST be `$XDG_CONFIG_HOME/<tool>/` when `XDG_CONFIG_HOME` is set to an absolute path.
   Otherwise it MUST be `~/.config/<tool>/` on Linux and macOS, and `%APPDATA%\<tool>\` on Windows.
2. Profiles MUST live in `<config dir>/config.json`.
3. The state dir MUST be `$XDG_STATE_HOME/<tool>/` when that is absolute.
   Otherwise it MUST be `~/.local/state/<tool>/`, or `%LOCALAPPDATA%\<tool>\` on Windows.
   `%LOCALAPPDATA%` does not roam with a roaming profile.
4. The state dir holds two files:
   - `writes.log`, the write journal.
   - `credentials.json`, which exists only for tools that implement `auth login` (section 6).
   Anything bound to the machine, including every stored secret, lives in the state dir, so it never roams.
5. On Windows, `XDG_*` variables MUST be ignored.
   This matches artium-axi `src/cli/session.ts:13-17`.
6. The home directory MUST come from `os.homedir()` or `Path.home()`.
   A tool MUST NOT read `$HOME` directly, because it is usually unset on Windows.
7. A tool MUST NOT discover configuration from the current working directory or from any other home path.
8. Legacy locations are a hard cut `[D4]`.
   Those locations are `~/.vectra-axi/`, `~/.az-axi/`, `~/.mg-axi/`, `~/.awx-axi/`, falcon-axi's `~/.config/falcon-axi/credentials`, and az-axi's `./az-axi.config.json`.
   A tool MUST NOT read them.
   If a legacy file exists and the new file does not, the tool MUST fail with `CONFIG_MOVED`.
   The error names both paths and the exact move command.
   When the format also changes, as with falcon-axi's dotenv file, the error instead points to the format.

## 2. Environment variables

1. Every variable a tool defines MUST start with `P_`.
2. Each tool MUST support this fixed set:
   - `P_CONFIG`: the path of the config file.
   - `P_PROFILE`: the profile name.
   - `P_READ_ONLY`: a boolean that forces read-only mode.
   - `P_WRITE_LOG`: the path of the write journal.
3. Each profile field has an env name `P_<FIELD>`, where `<FIELD>` is the field name in SCREAMING_SNAKE case, for example `clientSecret` becomes `FALCON_AXI_CLIENT_SECRET`.
   These variables form the *env profile* (section 5).
4. Every standard name is upper-case, so Windows (case-insensitive) and Linux (case-sensitive) resolve it identically.
5. Boolean variables accept `1` or `true` (case-insensitive) as on, and `0`, `false` or unset as off.
   Any other value MUST be rejected with `CONFIG_INVALID`, so the check fails closed.
6. Names that a third-party SDK reads by itself are kept unchanged.
   Examples are `AZURE_*` via `@azure/identity` and `AZURE_FEDERATED_TOKEN_FILE`.
7. Existing vendor-native names stay accepted as deprecated aliases under the [compatibility policy](../CONTRIBUTING.md#compatibility-policy), with a stderr notice `[D2]`.
   Only env var names get this transition; file locations are a hard cut (section 1.8).
   This covers `FALCON_CLIENT_ID`, `FALCON_CLIENT_SECRET`, `FALCON_MEMBER_CID`, `FALCON_BASE_URL`, `FALCON_PROXY_URL` and `CONTROLLER_*`.

## 3. Profile model

1. `config.json` MUST have this shape:

   ```json
   { "version": 1, "defaultProfile": "<name>", "profiles": { "<name>": { } } }
   ```

2. Profile names MUST match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`.
3. Each profile schema MUST be strict, meaning unknown keys are rejected.
   A secret written inline MUST be rejected with an error that names the field and never echoes the value.
4. A field that holds a secret MUST hold a SecretRef, which is exactly one of these:
   - `{"env": "NAME"}`: NAME MUST match `^[A-Za-z_][A-Za-z0-9_]*$`, and this MUST be validated when the config is loaded, not only when it is written.
   - `{"file": "/absolute/path"}`: the file MUST pass the read check in section 4.
     On Windows, the path MUST be an absolute drive path such as `C:\…`.
     UNC (`\\server\…`) and device (`\\?\…`) paths MUST be rejected.
     Content is read as UTF-8, with a leading BOM and trailing whitespace (including CR/LF) removed.
   - `{"stored": true}`: the value was written by `auth login` (section 6).
5. When a secret field is omitted, its SecretRef defaults to `{"env": "P_<FIELD>"}`.
6. These field names are shared across tools:
   - `origin`: an HTTPS origin with no path, query, userinfo or fragment.
   - `tenantId` and `clientId`.
   - `clientSecret`.
   - `privateKey`: PEM.
   - `thumbprintSha256`: 64 hex characters.
   - `token`.
   - `writes`: `{allowWrites, operations[]}`, where a tool already uses this.
7. To use several tenants or endpoints, create several profiles.
   A single invocation uses exactly one profile.
   The exception is `doctor` with no profile selected, which MAY check every profile.

## 4. Permissions

The rules differ by platform, and the outcome MUST be the same on both: only the owning account can read or change the tool's files.
macOS and WSL follow the Linux rules.

### 4.1 Linux and macOS

1. Directories MUST be created with mode 0700.
   An existing directory the tool writes into MUST be chmod-ed to 0700.
2. Files MUST be written atomically:
   1. Create a temp file in the same directory with mode 0600 and flag `wx`.
   2. Write the content and fsync it.
   3. Rename it into place.
   4. Remove the temp file on failure.
3. Before any content is read, the tool MUST check that the file is a regular file, is not a symlink, and is owned by the current uid.
   In addition:
   - `config.json` MUST NOT be writable by group or other, that is `mode & 0o022 == 0`.
   - `credentials.json` and every `{"file":…}` SecretRef target MUST have no group or other bits, that is `mode & 0o077 == 0`.
     This check also accepts 0400.

### 4.2 Windows

1. Mode bits MUST NOT be used or checked on Windows.
   Node only maps them to the read-only attribute, and both Node and CPython report synthetic `0o666`/`0o444` values there.
2. Every directory the tool creates and every file it writes MUST get a protected DACL.
   The DACL disables inheritance and grants FullControl only to the current user, SYSTEM (`S-1-5-18`) and Administrators (`S-1-5-32-544`).
   On directories the grant is inheritable.
   This is artium-axi [`restrictWindowsAcl`](../src/cli/session.ts).
3. Files MUST be written atomically:
   1. Create a temp file with flag `wx`.
   2. Apply the DACL.
   3. Write the content and fsync it.
   4. Rename it into place.
   If the rename fails with `EPERM`, `EBUSY` or `EACCES`, the tool MUST retry with backoff for up to about one second, because antivirus and indexers hold files open briefly.
4. Before any content is read, the tool MUST check that the file is a regular file and is not a symlink, junction or other reparse point.
5. When the DACL itself is verified `[D6]`: ordinary commands do not verify it, and `auth status` and `doctor` do.
   Reading a DACL needs a PowerShell or `icacls` process, which costs a few hundred milliseconds or more per invocation.

### 4.3 Both platforms

1. When a check fails, the tool MUST raise `CONFIG_INSECURE`.
   The error names the path and the platform's fix (`chmod 600 <path>`, or re-running the tool's write on Windows) and never echoes the content.
2. Each tool keeps these rules in one private-file module.
   That module takes the platform and the ACL function as injectable parameters, as artium-axi's [`SessionStore`](../src/cli/session.ts) does, so tests can run both branches on Linux.
3. Before a release, at least one real Windows run of `auth status` and of a config write SHOULD happen.
4. `axi-sdk-js` is third-party (kunchenguid/axi), so the module lives in each tool.
   The TypeScript falcon-axi runtime uses its own private-file module.

## 5. Precedence

1. The config file is chosen in this order: `--config`, then `P_CONFIG`, then the section 1 default.
2. The profile is chosen in this order, stopping at the first match:
   1. `--profile`.
   2. `P_PROFILE`.
   3. The env profile, which is used when every required `P_<FIELD>` of the tool is set.
   4. `defaultProfile`.
   5. The only profile, when the file defines exactly one.
   6. Otherwise, an error: `PROFILE_REQUIRED` when there are no profiles, or `PROFILE_AMBIGUOUS` when there are several.
3. Within the selected profile, a non-secret flag overrides the profile field, and the profile field overrides the built-in default.
4. Secrets MUST NOT be accepted from flags or argv.
   Flag names that look like secrets MUST be refused.
5. Sources never mix:
   - A profile selected from the file ignores the `P_<FIELD>` variables.
   - An env profile that is only partly set, for example an id without its secret, is an error.

## 6. Secret storage

1. By default a tool MUST NOT store secrets.
   Secrets arrive through SecretRefs.
2. A tool whose upstream issues credentials MAY implement `auth login` and `auth logout`.
   Today that means awx-axi, which mints a PAT, and mg-axi, which holds a delegated MSAL cache.
   A login MUST:
   - store the result against `{"stored": true}`, keyed by profile name;
   - bind the stored result to the profile's `origin`, or to its `tenantId` and `clientId`;
   - refuse to use the stored result when the profile's binding no longer matches.
3. Storage backend `[D3]`: `credentials.json` in the state dir, protected by section 4.
   This is the same on Windows and Linux.
   The OS keyring is not used, for three reasons:
   - Windows Credential Manager limits an entry to 2560 bytes, which is smaller than an MSAL cache.
   - Headless Linux, WSL and containers have no Secret Service.
   - mg-axi shows both failures, falling back to session-only logins (`src/msal-provider.ts:17-18, 40-47`).
   `auth status` reports the path of the stored credential.
4. `auth logout` MUST revoke the credential upstream where the API allows it, then delete it locally.
5. Access tokens MUST be cached in memory only.

## 7. Commands

1. Every tool MUST implement these:
   - `auth status`: shows the selected profile, the endpoint, and where each secret came from (flag, env name, file path, or stored).
     It shows a cheap identity when one is available, and never a secret value.
   - `profile list`.
   - `config path`.
2. A tool that has a live check keeps `doctor` as its one bounded live read.
3. `auth login` and `auth logout` exist only under section 6.
   mg-axi's top-level `login` becomes `auth login`, with the old verb kept as an alias under the [compatibility policy](../CONTRIBUTING.md#compatibility-policy).
4. No command prompts unless it is `auth login`.
   No command opens a browser unless it is `auth login`.

## 8. Redaction

1. Every resolved secret MUST be registered in an exact-value redactor, in each of these forms:
   - raw;
   - JSON-escaped;
   - URL-encoded;
   - the Basic-auth base64 form, where the tool uses Basic auth;
   - every access or refresh token the tool mints.
2. The redactor MUST be applied to stdout, stderr, error messages and journals.
   The reference implementation is vectra-axi `src/redact.ts`.
3. Payloads returned by the upstream service additionally get key-name and value-pattern redaction (JWT, PEM, SAS, `AccountKey=`).

## 9. Hosted contract (artium-axi)

The artium-axi runner is a Linux container, so the host side below follows the Linux rules.

A tool that follows sections 1-8 is *hosted-safe* when it also guarantees the following:

1. It ships `axi-credential.schema.json` in its package.
   The file is the JSON Schema of one profile, and every secret field carries `"x-secret": true`.
2. It reads only `HOME`, the XDG dirs, `TMPDIR` and files named by a SecretRef.
   It writes only its state dir and `TMPDIR`.
3. It never prompts, opens a browser or persists tokens outside `auth login`.
4. It reports failures with stable error codes: `AUTH_REQUIRED`, `CONFIG_INVALID`, `CONFIG_INSECURE`, `CONFIG_MOVED`, `PROFILE_REQUIRED`, `PROFILE_AMBIGUOUS` and `PROFILE_NOT_FOUND`.
5. It MAY accept a pre-acquired bearer token as an auth kind, `auth: "token"`, so that a host can broker tokens.
   artium-axi already does this for az-axi.

For each call, the host:

1. Provides a private, empty `HOME` and XDG dirs.
   The implementation is in [runner.ts](../src/server/runner/runner.ts).
2. Writes `$XDG_CONFIG_HOME/<tool>/config.json` containing exactly one profile, named `artium`, which is also the `defaultProfile`.
   Tenable instead selects a stable private configuration through `TENABLE_AXI_CONFIG`; see [journal and profile custody](runbook.md#retention-and-export).
   Kubernetes mutation workflows select a private per-call profile through `KUBERNETES_AXI_CONFIG` beside persistent request state; see [request custody and retention](runbook.md#retention-and-export).
3. Replaces each `x-secret` field with `{"env": "ARTIUM_SECRET_<n>"}` and passes the values through the environment.
4. Adds every secret value to its output scanner.
5. Sets `P_READ_ONLY` and `P_WRITE_LOG` according to its own policy for tools with native write gates.
   LDAP is read-only by design and needs neither setting nor a write journal.
   AWX receives `AWX_AXI_READ_ONLY` without a write-log override; see [host audit classification](admin-guide.md#audit-screen-and-api).

The shared profile writer owns schema validation and secret injection.
Per-tool policy covers the inventory, blocked commands and flags, and hosted restrictions on credential inputs in [credential-profile.ts](../src/server/adapters/credential-profile.ts).

Credential instances do not change this contract.
An Artium tool can hold several named instances, but each call resolves exactly one and the host writes exactly one profile named `artium` for it, so the per-call rules above, the profile schema and secret injection are unchanged.
The instance name, description, enabled flag and read-only flag are host metadata kept outside the encrypted profile, and a tool never sees them.
A tool package needs no change to be used with more than one instance.

### Opt-in connection-lifetime amendment

Status: APPROVED for the explicitly admitted SSH integration only, with the release-at-close requirement below and a deterministic regression proving that release through the public lifecycle or real process boundary.
The separate amendment and custody conformance checks were merged in [PR #257](https://github.com/knowttl/artium-axi/pull/257), commit `458ee4d7e53daf3f01b4b6c91f75331841e0ad16`; that amendment alone did not authorize production admission.
Section 9's agreed per-call behavior remains the default.
The SSH owner decision grants no automatic admission to other tools.
A design depending on this extension MUST NOT be labelled fully conformant until its implementation meets the approval conditions and passes conformance.

Only an admitted tool whose reviewed host integration explicitly declares a connection-lifetime requirement MAY request this extension.
Command arguments, credentials, environment variables and possession of a connection handle MUST NOT enable it.
The host MUST authorize each connection for its authenticated caller and selected credential before creating its worker.
The extension changes only the lifetime of the private profile and SecretRefs: they MAY remain available until that connection closes, across commands on that connection.
It grants no additional tool, credential, host, account or command authority.

For each connection, the host MUST:

1. Supervise one worker with a private, initially empty HOME, XDG directories and temporary directory, isolated from every other connection.
   The shared profile writer MUST validate the selected credential against the tool's shipped schema and write exactly one profile named `artium`, also the `defaultProfile`.
   It MUST substitute `ARTIUM_SECRET_<n>` environment references for secret fields and register every resolved value for output scanning.
2. Construct the worker environment from only that selected credential, trusted runtime settings and its private inherited IPC handle.
   It MUST NOT inherit ambient SSH agents, unrelated credentials or developer configuration, and MUST NOT fall back to them when the selected credential is absent or invalid.
   No public worker listener or caller-controlled credential override is authorized by this extension.
3. Keep known-secret redaction data available for the entire worker lifetime, including idle intervals and later commands.
   The worker MUST apply section 8 and the parent MUST scan output before any persistence or delivery, including stdout, stderr and failure paths.
   Releasing private-key buffers after authentication where supported MUST NOT remove known-secret output protection.
   Memory release is best effort, never a secure-erasure guarantee.
4. On connection close, revoke further dispatch, terminate the worker and remove all its private directories and profile files before reporting local cleanup complete.
   Known-secret scanning MUST remain available until the worker has terminated; then the parent MUST release secret-derived scanner buffers, event listeners, the child reference and other retained resources before reporting cleanup complete.
   Only metadata needed for owner inspection and idempotent close MAY remain; memory release is best effort, never a secure-erasure guarantee.
   The same cleanup MUST run after explicit close, idle or hard expiry, authentication or worker failure, forced termination, shutdown and authorization, trust or grant changes, including early failure and repeated close.
   Server restart recovery MUST remove abandoned worker directories before admitting new work; connections MUST NOT survive a server restart or be silently reconnected.
5. Recheck current authorization and selected credential and host-trust revisions before dispatch.
   Revoking the extension declaration or tool admission, removing caller access, invalidating the caller's session, disabling the host, or changing the selected credential or host trust MUST fence further dispatch and close affected connections through the same termination and cleanup path.
   Queued work MUST be discarded and active work cancelled before revocation is acknowledged; an unresponsive worker MUST be terminated.
   Already dispatched remote work can have an uncertain outcome; revocation does not promise reversal or secure erasure.

The [credential-profile conformance tests](../src/server/adapters/credential-profile-lifetime.test.ts) exercise the shared writer and real runner with a synthetic multi-command worker and no network.
They cover profile and SecretRef reuse until close, private paths and selected-credential isolation, cleanup after close and worker crash, abandoned-profile removal before restart admission, and parent canary scanning on early and later commands.
These checks establish custody primitives only: they do not implement or establish production connection admission, private IPC authorization, revocation fencing, or packaged ssh-axi conformance.
An opting-in integration MUST additionally verify those behaviors, including ownership isolation and targeted revocation without closing another caller's connection, before claiming conformance.

### Proxmox memory authentication and protected-result amendment

Status: APPROVED by the owner on 2026-11-03 for the admitted Proxmox integration.
The default per-call private HOME, XDG directories, profile writer and SecretRef rules remain unchanged.
This amendment authorizes no persistent Proxmox worker and does not extend the SSH connection-lifetime approval.

1. An administrator stores one Proxmox credential in the existing protected managed credential profile: a PVE API token, which is preferred, or a username and password.
   Secret storage retains mode 0600 and the existing SecretRef and shared profile-writer boundaries.
   Callers supply no authentication credentials, endpoint, profile or host state through arguments or ambient environment variables.
2. Authorized Artium users need no separate Proxmox sign-in step.
   API tokens authenticate each call directly.
   For a stored username and password, Artium signs in automatically on first use and reacquires automatically after expiry.
   API-token failures never fall back to password, ticket or another identity.
   TFA-enabled accounts cannot use automatic password sign-in; challenge responses are discarded and the administrator is directed to an API token.
3. Only issued ready tickets and CSRF values may be cached in server-process memory, for at most five minutes after acquisition, with at most four sessions per authenticated user and sixty-four server-wide.
   Delegated families share the creator's capacity and may occupy at most two pending or cached sessions in total.
   The stored password remains in the managed credential profile; resolved passwords and other caller-input secrets are never retained beyond their call or written alongside tickets.
   Tickets and CSRF values are never persisted to profiles, files, databases, disk caches, journals, backups or keyrings and do not survive server restart.
4. Cached state binds the authenticated user, sign-in family, selected credential ID and revision, PVE HTTPS origin, PVE identity and host-trust revision.
   Only host-selected state with fresh authorization and binding checks may supplement the selected per-call profile.
   Session identifiers grant no bearer authority, and no new SecretRef kind is introduced.
   Authentication grants no write permission; existing native operation grants, administrator write settings and native confirmation remain required.
5. Native S4 protected results use a pre-established inherited private pipe or socket, with no native output-file fallback.
   Before accepting a result, the host validates the frame version, 65536-byte JSON payload bound and expected origin, identity, operation, request, actor and credential-revision bindings.
   Protected bytes may enter only the existing process-memory result channel, retaining its five-minute lifetime, four results per user, sixteen globally and single-use retrieval.
   Retrieval requires the same user, sign-in family, operation and credential revision, with current tool, credential and trust authorization.
   The CLI validates its private writable destination before retrieval and delivers bytes only there.
   Broken or uncertain delivery never triggers automatic mutation replay or result recreation.
6. Resolved inputs and retained or minted credentials and protected values are registered for output scanning before any public delivery or persistence.
   Routine command output, stdout, stderr, audit and journals contain only safe metadata and opaque result references.
   Known-secret protection remains available until every dependent active call settles, including failure and cancellation.
   The published structured-protocol distinction between generated metadata and provider values still applies.
7. Cancellation, expiry, authentication failure, relevant authorization or trust revocation, credential revision changes, sign-in-family invalidation and shutdown fence further use and release affected retained state.
   Queued affected calls are discarded and active affected calls cancelled or terminated before relevant revocation is acknowledged.
   Cleanup releases timers, buffers, listeners and references after dependent calls settle; release is best effort and is not a secure-erasure guarantee.
   Restart begins with no retained authentication sessions or protected results and removes abandoned per-call private directories before admission.
   Already dispatched remote work can have an uncertain outcome; cleanup does not promise reversal.
8. Production admission requires synthetic conformance for automatic acquisition and expiry, TFA refusal, caller/family and credential/trust isolation, absence of fallback, capacity, private framing and single-use retrieval, secrecy, targeted revocation of idle and active state, failure cleanup and restart without retained credentials.
   This amendment alone does not establish implementation conformance or live appliance commissioning.

The managed Proxmox S5 routes preserve this credential custody: they add no authentication kind, additional password retention or persistent provider worker.
Genuine duplex setup frames may be validated and committed to the existing one-shot memory store while their owning operation remains active, so the caller can complete its inner protocol.
The S4 frame size and six native binding checks remain unchanged, and minted setup values are registered before provider text can be released.
SPICE configuration is a different native representation: exact raw text bytes, never a fabricated S4 JSON frame.
The host accepts it only from its selected SPICE operation, checks native completion, byte count and SHA-256, and registers configuration values before accepting public metadata.
It uses the existing result store's 4 MiB bound, five-minute lifetime, four-per-user/sixteen-global capacity, current caller/family/credential/trust checks and one-shot retrieval, delivering only to the caller's validated private byte destination.
Opaque console and migration messages stay on the active private byte channel, are never text-redacted or persisted, and are fenced with the owning native call.

### Per-tool host-facing schemas

The Falcon adapter uses the pinned TypeScript credential schema and Artium's private profile writer.
Client ID, client-secret SecretRef, region and optional member CID come from the stored profile.
The shared profile writer removes host-owned `allowWrites` and `writes` from the upstream profile while preserving `rtr` settings.
The host sets `FALCON_AXI_READ_ONLY=true` for reads and RTR previews, and `false` for administrator-authorized write calls.
Unauthorized write calls are refused before retrieving credentials.
See the [Falcon capability boundary](safety.md#write-gates-by-tool) for administrator grants and native execution gates.
The [Falcon inventory](../tools/inventories/falcon-axi.json) owns the blocked local configuration commands and credential overrides.

mg-axi keeps the `mode` field.
For `mode: "application"`, `auth` is `certificate`, `client-secret` or `federated`.
Those kinds use the SecretRef fields `privateKey`, `clientSecret` or `token`, respectively.
Certificate profiles use `thumbprintSha256` as defined in section 3.6.
For delegated login, `token` is the marker `{"stored": true}`.
The delegated token itself lives in the protected state-directory `credentials.json` under section 6 (`[D3]`), never inline in the profile.
These mg-axi schema details were approved separately during implementation.
The host derives fields and secret injection from the shipped schema, including `mode`, without translating auth-kind names.

az-axi uses the flat SecretRef fields `armToken`, `logsToken`, `graphToken`, `storageToken`, `vaultToken` and `registryToken`.
Ambient `az login` works without a config file; `auth: "az"` is the ambient kind.
`tenantId` replaces `tenant`, with `AZ_AXI_TENANT` retained as a deprecated alias for one release.
The env profile uses `auth: "az"` when `AZ_AXI_TENANT_ID` is set, or `auth: "token"` when `AZ_AXI_ARM_TOKEN` is set.
Mixed or partial env sources are rejected.
Legacy `tokenEnv` keys are accepted for one release with a deprecation warning.
These az-axi schema details were approved separately during implementation.

The generated [LDAP inventory](../tools/inventories/ldap-axi.json) includes the shipped credential schema; [credential-profile.ts](../src/server/adapters/credential-profile.ts) owns its hosted input restrictions and CA materialization.
See [LDAP credential setup](tool-credentials.md#ldap) for the authentication choice, required inputs and multi-line private CA editor.

gh-axi is also a third-party tool bundled without upstream modifications.
Its [host adapter](../src/server/adapters/gh.ts) owns the inline PAT, device-flow OAuth and GitHub App installation profiles.
Device credentials are minted only through the admin Connect with GitHub flow; the host adapter owns their secret fields and the [admin boundary](../src/server/admin/tools.ts) owns public metadata.
It injects only `GH_TOKEN` or `GH_ENTERPRISE_TOKEN`, with managed `GH_HOST`, into the isolated process.
There is no upstream profile file; the [supported GitHub boundary](safety.md) owns operation restrictions.
See the [GitHub certificate trust exception](runbook.md#trusting-one-tool-from-the-administration-ui) for Go TLS handling.
See [GitHub setup](tool-credentials.md#github) for authentication, device-flow scopes and token lifecycle, token caching and key rotation.

ado-axi uses the [pinned fork](tool-credentials.md#azure-devops) and retains a non-standard credential profile.
The [host adapter](../src/server/adapters/ado.ts) owns its credential schema.
It uses the shared credential editor and input normalization, but prepares its upstream profile itself instead of using the shared profile writer.
Each isolated call receives `ADO_AXI_CONFIG` pointing to a private profile file.
PAT calls use `auth: "pat"` and `patEnv: "ARTIUM_SECRET_0"`; the PAT and its Basic authentication encoding are registered for redaction.
Client-secret calls use `auth: "az"` without a tenant field and a restricted Artium-owned `az` stand-in on the per-call PATH.
The shared Azure token cache acquires the DevOps audience token; the client secret and minted token are registered for redaction.
See [Azure DevOps setup and supported boundaries](tool-credentials.md#azure-devops) for managed access and [audit action classification](admin-guide.md#audit-screen-and-api) for host journaling.

awx-axi uses its shipped token SecretRef schema without an authentication-kind translation.
Usable credentials require `origin` and `token`; the host restricts origins to HTTPS and excludes upstream HTTP and TLS-verification bypass settings.
An administrator can paste a personal access token or sign in once with a username and password.
Follow the [runbook password sign-in flow](runbook.md#roles-credentials-and-health).
Password sign-in sends one HTTPS POST to `/api/v2/tokens/` with basic authentication, asks for description `awx-axi` and scope `write`, and stores only the returned token.
The password is discarded, never written to the credential or logs, and registered for output redaction while it is in memory.
Later calls use Bearer authentication only.
An HTTP 401 during token acquisition returns `UPSTREAM_AUTH_FAILED` and stores nothing from that attempt.
The error advises checking the credentials and controller authentication configuration, with an existing personal access token as an alternative.
A Bearer-only challenge does not establish that Basic authentication is disabled; the credentials may be incorrect or the authentication configuration may not support password sign-in.
The shared profile writer injects the token and registers it for output scanning.
Artium removes host-owned write controls from the upstream profile.
See the [AWX write boundary](safety.md#write-gates-by-tool) for authorization and native gates, and [AWX setup](tool-credentials.md#awx) for credential setup.

tenable-axi uses its shipped accessKey and secretKey SecretRef schema with a fixed `https://cloud.tenable.com` origin.
Artium requires both keys, treats both as secrets and supplies a private profile for each call.
The per-tool write switch maps to `writes.allowWrites` and `writes.operations`; disabling writes sets `TENABLE_AXI_READ_ONLY=true`.
Native preview, exact confirmation, operation scope and durable journaling also gate export-job creation.
See [Tenable One setup](tool-credentials.md#tenable-one) for the supported boundary.

hybrid-axi uses its shipped apiKey SecretRef schema and the fixed `https://hybrid-analysis.com` origin.
Artium requires one secret API key, injects it through an environment SecretRef and keeps native writes disabled unless the administrator enables named operations.
Native preview, execute, exact confirmation and durable journaling remain required.
See [Hybrid Analysis setup](tool-credentials.md#hybrid-analysis) for credential setup and key-level failures, and the [capability boundary](safety.md) for supported operations.

checkpoint-axi uses its shipped clientSecret SecretRef schema, mandatory region/client ID and the fixed regional map in its reviewed inventory.
Artium requires a client secret explicitly and injects it only in the child environment through a private config reference.
Native write settings retain exact operation IDs; download enablement is scoped to an authenticated hosted transfer and its host-owned confirmation, never an ordinary tool run.
See [Check Point setup](tool-credentials.md#check-point-email-security) for commissioning and capability boundaries.

## 10. Migration

The per-tool migration and suggested order are in [credential-migration.md](credential-migration.md), section "Migration path per tool".

Scope rule, from the owner in round 3: az-axi changes are made only in knowttl/az-axi.
This standard proposes no change to either of the following:
- ado-axi (jeffreyhaen/ado-axi), the upstream project that az-axi vendors files from; Artium's package selection is documented in [Azure DevOps setup](tool-credentials.md#azure-devops).
- The Microsoft `az` CLI, whose `az login` session in `~/.azure` stays the ambient source for `auth: "az"`.
az-axi edits that touch vendored files, such as `src/lib/config.ts` and `src/lib/auth.ts`, update those files' "Local changes" rows in `UPSTREAM.md` in the same commit.
This is az-axi's own rule (`UPSTREAM.md:5`).
