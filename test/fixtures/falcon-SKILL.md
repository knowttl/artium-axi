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
Starting and stopping NG-SIEM search jobs are the only tenant-side effects.
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
Start with `uvx falcon-axi search start --query '<cql> | head(5)' --wait 30`.
If still running, use `uvx falcon-axi search status <id> --wait 30`; --wait accepts 1-50 seconds.
Without --wait, start returns the job id and status polls once.
For readable epoch-millisecond @timestamp values, append this CQL stage to the query:
`| formatTime("%Y-%m-%dT%H:%M:%SZ", field=@timestamp, as=time, timezone="UTC")`.
Stop search jobs when no longer needed.
