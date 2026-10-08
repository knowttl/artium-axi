# S09/10 verification

See [README.md](../README.md) for current runner usage and [runner.ts](../src/server/runner/runner.ts) for its public interface.
[config.ts](../src/server/config.ts) owns runner defaults.
[compose.example.yaml](../compose.example.yaml) owns final container resource bounds.
All identities, credentials, tool output and services in these checks are synthetic.

Before implementation, a fake `sleep 80` call supplied with a 1 ms timeout returned exit 0, `timedOut: false`, after approximately 128 ms.
The previous runner did not enforce its supplied timeout.

Run the focused Linux behaviour checks with `pnpm exec vitest run src/server/runner/runner.test.ts src/server/runner/lifecycle.test.ts`.
They cover timeout, cancellation, SIGTERM refusal, SIGKILL escalation, normal leader exit with surviving descendants, direct-child reaping, shutdown, stopped admission and abandoned-directory cleanup without following symlinks.
Directory removal is asserted after every call, including secret detection, spawn failure and signal termination.
They cover immediate third-per-user and ninth-global refusal, continued scanning beyond 4 MiB, stdout/stderr flood rejection at 64 MiB combined, Node heap exhaustion and Python address-space refusal.

F11 remains a measured limitation.
An escaped-session descendant survives group termination in tests, with both ignored and inherited output pipes.
The fixture explicitly terminates that escaped session afterwards.
Closing inherited pipes bounds cancellation completion, but does not contain the escaped process.
Ordinary descendants terminate, and the runner reaps the leader.
On a host without an orphan-reaping init, an ordinary orphan can remain a zombie until init reaps it.
Compose uses an init process for this reason.
No per-call cgroup or Linux subreaper has been added.
Whether pinned upstream tools need additional containment remains a host acceptance question.

The Node resident-buffer mode allocates 192 MiB successfully despite the 128 MiB heap bound, then is cancelled.
This proves why the heap limit must not be described as a total resident-memory cap.
Python refuses a 600 MiB allocation under its 512 MiB address-space bound.

Run `docker compose -f compose.example.yaml config --quiet` to validate the final container configuration.
Run `pnpm test:runner-container` for actual Linux cgroup and tmpfs behaviour, using the slice-owned image and an isolated private BuildKit cache.
It checks UID 10001, a 6 GiB memory bound, a 192-task bound and 256 MiB tmpfs.
An upstream write filling tmpfs returns ENOSPC and its ordinary nonzero status, then its directory is removed.
A byte-full tmpfs still permits a call that needs only an empty directory and pipes.
The test also imposes a synthetic 1024-inode tmpfs bound and fills it, making directory creation reject with `TEMP_UNAVAILABLE`.
The failed setup releases its slot and allows the next call after inodes are freed.
Resident-memory enforcement is exercised at a tighter synthetic 256 MiB cgroup bound with a 512 MiB fake allocation, asserting an OOM kill and leader reaping.
It does not allocate 6 GiB to force the final configured bound.
The harness removes its named containers, image and private builder/cache, and never stops or prunes unrelated resources.

Before delivery, run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test`, `pnpm check`, the container check and the private hygiene scan against the committed candidate.
Record the exact commit, command results and private list SHA-256 in delivery evidence and the PR body.
Pipeline fix rounds that change source or tests must renew that evidence for the published head.
No fake check closes a live acceptance gate.

See [README.md](../README.md) for current server lifecycle integration and [S19 verification](verification-s19.md) for its HTTP checks.
See [S11 verification](verification-s11.md) for implemented input transport and [the error catalogue](../src/shared/errors.ts) for HTTP error mappings.
Preparation deadlines and background health cancellation remain later-slice work.
