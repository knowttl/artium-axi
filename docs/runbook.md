# Operations runbook

## First administrator and offline recovery

Use the first-start settings described in [README.md](../README.md).
The username is trimmed and lowercased for lookup, must be nonempty without whitespace or control characters, and keeps the entered spelling as its display name.
The canonical name `synthetic-development-user` remains reserved and cannot be used for bootstrap or recovery.
Use the local password rules in [README.md](../README.md).
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
   Use the online backup command below before rotation.
2. Mount the same data volume and both raw 32-byte key files in a one-shot container using the same application image.
   The new key must differ from the old key, and both files must be readable by the container's runtime UID.
   Set `ARTIUM_AXI_MASTER_KEY_FILE` to the old key file.
   Set `ARTIUM_AXI_DATABASE_FILE` if the store differs from `/data/artium.db`.
3. Run the maintenance command.
   It authenticates existing rows and commits every re-encrypted row, the active store key ID, a key-ID receipt and an audit event in one transaction.
4. Save the printed key-ID receipt, switch the server's mounted startup key to the new key and restart.
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
A successful migration alone is insufficient acceptance for an upgrade.
Retain the pre-upgrade backup and previous image until the upgrade is accepted and its recovery window expires.
If migration or acceptance fails, stop the candidate, restore the pre-upgrade backup into another empty volume using the previous image and matching key, verify it, then start that previous image on the restored volume.
Rollback loses changes made since the pre-upgrade backup; keep the failed-upgrade volume for investigation until the owner approves its disposal.
Never run an old image against the upgraded volume.
Startup refuses migration versions unknown to its image with `STORE_SCHEMA_INVALID`.

The owner still decides the master-key escrow vendor, location, access policy and recovery custody.
Keep escrow separate from database backups and retain every required old key until its last backup expires.
This implementation selects no escrow destination.
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
