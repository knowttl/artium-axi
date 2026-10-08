# S08 verification plan

All checks run locally using the fake executable, synthetic data and canary secrets.
No live service, real credential, deployment or destructive maintenance is authorized.
There is no hosted CI.

`pnpm exec vitest run src/server/runner/runner.test.ts` executes the public runner against the fake executable and local synthetic Node programs.
It checks literal shell metacharacters, clean environment overrides, private mode-0700 working directories, concurrent directory isolation and removal of tool-created files.
Linux `/proc/self/stat` verifies the child's process group equals its PID.
Completed calls preserve streams and nonzero exit status.
Every test checks for abandoned call directories, including lookup failure, synchronous spawn failure, signal termination and secret rejection.
Capture tests verify byte counts, draining beyond 4 MiB, independent truncation flags and UTF-8 boundaries.
The scanner integration rejects encoded and split canaries on both streams, including canaries after retention ends, without exposing either stream in the error.

Run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test` and `pnpm check` against the final committed implementation.
Run the real private hygiene scan using the external deny list described in [README.md](../README.md), without printing the list.
Record the exact commit and results in the delivery status and PR body.
Source or test changes during pipeline review require renewed final-head checks.
Scan the exact published head again before reporting delivery.

S09/10 owns timeout, cancellation, descendant cleanup, admission, flood and memory enforcement.
The present detached process group does not claim containment of descendants that create a new session.
Stdin and uploaded inputs arrive in the request-contract slice.
Existing container checks remain documented in README and the evidence ledger.
S08 changes no image recipe, tool pin, native dependency or fake-service network behaviour.
Captain live acceptance remains unverified.
