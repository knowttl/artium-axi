# TD-066 file channel and runner contract

The client and server share one named-file channel on authenticated `POST /v1/tools/:tool/run` calls.
The implementation extends the existing bounded `files` transport rather than introducing an upload endpoint or a persistent file store.

1. Resolve the command's accepted file flags from its reviewed inventory, including Graph's fixed hunting and rule upload contract.
2. Read each selected local path with the streaming `inputLimits.fileBytes` cap, replace the argument with a safe leaf name, and send `{name, size, contentBase64}` alongside `args`.
3. Authenticate and check roles, validate the schema and decoded size, and reject every upload without a matching declared command flag before credential preparation or tool execution.
4. Persist an upload audit record containing the authenticated user, tool, redacted command arguments, file name, decoded byte count and server-computed SHA-256.
5. Let the adapter normalize reviewed file arguments and preserve native write gating and confirmation binding.
6. Materialize uploads in the runner's private per-call directory, substitute only adapter-reviewed argument positions, and remove the directory in the runner's `finally` block after success, error or cancellation.

The existing `inputLimits.fileBytes` constant is the authoritative 1 MiB per-file cap on both sides.
Existing request, file-count, aggregate input, output and concurrency limits remain in effect.
The server accepts omitted `size` from older clients but validates every supplied size against decoded bytes.
Files use mode 0600 and private directories use mode 0700.
The original local path and file contents are never audit fields.
Adapters that require stable paths for native confirmation retain their existing private profile upload paths and cleanup ownership.
There is no new stdin forwarding and no ado-axi upload command in this change.

Offline acceptance exercises the real client reader and HTTP client, authenticated server route, adapter parser, runner and audit store with the existing fake executable boundary.
It covers binary bytes, private modes, cleanup on success and tool failure, cancellation, both size checks, non-declaring commands and tools, and audit metadata without payload bytes.
