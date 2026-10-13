# Operations runbook

## Scope and prerequisites

This runbook covers local operation of the packaged server and client.
Exercise changes first in disposable Linux stores with synthetic identities, canary credentials and fake upstream services.
Live host provisioning, proxy deployment, client installation and live adapter acceptance belong to the owner and have not been exercised here.
The local rehearsal and its limitations are recorded in [S49 verification](verification-s49.md).
The [README](../README.md), [Dockerfile](../Dockerfile), [Compose example](../compose.example.yaml) and [server configuration](../src/server/config.ts) own installation, packaging and executable defaults.

The Linux deployment host needs Docker with Compose, space for persistent SQLite data and protected backups, and a trusted HTTPS reverse proxy.
Use the pinned image inputs and record the resulting immutable image identity for recovery; do not treat the mutable `artium-axi:local` tag as a rollback identity.
The image runs as UID 10001 with a read-only root filesystem, writable `/data`, and a 256 MiB `/tmp` tmpfs.
The Compose example sets a 6 GiB memory limit, 192-process limit and an init process.
Provision data directories for that UID with mode 0700 and key files readable only by the intended runtime and owner.
The Compose example mounts the initial master-key file read-only.
Non-swarm Compose file secrets retain host ownership, so mode-0600 files owned by the operator are not readable by the image's UID 10001.
After preparing the master-key file and exact bootstrap-password file, make both readable by that UID on a standard rootful Docker host:

```sh
sudo chown 10001:10001 ./private/artium_master_key ./private/artium_bootstrap_password
sudo chmod 600 ./private/artium_master_key ./private/artium_bootstrap_password
```

The bootstrap file contains UTF-8 password bytes with no added newline; the master-key file contains exactly 32 raw bytes.
Keep their host directory protected and retain operator access through the approved privileged account.
For rootless Docker or user-namespace remapping, use the mapped host UID corresponding to container UID 10001.
See [master-key custody](#backup-restore-and-upgrade-rollback) for key formats and the saved local copy.
The owner decides key creation; the synthetic key used in rehearsal is not a production provisioning recommendation.

For source-based local rehearsal, use Node >=22.12.0, pnpm 10.22.0, OpenSSL, Python 3, curl and sha256sum on Linux.
From the repository root, run:

```sh
pnpm install --frozen-lockfile
pnpm check
docker compose -f compose.example.yaml config --quiet
pnpm test:containers
```

The Compose validation creates no stack and reads no secret contents.
Container acceptance uses only task-owned fake networks, stores and images and removes them before returning.
Check the [container-test prerequisites](../README.md#development--testing) before running `pnpm test:containers`; arrange verification on a permitted host when local container acceptance is unverified.
Do not use real adapter credentials or globally prune Docker resources.

## Proxy and certificate trust

The packaged API listens on HTTP port 8080 and the Compose example publishes it only on host loopback.
Terminate HTTPS at the owner's proxy and prevent clients from reaching the HTTP listener directly.
Replace incoming forwarding headers, rather than appending to untrusted client values.
Set `ARTIUM_AXI_TRUSTED_PROXIES` to the verified proxy source IP addresses as seen by the server, separated by commas; the default trusts none.
Keep the external origin consistent for browser forms and forward the original HTTPS scheme correctly.
Verify certificate hostname, expiry and full chain before switching traffic.
Proxy installation, firewall configuration, production forwarding-header verification and certificate renewal remain unexercised owner steps.

For a containerized nginx proxy, an owner-configured override can use this static source IP and wait for the example's readiness healthcheck.
Select an unused subnet and update both the proxy address and trusted-proxy setting together.
Use an approved nginx image digest in place of the placeholder and provision the mounted certificate, key and configuration first.

```yaml
services:
  artium:
    environment:
      ARTIUM_AXI_TRUSTED_PROXIES: 172.30.88.10
  proxy:
    image: <approved-nginx-image-digest>
    ports:
      - "443:443"
    depends_on:
      artium:
        condition: service_healthy
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
      - ./tls:/etc/nginx/tls:ro
    networks:
      default:
        ipv4_address: 172.30.88.10
networks:
  default:
    ipam:
      config:
        - subnet: 172.30.88.0/24
```

The corresponding `nginx.conf` replaces client forwarding headers with the proxy's own values:

```nginx
server {
    listen 443 ssl;
    server_name artium.example.test;
    ssl_certificate /etc/nginx/tls/server.crt;
    ssl_certificate_key /etc/nginx/tls/server.key;
    client_max_body_size 16m;
    location / {
        proxy_pass http://artium:8080;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header Forwarded "";
        proxy_set_header X-Forwarded-Port "";
    }
}
```

Replace the synthetic hostname with the certificate's trusted hostname.
The static proxy IP survives recreates; do not trust the whole Docker subnet.
The health dependency waits during initial startup and does not promise uninterrupted traffic during later recreates.

Set `ARTIUM_AXI_URL` to the trusted HTTPS base URL without credentials, query or fragment.
For a private CA, use curl's `--cacert` on both downloads and set `ARTIUM_AXI_CA_FILE` to the readable PEM CA file for the CLI.
Never bypass certificate verification.
The checksum comes from the same trusted server and detects corruption or mixed releases; it does not establish trust in an unknown server.

## CLI launchers and password changes

Follow the [Linux download and launcher installation](../README.md#download-and-first-call), including both downloads and checksum verification before executing the bundle.
Keep Node on PATH and retain the installed launcher path; rerun setup if the bundle moves.
With that installation and trust configured, the following commands are the local operator checks:

```sh
artium-axi setup --host claude --hook
artium-axi setup --host codex
artium-axi setup --host opencode
artium-axi login --username synthetic-admin --password-stdin
artium-axi passwd --password-stdin
artium-axi login --username synthetic-admin --password-stdin
artium-axi whoami
artium-axi tools
# Requires an enabled Falcon tool granted through a role:
artium-axi tools show falcon-axi
artium-axi doctor
artium-axi logout
```

Supply passwords through stdin or the hidden terminal prompt, never command arguments.
The first login with a temporary password intentionally returns `PASSWORD_CHANGE_REQUIRED` and exit 1.
Change the password, then log in again; a password change revokes existing sessions.
For an ordinary password change, confirm the current password through the hidden prompt or `ARTIUM_AXI_CURRENT_PASSWORD`, and supply the new password on stdin or at the prompt.
Clear temporary password environment values after use.
Browser users sign in at `/login`, change temporary passwords at `/password`, and sign in again.
Ordinary users can change their password at `/account`.
The implementation's current password validation is documented in the README; this runbook does not decide or waive the owner's Password and Secrets Standard.

Setup writes an embedded skill and, for Claude only, an optional SessionStart hook.
Local Linux file generation is verified; actual agent loading and hook usefulness, Windows/macOS launchers and live client trust remain unexercised owner acceptance.
CLI tokens are private local files bound to the server URL; do not export or share the session file.
After `SESSION_BUSY`, remove the session lock directory only after all CLI processes using it have exited.
An uncertain network outcome is never retried automatically; inspect audit and platform state before deciding whether to repeat a call.

## Scripted administrator sessions

There is no dedicated administrator CLI.
Scripts use the JSON API over the same trusted HTTPS origin; see the [shared contracts](../src/shared/api.ts) for route bodies and revision fields.
Start with `POST /v1/auth/login`, with JSON `{ "username": "synthetic-admin", "password": "<password>" }` supplied from protected stdin or a protected file, never command arguments.
Require an `authenticated` response; a `password-change-required` response must complete the password-change flow first.
Keep the returned `accessToken` and `refreshToken` private and out of logs.
Then send `POST /v1/auth/reauth` with `Authorization: Bearer <accessToken>` and JSON `{ "password": "<password>" }` from the same protected input source.
The response contains `ticket` and `expiresAt` (Unix milliseconds).
Send both `Authorization: Bearer <accessToken>` and `x-artium-reauth-ticket: <ticket>` on every `/v1/admin/...` request, including reads such as `GET /v1/admin/users` and `GET /v1/admin/audit`.
With curl, provide sensitive headers through a protected configuration file or stdin with `--config -`, rather than command arguments.
Bearer sessions do not use browser CSRF tokens.

The ticket is bound to the login session family and lasts 15 minutes; on `REAUTH_REQUIRED`, obtain a new ticket with that family's access token.
Access tokens last one hour; `POST /v1/auth/refresh` takes `{ "refreshToken": "<refreshToken>" }` and returns replacement tokens.
Replace both stored tokens atomically and never reuse a consumed refresh token.
The ticket remains usable through a refresh of its own family, but cannot authorize another login session.
At completion, send `POST /v1/auth/logout` with the refresh token as the bearer credential, then discard local tokens, tickets and temporary inputs.
See [authentication limits](../README.md#security-and-acceptance-boundaries) for how successful authentication and failures affect the attempt budgets.

## Roles, credentials and health

Sign in as an administrator through the HTTPS proxy and use `/admin` to create users with temporary passwords.
Use `/admin/roles` to create named roles and replace the fixed tool grants, then assign roles through Users.
Administrator capability is separate from tool grants, and the last enabled administrator cannot be disabled or demoted.
Grant changes apply on the next call, including calls using existing tokens.
Users with no enabled granted tools receive an explanatory empty list.
Review actor, UTC change time and revision before saving; reload stale forms instead of overwriting newer edits.
After 15 minutes without password confirmation, confirm at `/reauth` and submit the action again.

For credential rotation, obtain the replacement through the owner's approved process, then open `/admin/credentials`.
Follow the [credential editor guidance](../README.md#browser-administration) for schema-generated fields and the retained JSON editors.
Replace the complete credential, including all native settings to retain; omitted settings are cleared.
The editor starts blank and never reveals the stored value.
Use “Test credential” at `/admin/credentials` to test the replacement with the fixed harmless read before enabling the tool at `/admin/tools`.
Check cached health and a permitted fake read, then revoke the old upstream credential through the owner's process after acceptance.
Upstream credential issuance and revocation are live-only owner steps and are not exercised here.
Credential replacement advances credential and tool revisions, clears health, and invalidates old Azure resource-token cache entries.
Failure to commit the audit event rolls back the local replacement.
Rotate upstream credentials separately from the offline database master key.
Falcon has no editable native write settings; Vectra writes require the configured allowlist and upstream confirmation.
See [README tool administration](../README.md) for native-settings guidance and the live-results and maintainer-approval requirements before enabling Graph on a running installation.

Check liveness and readiness through the trusted endpoint:

```sh
if [ -n "${ARTIUM_AXI_CA_FILE:-}" ]; then
  set -- --cacert "$ARTIUM_AXI_CA_FILE"
else
  set --
fi
curl --fail "$@" "$ARTIUM_AXI_URL/health/live"
curl --fail "$@" "$ARTIUM_AXI_URL/health/ready"
```

Both return `status: ok` when healthy; readiness returns HTTP 503 when local migration-table access fails.
These checks do not test remote services or reload the key.
Use doctor for the [CLI diagnostics](../README.md#toon-output-behavior), including separate TLS-verification and liveness results and cached tool health.
Background checks run every 15 minutes and after credential/settings replacement, with one check per tool at a time.
Use “Test credential” at `/admin/credentials` for a current check and inspect cached health at `/admin/tools` and safe error codes in Tools and Audit; never log secret values to diagnose a failure.

## Retention and export

SQLite audit retention runs at startup and daily, deleting events strictly older than the captured 90-day cutoff in batches of at most 500.
Each batch commits its count and cutoff with the deletion.
Vectra's durable native intent/outcome logs also have daily 90-day retention, preserving paired entries.
Malformed native journals remain untouched and produce `AUDIT_UNAVAILABLE`; investigate before assuming export is complete.
There is no audit deletion endpoint or general export CLI.
Use `/admin/audit` for filtered review and the paginated `GET /v1/admin/audit` API for retained records, preserving filters with each continuation cursor.
Bearer API reads require a session-bound recent-reauthentication ticket; browser reads require administrator capability.

For continuous export, set `ARTIUM_AXI_AUDIT_STDOUT=1` in the server environment and send its committed JSON-line records, containing exactly the persisted fields, to the owner's protected collector before retention expires.
SQLite remains authoritative if the optional stream fails; monitor collector failures and reconcile retained records through the audit API.
Key-rotation receipts are separate maintenance output, not audit export.
The owner selects collector storage, access, retention and deletion policy; no external collector is configured by this runbook.
See [backup retention](#backup-restore-and-upgrade-rollback) for audit data retained in snapshots.

## First administrator and offline recovery

Use the first-start settings described in [README.md](../README.md).
The username is trimmed and lowercased for lookup, must be nonempty without whitespace or control characters, and keeps the entered spelling as its display name.
The canonical name `synthetic-development-user` remains reserved and cannot be used for bootstrap or recovery.
Use the local password rules in [README.md](../README.md).
For a source-based disposable first start after building, prepare the protected synthetic files and empty data directory, then run from the repository root:

```sh
ARTIUM_AXI_DATABASE_FILE=/absolute/path/copied-data/artium.db \
ARTIUM_AXI_MASTER_KEY_FILE=/absolute/path/synthetic-key \
ARTIUM_AXI_ADMIN_USERNAME=synthetic-admin \
ARTIUM_AXI_ADMIN_PASSWORD_FILE=/absolute/path/bootstrap-password \
pnpm start
```

The production listener is fixed at port 8080; use an isolated environment and stop the process with SIGTERM after rehearsal.
For Compose first start, uncomment the first-start environment block and both bootstrap-password secret entries in [compose.example.yaml](../compose.example.yaml) before creating the service.
Prepare both secret files with the runtime ownership described above.
The master-key secret alone does not bootstrap a fresh store.
The store must be empty except for migrations and the default tool registry, and must never have been bootstrapped.
Startup commits the administrator and one-time marker atomically, with must-change set and no tool grants.
Remove the bootstrap settings after first start.
Later starts ignore both bootstrap settings and never recreate an administrator, even when no enabled administrator remains.
A missing marker with existing account, role, credential, audit, rotation or changed tool data fails with `BOOTSTRAP_INCONSISTENT`.
Restore a consistent bootstrapped store and matching key.
Do not delete data or manufacture a marker to bypass the startup refusal.

The database prevents disabling, demoting or deleting the last enabled administrator.
Offline recovery can restore an existing local account's administrator capability and access, reset its password and clear its lockout.
It sets must-change, revokes every existing CLI token and browser session for the account, and commits a durable audit event in the same transaction.
The event has action `recover-admin`, the account's internal ID as target and no online actor or password data.
The command does not create an account or bootstrap an inconsistent store.

During development, exercise recovery only on a copy of a disposable store with a canary password and key.
Real administrator recovery requires separate approval.
Stop the server, take a consistent backup and retain its matching master key separately.
After `pnpm build`, run:

```sh
ARTIUM_AXI_DATABASE_FILE=/absolute/path/copied-data/artium.db \
ARTIUM_AXI_MASTER_KEY_FILE=/absolute/path/synthetic-key \
node bin/artium-axi-server recover-admin --username synthetic-admin --password-file /absolute/path/recovery-password
```

For the equivalent stopped-store container command, use the same image, runtime UID and data volume as the server:

```sh
docker run --rm --network none --read-only --tmpfs /tmp \
  --mount type=volume,src=artium-data,dst=/data \
  --mount type=bind,src=/absolute/path/synthetic-key,dst=/run/secrets/artium_master_key,readonly \
  --mount type=bind,src=/absolute/path/recovery-password,dst=/run/secrets/recovery_password,readonly \
  --env ARTIUM_AXI_MASTER_KEY_FILE=/run/secrets/artium_master_key \
  artium-axi:local artium-axi-server recover-admin --username synthetic-admin --password-file /run/secrets/recovery_password
```

Supply an existing local username and readable files, never a password or key value in arguments.
Recovery checks the mounted key against the store's active key ID, authenticates every stored credential and takes the same maintenance lock as the server and rotation.
An unrelated key fails with `MASTER_KEY_INVALID` even if the store has no credentials or rotation history.
An audit failure rolls back the entire recovery.
After success, restart the server, sign in with the recovery password and change it.
Use the CLI or browser sign-in and forced password-change flow in [README.md](../README.md).

## Offline master key rotation

During the build, use only disposable stores and synthetic 32-byte key files.
Production key rotation requires separate approval.

1. Stop the server and take a consistent database backup, including retained audit and account data.
   Protect the backup as sensitive data.
   Keep the matching old master key separately from that backup.
   The online backup command below can also run before stopping; take the final pre-rotation snapshot after admission has stopped.
2. Mount the same data volume and both raw 32-byte key files in a one-shot container using the same application image.
   The new key must differ from the old key, and both files must be readable by the container's runtime UID.
   Set `ARTIUM_AXI_MASTER_KEY_FILE` to the old key file.
   Set `ARTIUM_AXI_DATABASE_FILE` if the store differs from `/data/artium.db`.
3. Run the maintenance command.
   It authenticates existing rows and commits every re-encrypted row, the active store key ID, a key-ID receipt and an audit event in one transaction.
4. Save the printed key-ID receipt, switch the server's mounted startup key to the new key and restart.
   Rotation does not update the saved `.env`; restart with the explicit new key so startup replaces the saved old key before relying on it again.
5. Check every configured adapter before retiring the old key.
   Retain the old key until backups encrypted with it expire.

For an already stopped disposable store, the exact container invocation is:

```sh
docker run --rm --network none --read-only --tmpfs /tmp \
  --mount type=volume,src=artium-data,dst=/data \
  --mount type=bind,src=/absolute/path/old-key,dst=/run/secrets/old_master_key,readonly \
  --mount type=bind,src=/absolute/path/new-key,dst=/run/secrets/new_master_key,readonly \
  --env ARTIUM_AXI_MASTER_KEY_FILE=/run/secrets/old_master_key \
  artium-axi:local artium-axi-server rotate-key --new-key-file /run/secrets/new_master_key
```

Use the same runtime UID and data-volume ownership as the server.
Replace `artium-data` in the invocation with the server's actual volume name; Compose normally prefixes it with the project name.
Replace the bind source paths with the absolute paths of the synthetic key files.
Maintenance does not require development authentication.
For local disposable-store work after `pnpm build`, run `node bin/artium-axi-server rotate-key --new-key-file <path>` with the same database and old-key environment settings.
Only key file paths go in arguments, never key bytes.

The server holds `<database>.maintenance` for its entire lifetime, including shutdown of active calls.
Offline rotation, administrator recovery and restore hold the same SQLite writer lock until they finish.
Online backup does not acquire this lock.
`MAINTENANCE_BUSY` means another server or maintenance process owns the store.
Never remove or replace the lock database to bypass contention.
The operating system releases the lock on process exit or crash.

An interruption before commit leaves the old encrypted rows and previous receipt unchanged.
Restart with the old key.
After commit, restart with the new key, even if no success receipt reached stdout.
The database's `key_rotations` table stores the old and new full SHA-256 key IDs atomically with the credentials.
The `store_metadata` row records the required startup key, and the latest rotation receipt must agree with it.
Inspect it with `SELECT old_key_id, new_key_id FROM key_rotations ORDER BY rowid DESC LIMIT 1` while the server is stopped.
Startup rejects a different key and reports the required key ID, including when no credentials remain.
The durable audit event uses action `rotate-key`, no user identity for offline maintenance, and the new key ID as its target.
Maintenance keeps its receipt output separate from the optional online audit stream.

## Backup, restore and upgrade rollback

After a task-owned image build is no longer needed, remove its built tag with `docker image rm <task-owned-tag>`.
On containerd-snapshotter hosts, build-cache cleanup cannot be scoped to one build by cache ID; removing the built image tag is the scoped cleanup step, although shared cached layers may remain.
Do not use global builder or system prune commands to clean up one build, and retain images still needed for rollback.

After `pnpm build`, run `node bin/artium-axi-server backup --out /absolute/path/protected-backups/pre-upgrade.db` with the source database and matching master-key environment settings.
The backup directory must already exist and be protected from other users.
The command uses SQLite online backup with a pinned read snapshot, so it can run while the server writes, including when the server holds its maintenance lock.
It validates schema, integrity, foreign keys, the active key ID and every encrypted credential before publishing a new mode-0600 file.
It refuses to replace an existing destination.
The backup includes encrypted platform credentials, password hashes, accounts, roles and retained audit data, and must be treated as sensitive data.
Never copy only a live `artium.db` file: committed changes can still be in its WAL.
The master key is never bundled with the backup.
Save the printed full SHA-256 key ID, backup timestamp and the source image digest in a protected recovery inventory.

For a container backup, use the matching image and runtime UID, mount the source volume at `/data`, the protected backup directory at `/backups`, and the matching raw 32-byte key read-only at `/run/secrets/artium_master_key`.
Set `ARTIUM_AXI_MASTER_KEY_FILE=/run/secrets/artium_master_key` and run `artium-axi-server backup --out /backups/pre-upgrade.db` in a one-shot container with `--network none --read-only --tmpfs /tmp`.
The source-volume directory must be writable by the runtime UID because SQLite may need its WAL shared-memory file.
The backup directory must be writable by that UID.

Choose a new, empty data volume, provision it for the same runtime UID with directory mode 0700, and keep its server stopped throughout restore.
Mount the backup read-only and the same matching master key separately.
Set the destination `ARTIUM_AXI_DATABASE_FILE` and run `artium-axi-server restore --from /backups/pre-upgrade.db` using the image matching the backup, with the same isolated one-shot container settings above.
For a local disposable restore, run:

```sh
ARTIUM_AXI_DATABASE_FILE=/absolute/path/new-data/artium.db \
ARTIUM_AXI_MASTER_KEY_FILE=/absolute/path/synthetic-key \
node bin/artium-axi-server restore --from /absolute/path/protected-backups/pre-upgrade.db
```

Restore refuses a running destination or a nonempty destination directory.
The maintenance lock file and its journal are the only permitted existing files; never delete them to bypass a running owner.
Restore validates SQLite integrity, foreign keys, supported migration history, the required key ID and authenticated credentials on a private copy before publication.
It migrates that copy to the restoring image's schema, removes all saved CLI access, refresh and password-change tokens, browser sessions, session families and reauthentication tickets, then publishes a durable mode-0600 database.
Thus even a token revoked after backup cannot authenticate after restore.
The source backup is unchanged.
Start the matching image with the new volume and key, sign in again, and check credentials, roles and retained audit data before switching traffic.
Do not assume a restored login still works.

Before every upgrade, stop the server, take a pre-upgrade backup, and record the previous immutable image digest and matching key ID.
Restore that backup into a separate rehearsal volume using the candidate image and matching key to test its migration before touching the live volume.
Start the candidate only against the rehearsal volume and verify fresh login, credentials, role permissions and audit reads.
When an upgraded tool pin activates its credential schema, stored credentials are not automatically converted.
Replace any incompatible credential through `/admin/credentials` using the current editor before enabling the tool; stored values remain hidden.
A successful migration alone is insufficient acceptance for an upgrade.
Retain the pre-upgrade backup and previous image until the upgrade is accepted and its recovery window expires.
If migration or acceptance fails, stop the candidate, restore the pre-upgrade backup into another empty volume using the previous image and matching key, verify it, then start that previous image on the restored volume.
Rollback loses changes made since the pre-upgrade backup; keep the failed-upgrade volume for investigation until the owner approves its disposal.
Never run an old image against the upgraded volume.
Startup refuses migration versions unknown to its image with `STORE_SCHEMA_INVALID`.

The interim master-key location is an owner-only `.env` in the directory of `ARTIUM_AXI_DATABASE_FILE`; [server configuration](../src/server/config.ts) owns the default database path.
After validating the database key, server startup atomically replaces this file, saving the plaintext key as canonical base64 in `ARTIUM_AXI_MASTER_KEY` with mode 0600 and preserving unrelated settings.
This happens even when the key comes from a mounted secret; the data volume therefore contains both the encrypted database and its decryption key.
Protect access to the whole volume, and do not treat a volume copy as a database-only backup.
Startup fails with `MASTER_KEY_INVALID` if it cannot read or save the key.
`ARTIUM_AXI_MASTER_KEY_FILE` takes precedence and must contain exactly 32 raw bytes; an unreadable configured file never falls back to another source.
Otherwise, `ARTIUM_AXI_MASTER_KEY` must contain canonical base64 for exactly 32 bytes.
When that environment value is unset, the server and maintenance commands read only `ARTIUM_AXI_MASTER_KEY` from the saved `.env`; other settings in that file are not loaded into the process environment.
An empty or invalid explicit environment key fails instead of falling back.
No key is generated or uploaded by this mechanism.
The owner still decides the later vault, access policy and recovery custody.
Keep escrow separate from database backups and retain every required old key until its last backup expires.
The owner must also set the backup schedule, retention window and deletion procedure; database backups retain their captured audit records even after the live store's 90-day audit cleanup.
Remove expired backups under that policy, and retire a key only after all backups requiring it expire.
Without its matching key, a backup cannot recover encrypted platform credentials.
Exercise recovery periodically on isolated copies and record the image digest, required key ID, backup identity and verification results without key bytes or credentials.

## Upgrading stores without a key binding

Follow the [upgrade precautions](#backup-restore-and-upgrade-rollback), but the backup and restore commands require a key-bound store and cannot process an unbound legacy store.
Migration 006 creates store metadata, and opening the store records the supplied key ID only when existing credentials or a rotation receipt provide key evidence.
Every stored credential must authenticate, and the latest rotation receipt must match when present.
Schema migration and binding commit together; refusal rolls back both.
A legacy store with no binding, credentials or rotation receipt cannot establish which key is correct and fails with `MASTER_KEY_INVALID`.
Do not manufacture metadata to bypass that refusal.
For a disposable development store, start a new database with synthetic settings instead.
For a retained store, preserve the backup and use the previous image on its unchanged pre-upgrade volume pending a separately approved migration decision.
