# S11 verification plan

Verification is local and fake-only, with synthetic identities, uploaded bytes and child programs.
No live service, real credential, deployment or destructive maintenance is authorized.
There is no hosted CI.

`pnpm exec vitest run src/shared/api.test.ts src/server/runner/input.test.ts` checks the public schemas and runner input interface.
Schema checks cover the exact argument, UTF-8 stdin, file-count, per-file and aggregate byte boundaries.
They reject unknown fields, NUL text, duplicate names, traversal, absolute paths, malformed base64 and noncanonical padding bits.
Envelope checks preserve completed upstream failures and reject extra fields or mixed success/error output.
Runner tests execute synthetic Node children to read uploaded bytes, inspect directory and file modes, receive maximum-size stdin and observe EOF.
Only adapter-reviewed argument positions are substituted, and server paths or missing uploads are rejected before execution.
Tests cover early child exit without consuming stdin, symlink refusal and cleanup after success, timeout and failed executable lookup.

Run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test`, `pnpm check` and `pnpm test:runner-container` on the final implementation commit.
Run the real private hygiene scan with the external deny list described in [README.md](../README.md), without printing its contents.
The delivery status and PR body bind the exact candidate head to the command results and deny-list digest.
Pipeline source or test changes require renewed final-head validation.
Scan the exact published head again before reporting delivery.

See [README.md](../README.md) for remaining server, adapter and CLI integration work, and [api.ts](../src/shared/api.ts) for the authoritative HTTP body limit.
Captain live acceptance remains unverified.
