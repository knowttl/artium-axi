# Interim local master-key file

Server startup saves its validated master key in `.env` beside the configured database, using canonical base64 and owner-only mode 0600.
The key file is an interim location pending a later vault decision.
No vault is selected and no key is generated or uploaded.
The existing backup and restore procedures remain unchanged, with the matching key retained separately from each database backup.

The store tests exercise encrypted credential reopen from the saved file, file permissions, replacement of the saved key, preservation of unrelated environment settings, explicit-key precedence and malformed-file refusal.
The real server entry-point test starts with a synthetic key, verifies its owner-only saved file and restarts without an explicit master key.
All checks use synthetic identities and canary keys.
Final pipeline, container, hygiene, head and timing evidence belongs in delivery status.
