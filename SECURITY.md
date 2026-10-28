# Security

Never include passwords, tokens, session files or private service details in public issues or pull requests.
Use synthetic examples and redact sensitive output when describing a problem.

Artium stores shared service credentials on the server and enforces role grants and reviewed command boundaries.
Writes require explicit administrator opt-in and operation-specific gates.
The runner is not a complete sandbox, and the encrypted credential store's plaintext master key is held on the same data volume.

Review [security and acceptance boundaries](docs/admin-guide.md#security-and-acceptance-boundaries), [write gates and storage](docs/safety.md) and [credential handling](docs/tool-credentials.md) before deployment.
Local fake-service tests do not establish live vendor permissions or production host acceptance.
