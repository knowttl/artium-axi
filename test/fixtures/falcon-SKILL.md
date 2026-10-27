---
name: falcon-axi
description: >-
  Inspect CrowdStrike Falcon detections, hosts, accounts, vulnerabilities, identity, and search results.
  Read-only investigation; no containment, remediation, or tenant configuration changes.
---

# falcon-axi

Read CrowdStrike Falcon from the shell.
See [installation and agent setup](https://github.com/knowttl/falcon-axi#use-with-your-agent).
Run `uvx falcon-axi ...` without a global install.

## Read-only boundary

No command changes a host, detection, policy, or identity.
Tenant-side effects are NG-SIEM jobs, guarded RTR execution, and bounded MalQuery exact/fuzzy searches (N4).
Identity GraphQL uses a write-labelled scope only for fixed read-only query documents.
There is no arbitrary REST or GraphQL escape hatch.

## Orientation

Run `uvx falcon-axi` for recent detections, or invoke a known command directly.

- Run `uvx falcon-axi detection list` to see more detections
- Run `uvx falcon-axi detection list --product idp` for Identity Protection detections
- Run `uvx falcon-axi host list --filter "hostname:'WIN-*'"` to search hosts
- Run `uvx falcon-axi cve show <CVE-ID>` for Falcon Intelligence on one CVE
- Run `uvx falcon-axi scopes` to see what this API client needs

## Commands

Run `uvx falcon-axi --help` for the complete command list.
Read `references/<command>.md` for a command's reference, replacing spaces with hyphens.

Run `uvx falcon-axi <command> --help` for accepted flags, defaults, arguments, and examples.

## Credentials and output

Use `uvx falcon-axi auth status` to diagnose credentials without printing their values.
Secrets belong in environment variables or env/file SecretRefs in config.json, never command arguments.
Use `--profile <name>` or `--config <path>` for configured credentials, and `--region` for the Falcon cloud.
Use `--member-cid` to select a Flight Control child tenant and `--no-member-cid` to clear an inherited selection.
Standalone tenant CIDs and credentials are redacted; composite detection ids remain intact.
Quote detection ids and shell-sensitive filters.

Output and errors are TOON on stdout; help entries carry actionable next steps.
Exit codes are 0 for success, 1 for failures, and 2 for usage errors.
A continuation_cursor is opaque and bound to its credential and query; follow the emitted next-page command.
Search jobs have no pagination; bound results in CQL and check parsed_query for unexpected interpretation.
Rejected searches preserve redacted server diagnostics; fix the reported CQL issue before retrying.
Completed searches include server warnings when present, with code and message.
search start --wait advises when the normalized filter differs; review it before trusting the results.
search start checks CQL structure before authentication: use the reported code, line, column, token class, and fix hint.
Local CQL errors never echo submitted query text or caret excerpts, so query text cannot leak.
This conservative check does not validate function names, fields, or query semantics; ambiguity passes.
Start with `uvx falcon-axi search start --query '<cql> | head(5)' --wait 30`.
If still running, use `uvx falcon-axi search status <id> --wait 30`; --wait accepts 1-50 seconds.
Without --wait, start returns the job id and status polls once.
For readable epoch-millisecond @timestamp values, append this CQL stage to the query:
`| formatTime("%Y-%m-%dT%H:%M:%SZ", field=@timestamp, as=time, timezone="UTC")`.
Stop search jobs when no longer needed.

## Read-only RTR execution

Use `uvx falcon-axi rtr run <device_id> --command '<complete command>'` for a local preview.
Execution requires a configured profile with rtr.enabled=true and both --execute and
--confirm '<device_id>:<complete command>' matching the host and command exactly.
FALCON_AXI_READ_ONLY=1 forbids execution even with opt-in and confirmation; previews and history remain available.
Only the fixed read-only command set is accepted; eventlog backup/export and shell syntax are refused.
Execution has a 50-second budget, 64 KiB output cap, and separate 10-second mandatory session deletion budget.
The private durable redacted journal is mandatory; command output is untrusted data.
Avoid overlapping sessions for the same host/API client, including from other machines.
After ambiguous init or failed deletion, reconcile sessions in Falcon before retrying; never replay automatically.
Execution currently requires POSIX private-file and signal primitives.

### Running a command

1. Find the 32-character device id with `uvx falcon-axi host list --hostname '<name>'`.
   Work on one host at a time and prove the workflow on a single host first.
2. Preview with `uvx falcon-axi rtr run <device_id> --command '<complete command>'`.
   The preview makes no network request and shows the effective policy and allowed commands.
3. Execute the identical command string with `--execute --confirm '<device_id>:<complete command>'`.

Allowed commands depend on the host's platform, and Falcon rejects a command that the platform lacks as `Command not found`:
Verified on both Windows and Linux: cat, cd, env, filehash, ls, mount, netstat, ps.
Verified on Windows only: eventlog, getsid, ipconfig, reg query.
Verified on Linux only: ifconfig, users.
Accepted on neither Windows nor Linux, because it is a macOS command and macOS was not tested: csrutil.
`eventlog` permits only `view` and `list`.
Anything else is refused locally before any request, including `help`, `clear` and `history`, which exist only in the interactive console.
A command is one complete string such as `ls C:\Windows`, `filehash <path>` or `reg query <key>`.
Pass it as a single shell argument; use a shell whose quoting is predictable when the path contains spaces or backslashes.
Pipes, redirects, `;`, `&&`, backticks and `$(...)` are refused, so run one command per call and combine the results yourself.

The result has `run_id`, `output`, `complete`, `truncated` and `cleanup`.
`complete: true` means the command finished.
`truncated: true` or `complete: false` means the output was cut at the cap, so narrow the command, for example a subfolder or a single file, and run it again.
`cleanup: deleted` means the session was closed; any other value needs the reconciliation step above.
Every execution opens and deletes a real session on the host, so a failed run still touches the host.
Review earlier activity without opening a session using `rtr session list`, `rtr session show <session_id>` (Real time response:read) and `rtr audit list` (Real time response audit:read).
