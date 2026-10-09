# Interim local master-key file

The [runbook](runbook.md#backup-restore-and-upgrade-rollback) owns interim master-key custody and backup/restore procedures.

The store tests exercise encrypted credential reopen from the saved file, file permissions, replacement of the saved key, preservation of unrelated environment settings, explicit-key precedence and malformed-file refusal.
The real server entry-point test starts with a synthetic key, verifies its owner-only saved file and restarts without an explicit master key.
All checks use synthetic identities and canary keys.
Final pipeline, container, hygiene, head and timing evidence belongs in delivery status.
