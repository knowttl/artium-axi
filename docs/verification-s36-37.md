# S36+S37: CLI sign-in and session storage

T4.5 adds `login --username <username>`, `passwd`, `whoami` and `logout` to the standalone bundle.
The [CLI client](../src/cli/http.ts) owns HTTP and the single safe refresh retry.
The [session store](../src/cli/session.ts) owns configuration paths, secure atomic replacement and the local refresh lock.
The [password reader](../src/cli/password.ts) owns stdin, environment and hidden terminal input.
The [shared API](../src/shared/api.ts) owns authentication and identity response shapes.
The [README](../README.md) owns usage, password sources, modes and stale-lock recovery.
The existing AGENTS.md toolchain and README pointers remain correct and need no correction.

All verification uses local fakes, synthetic identities and canary passwords.
No live service, real credential, deployment or hosted CI is involved.

## Contract checks

- `src/cli/session.test.ts` checks POSIX and Windows path selection, Linux mode 0700/0600, atomic inode replacement, URL binding, broad-mode refusal, injected Windows ACL ordering/failure and lock release after a failed action.
- `test/integration/cli-auth.test.ts` starts the real Fastify server with disposable SQLite and synthetic local users, then spawns the standalone bundle without sibling dependencies.
  It checks restricted first login, tool denial until password change and new login, ordinary password verification including expired access, current-role identity, stdin precedence, environment login without prompting, exact password spaces/Unicode, password argument refusal, no password in child argv, no token in output, six concurrent process refreshes, logout after expiry, offline logout and changed-URL refusal.
  POSIX pseudo-terminal checks supply passwords immediately after the login and ordinary password-change prompts and verify that the terminal never echoes them.
- `test/cli-refresh.test.ts` checks exact run request counts and argument preservation for a single safe refresh retry, repeated expiry, malformed refresh, connection loss, service errors and completed upstream failures.
  Uncertain calls are never retried.
  Deterministic concurrent login replacements stop tool, listing, identity and password-change calls without sending requests under the replacement login.
  Refresh retains the persisted `loginGeneration` and reuses concurrent rotations of that same login.
  Password-change checks cover ordinary and restricted sessions on both sides of replacement during password input.
- Bundled login checks accept `-synthetic-user` and usernames equal to option names while still refusing duplicate options.
- `test/cli.test.ts` preserves the HTTPS trust, redirect refusal, server request IDs, passthrough, truncation and bounded stalled-response checks using securely stored sessions.
- The walking-skeleton container journey exercises bundled first login, password change and identity before the existing pinned-upstream fake-service comparisons.

## Final-head validation

Run these against the final implementation commit and repeat after any pipeline source or test fixes.
Bind the exact commit, results and no-mistakes per-step timings to delivery status and the PR body.

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm check
pnpm test:runner-container
pnpm test:walking-skeleton
pnpm test:fake-services
docker compose -f compose.example.yaml config --quiet
ARTIUM_AXI_HYGIENE_DENY_LIST_FILE=<private-absolute-path> pnpm hygiene:check
```

The real hygiene scan covers the candidate tree, generated bundle and all HEAD commit messages using the private external deny list.
Never print or copy its terms.
The no-mistakes run uses local fake-only verification with `--skip ci` because the repository declares `no_ci: true`.
No worker merges the PR.

## Deferred captain evidence

Injected Windows platform and ACL boundaries prove path selection and fail-closed control flow on Linux.
They do not prove PowerShell execution, effective NTFS permissions, antivirus/file replacement behaviour or Windows cross-process locks.
The captain must run first login, ACL inspection, simultaneous expired-session calls, logout and clean installation on actual Windows.
Actual macOS installation and permissions are also pending.
All live and connected-service acceptance remains unverified.
