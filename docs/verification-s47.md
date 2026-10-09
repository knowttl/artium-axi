# S47 backup, restore and rollback

T7.2 adds `artium-axi-server backup --out <path>` and `restore --from <path>`.
The [runbook](runbook.md#backup-restore-and-upgrade-rollback) owns operational instructions, retention and the outstanding owner decision on separate master-key escrow.
No escrow vendor or location is selected.

The real SQLite tests in [backup.test.ts](../src/server/store/backup.test.ts) exercise backup while a live maintenance owner commits paired credential and tool revisions.
The resulting owner-only snapshot passes SQLite integrity and foreign-key checks and preserves consistent revisions and retained audit rows.
Existing output files are preserved on refusal.
Restore tests preserve encrypted credentials and role grants, reject saved access, refresh, password-change and browser proofs, and permit a newly issued login.
The access token is revoked on the source after the backup, proving that restore cannot revive that later-revoked token.
Wrong keys, damaged credentials, unknown migrations, missing tables, foreign-key violations, corrupt files, a running destination and nonempty volumes fail without publishing a database.
Public CLI subprocesses exercise backup, restore, receipts and unknown-flag rejection.

A migration rehearsal restores a copy, applies a synthetic version-012 schema change through the real migrator and confirms that the version-011 image refuses that newer schema.
Rollback restores the pre-upgrade backup into another empty directory and verifies the old schema and retained roles.
The original source store remains on version 011.
This proves local migration and database rollback mechanics; it does not establish acceptance for an unspecified future production migration.

`pnpm test:containers` includes [backup-probe.mjs](../test/fake-service/backup-probe.mjs) after building the pinned production image.
It invokes the public maintenance CLI under UID 10001 with a read-only root and no network, first taking a backup and revoking a token afterwards.
A separate container mounts the backup read-only and restores into a different empty volume with the same synthetic key.
The probe checks credential decryption, role grants, retained audit, fresh token issuance, rejection of the old token and database mode 0600.
The harness removes both containers and volumes before removing its images and private BuildKit worker.
Its `container-inputs`, `container-command` and `container-evidence` records identify the head, input/output digests, image identities, timings and cleanup for the tested candidate.

All evidence uses fakes, synthetic accounts and canary credentials.
Real recovery, escrow custody and live deployment remain owner acceptance.
