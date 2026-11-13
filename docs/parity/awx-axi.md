# AWX 0.1.11 command and flag parity decisions

This S0 audit supports [issue #237](https://github.com/knowttl/artium-axi/issues/237).
It records the adapter at baseline `4253cd55da67ac92ea8a87987bafac08cd7fc18d` and proposed full-parity behavior; target support is not implemented by this document.
The existing [generated reference](../awx-parity-matrix.md), [machine-readable inventory](../../tools/inventories/awx-axi-parity.json), and [capability notes](../awx-parity.md) remain the runtime inventory's references.
All counts and "today" tables below describe that historical baseline, not the current implemented boundary.
See the [AWX write boundary](../safety.md#write-gates-by-tool) for current authorization and input restrictions.

## Evidence and scope

The audit installed published `@knowttl/awx-axi@0.1.11` into an isolated temporary prefix with install scripts disabled.
It walked exported CLI `main(argv, env, stdout)` using `--help` for the root, 22 domains, all 215 canonical commands, four client-local groups and 27 router aliases: 268 help invocations, with an empty environment and no controller calls.
It compared every registered leaf and flag with the current Artium inventory and reviewed the published parser, inventory alias router and transport write tags.
The executable is `dist/bin/awx-axi.js`; importing `dist/cli.js` alone does not execute the CLI.
The repository then pinned the unscoped `awx-axi@0.1.11`; all 44 published JavaScript files were compared with the existing inventory's source hashes.
Only `dist/skill.js` differs, substituting scoped package names in invocation examples; command, flag, router and transport sources match.
No real AWX service, credentials or tenant data were used.

The issue describes an older boundary of 13 operational writes.
The inspected checkout already permits 35 ordinary configuration routes as well as those 13 operational writes and 83 reads.
These 131 accepted routes include 39 with restricted flags; supported below means an accepted route, subject to its individual flag rows and input restrictions.
There are 215 canonical commands including the root dashboard (`home`), plus 27 alternate spellings.
Group help is discovery, not a separate operation.

## Count summary

| Surface | Supported today | Blocked today | Managed equivalent today | Not applicable today | Total |
| --- | --- | --- | --- | --- | --- |
| Canonical commands | 131 | 79 | 3 | 2 | 215 |
| Command flag occurrences (including per-command --help) | 637 | 411 | 3 | 1 | 1052 |
| Nested alias spellings | 0 | 27 | 0 | 0 | 27 |
| Inherited selection globals | 0 | 0 | 4 | 0 | 4 |
| Bare version flags | 3 | 0 | 0 | 0 | 3 |


Alias flag contracts contain 137 additional occurrences, inherited from their named canonical commands; these are not counted again in the 1,052 canonical flag occurrences.
Current command totals distinguish the managed workflow for login, profiles and setup from the refusal to execute their raw upstream commands.
Target decisions are 209 supported canonical commands, four managed equivalents and two not applicable commands.
The four managed equivalents are login, logout/PAT revocation, profile selection and setup.
Targets for aliases and file/output flags are managed equivalents as described below.

## Status and authorization rules

The generated [target authorization policy](../awx-parity-matrix.md#target-authorization-policy), owned by `scripts/awx-parity.mjs`, governs the authorization columns below.
Implementation slices ship without an Artium release per slice; publish one release after the final slice.

Blocked means the current adapter refuses the route or flag, even when an administrator enables writes.
Managed equivalent replaces upstream client state, filesystem access or input delivery with an Artium-owned workflow.
Not applicable always has an explicit managed-deployment reason.
Every flag row has its own current and target decision; accepted commands do not imply all flags work.
Flags inherit the command's read/write authorization and upstream validation.
`<value>` denotes a value-taking flag, while other flags are boolean.
Positionals retain upstream names and required counts in the command table.

## Global and version flags

Selection globals are inherited by every command and listed once here.
Raw overrides are blocked today; target managed equivalents keep selection and trust under Artium control.

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--config <value>` | managed equivalent (raw override blocked) | managed equivalent | read | Server materializes private config; upstream file path override blocked |
| `--profile <value>` | managed equivalent (raw override blocked) | managed equivalent | read | Select an Artium managed account; upstream profile override blocked |
| `--origin <value>` | managed equivalent (raw override blocked) | managed equivalent | read | Administrator configures HTTPS origin on the managed account; runner override blocked |
| `--verify-ssl <value>` | managed equivalent (raw override blocked) | managed equivalent | read | Managed certificate trust and HTTPS policy; raw TLS verification override blocked |


| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| --version | supported | supported | read | Bare invocation only; not inherited by leaves. |
| -v | supported | supported | read | Bare invocation only; not inherited by leaves. |
| -V | supported | supported | read | Bare invocation only; not inherited by leaves. |


## Canonical commands

| Upstream command / positionals | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `job list` | supported | supported | read | Partial flag coverage; see individual flag decisions. |
| `job show` `<id>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `job stdout` `<id>` (1 required) | supported | supported | read | Partial flag coverage; see individual flag decisions. |
| `job events` `<id>` (1 required) | supported | supported | read | Partial flag coverage; see individual flag decisions. |
| `job hosts` `<id>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `job launch` `<id\|name>` (1 required) | supported | supported | write | Partial flag coverage; see individual flag decisions. |
| `job cancel` `<id>` (1 required) | supported | supported | write | Retain managed access and upstream resource permissions. |
| `job relaunch` `<id>` (1 required) | supported | supported | write | Retain managed access and upstream resource permissions. |
| `job watch` `<id>` (1 required) | supported | supported | read | Artium runner has a bounded lifetime; use --timeout 50 or less |
| `template object-roles` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `template credential-add` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `template credential-remove` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `template instance-group-add` `<id\|name>` (1 required) | supported | supported | write | Retain managed access and upstream resource permissions. |
| `template instance-group-remove` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `template label-add` `<id\|name>` (1 required) | supported | supported | write | Retain managed access and upstream resource permissions. |
| `template label-remove` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `template notification-add` `<id\|name>` (1 required) | supported | supported | write | Retain managed access and upstream resource permissions. |
| `template notification-remove` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `template create` `<name>` (0 required) | supported | supported | write | Partial flag coverage; see individual flag decisions. |
| `template edit` `<id\|name>` (1 required) | supported | supported | write | Partial flag coverage; see individual flag decisions. |
| `template delete` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `template copy` `<id\|name>` (1 required) | supported | supported | write | Retain managed access and upstream resource permissions. |
| `template list` | supported | supported | read | Partial flag coverage; see individual flag decisions. |
| `template show` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `template survey` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `template launch` `<id\|name>` (1 required) | supported | supported | write | Partial flag coverage; see individual flag decisions. |
| `workflow object-roles` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `workflow node-create` `<id\|name>` (1 required) | supported | supported | write | Partial flag coverage; see individual flag decisions. |
| `workflow node-edit` `<id>` (1 required) | supported | supported | write | Partial flag coverage; see individual flag decisions. |
| `workflow node-delete` `<id>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `workflow node-link` `<node-id>` (1 required) | supported | supported | write | Retain managed access and upstream resource permissions. |
| `workflow node-unlink` `<node-id>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `workflow node-credential-add` `<node-id>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `workflow node-credential-remove` `<node-id>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `workflow node-label-add` `<node-id>` (1 required) | supported | supported | write | Retain managed access and upstream resource permissions. |
| `workflow node-label-remove` `<node-id>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `workflow node-instance-group-add` `<node-id>` (1 required) | supported | supported | write | Retain managed access and upstream resource permissions. |
| `workflow node-instance-group-remove` `<node-id>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `workflow node-add-approval` `<node-id>` (1 required) | supported | supported | write | Retain managed access and upstream resource permissions. |
| `workflow notification-add` `<id\|name>` (1 required) | supported | supported | write | Retain managed access and upstream resource permissions. |
| `workflow notification-remove` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `workflow label-add` `<id\|name>` (1 required) | supported | supported | write | Retain managed access and upstream resource permissions. |
| `workflow label-remove` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `workflow copy` `<id\|name>` (1 required) | supported | supported | write | Retain managed access and upstream resource permissions. |
| `workflow create` `<name>` (0 required) | supported | supported | write | Partial flag coverage; see individual flag decisions. |
| `workflow edit` `<id\|name>` (1 required) | supported | supported | write | Partial flag coverage; see individual flag decisions. |
| `workflow delete` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `workflow list` | supported | supported | read | Partial flag coverage; see individual flag decisions. |
| `workflow show` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `workflow survey` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `workflow launch` `<id\|name>` (1 required) | supported | supported | write | Retain managed access and upstream resource permissions. |
| `workflow nodes` `<run-id>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `workflow template-nodes` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `workflow template-node` `<id>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `organization create` `<name>` (0 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `organization edit` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `organization delete` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `organization notification-add` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `organization notification-remove` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `organization user-add` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `organization user-remove` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `organization admin-add` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `organization admin-remove` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `organization team-add` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `organization team-remove` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `organization instance-group-add` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `organization instance-group-remove` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `organization execution-environment-add` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `organization execution-environment-remove` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `organization notification-template-add` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `organization notification-template-remove` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `organization galaxy-credential-add` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `organization galaxy-credential-remove` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `organization list` | supported | supported | read | Partial flag coverage; see individual flag decisions. |
| `organization show` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `system-job-template launch` `<id\|name>` (1 required) | supported | supported | write | Retain managed access and upstream resource permissions. |
| `system-job-template list` | supported | supported | read | Partial flag coverage; see individual flag decisions. |
| `system-job-template show` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `system-job cancel` `<id>` (1 required) | supported | supported | write | Retain managed access and upstream resource permissions. |
| `system-job list` | supported | supported | read | Partial flag coverage; see individual flag decisions. |
| `system-job show` `<id>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `system-job events` `<id>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `system-job notifications` `<id>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `credential object-roles` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `credential copy` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `credential create` `<name>` (0 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `credential edit` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `credential delete` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. Target deletion uses the writes switch plus the separate Allow destructive deletes setting, including security resources; upstream delete tags still need trusted runner gate configuration |
| `credential list` | supported | supported | read | Partial flag coverage; see individual flag decisions. |
| `credential show` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `approval list` | supported | supported | read | Retain managed access and upstream resource permissions. |
| `approval show` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `approval approve` `<id\|name>` (1 required) | supported | supported | write | Retain managed access and upstream resource permissions. |
| `approval deny` `<id\|name>` (1 required) | supported | supported | write | Retain managed access and upstream resource permissions. |
| `ad-hoc launch` `<inventory>` (0 required) | supported | supported | write | Retain managed access and upstream resource permissions. |
| `ad-hoc list` | supported | supported | read | Partial flag coverage; see individual flag decisions. |
| `ad-hoc show` `<id>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `ad-hoc events` `<id>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `ad-hoc stdout` `<id>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `project copy` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `project notification-add` `<id\|name>` (1 required) | supported | supported | write | Retain managed access and upstream resource permissions. |
| `project notification-remove` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `project create` `<name>` (0 required) | supported | supported | write | Partial flag coverage; see individual flag decisions. Target --credential uses the same writes switch; upstream tags this request config. |
| `project edit` `<id\|name>` (1 required) | supported | supported | write | Partial flag coverage; see individual flag decisions. Target --credential uses the same writes switch; upstream tags this request config. |
| `project delete` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `project list` | supported | supported | read | Partial flag coverage; see individual flag decisions. |
| `project show` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `project playbooks` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `project updates` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `project roles` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `project sync` `<id\|name>` (1 required) | supported | supported | write | Retain managed access and upstream resource permissions. |
| `inventory host-bulk-create` | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `inventory host-bulk-delete` | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `inventory group-create` `<name>` (0 required) | supported | supported | write | Partial flag coverage; see individual flag decisions. |
| `inventory group-edit` `<id\|name>` (1 required) | supported | supported | write | Partial flag coverage; see individual flag decisions. |
| `inventory group-delete` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `inventory group-add-host` `<id\|name>` (1 required) | supported | supported | write | Retain managed access and upstream resource permissions. |
| `inventory group-remove-host` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `inventory group-add-child` `<id\|name>` (1 required) | supported | supported | write | Retain managed access and upstream resource permissions. |
| `inventory group-remove-child` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `inventory source-create` `<name>` (0 required) | supported | supported | write | Partial flag coverage; see individual flag decisions. Credential or notification configuration/messages input uses the same writes switch and controlled secret handling. |
| `inventory source-edit` `<id\|name>` (1 required) | supported | supported | write | Partial flag coverage; see individual flag decisions. Credential or notification configuration/messages input uses the same writes switch and controlled secret handling. |
| `inventory source-delete` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `inventory source-credential-add` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `inventory source-credential-remove` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `inventory source-notification-add` `<id\|name>` (1 required) | supported | supported | write | Retain managed access and upstream resource permissions. |
| `inventory source-notification-remove` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `inventory create` `<name>` (0 required) | supported | supported | write | Partial flag coverage; see individual flag decisions. |
| `inventory edit` `<id\|name>` (1 required) | supported | supported | write | Partial flag coverage; see individual flag decisions. |
| `inventory delete` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `inventory sync` `<id\|name>` (1 required) | supported | supported | write | Retain managed access and upstream resource permissions. |
| `inventory host-create` `<name>` (0 required) | supported | supported | write | Partial flag coverage; see individual flag decisions. |
| `inventory host-edit` `<id\|name>` (1 required) | supported | supported | write | Partial flag coverage; see individual flag decisions. |
| `inventory host-delete` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `inventory list` | supported | supported | read | Retain managed access and upstream resource permissions. |
| `inventory show` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `inventory groups` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `inventory hosts` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `inventory sources` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `inventory updates` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `inventory constructed-list` | supported | supported | read | Retain managed access and upstream resource permissions. |
| `inventory constructed-show` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `host inspect` `<selectors>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `host list` | supported | supported | read | Retain managed access and upstream resource permissions. |
| `host show` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `group list` | supported | supported | read | Retain managed access and upstream resource permissions. |
| `group show` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `inventory-source list` | supported | supported | read | Retain managed access and upstream resource permissions. |
| `inventory-source show` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `schedule credential-add` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `schedule credential-remove` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `schedule label-add` `<id\|name>` (1 required) | supported | supported | write | Retain managed access and upstream resource permissions. |
| `schedule label-remove` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `schedule instance-group-add` `<id\|name>` (1 required) | supported | supported | write | Retain managed access and upstream resource permissions. |
| `schedule instance-group-remove` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `schedule create` `<name>` (0 required) | supported | supported | write | Partial flag coverage; see individual flag decisions. |
| `schedule edit` `<id\|name>` (1 required) | supported | supported | write | Partial flag coverage; see individual flag decisions. |
| `schedule delete` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `schedule list` | supported | supported | read | Partial flag coverage; see individual flag decisions. |
| `schedule show` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `execution-environment create` `<name>` (0 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. Credential or notification configuration/messages input uses the same writes switch and controlled secret handling. |
| `execution-environment edit` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. Credential or notification configuration/messages input uses the same writes switch and controlled secret handling. |
| `execution-environment delete` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `execution-environment copy` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `execution-environment list` | supported | supported | read | Partial flag coverage; see individual flag decisions. |
| `execution-environment show` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `user token-create` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `user token-revoke` `<id>` (1 required) | blocked | supported | write | Upstream DELETE is tagged security; target revocation uses the single writes switch, with upstream gates set by trusted managed configuration Route rejected before administrator settings, including help and preview. |
| `user create` `<username>` (0 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `user edit` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `user delete` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. Target deletion uses the writes switch plus the separate Allow destructive deletes setting, including security resources; upstream delete tags still need trusted runner gate configuration |
| `user list` | supported | supported | read | Partial flag coverage; see individual flag decisions. |
| `user show` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `notification list` | supported | supported | read | Partial flag coverage; see individual flag decisions. |
| `notification show` `<id>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `notification-template create` `<name>` (0 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. Credential or notification configuration/messages input uses the same writes switch and controlled secret handling. |
| `notification-template edit` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. Credential or notification configuration/messages input uses the same writes switch and controlled secret handling. |
| `notification-template delete` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `notification-template test` `<id\|name>` (1 required) | supported | supported | write | Retain managed access and upstream resource permissions. |
| `notification-template copy` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `notification-template list` | supported | supported | read | Partial flag coverage; see individual flag decisions. |
| `notification-template show` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `activity-stream list` | supported | supported | read | Partial flag coverage; see individual flag decisions. |
| `activity-stream show` `<id>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `team user-add` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `team user-remove` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `team credential-create` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `team create` `<name>` (0 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `team edit` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `team delete` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. Target deletion uses the writes switch plus the separate Allow destructive deletes setting, including security resources; upstream delete tags still need trusted runner gate configuration |
| `team list` | supported | supported | read | Partial flag coverage; see individual flag decisions. |
| `team show` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `team users` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `team projects` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `team credentials` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `team roles` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `team object-roles` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `team access-list` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `role grant` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `role revoke` `<id\|name>` (1 required) | blocked | supported | write | Route rejected before administrator settings, including help and preview. |
| `role list` | supported | supported | read | Partial flag coverage; see individual flag decisions. |
| `role show` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `role parents` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `role children` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `role users` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `role teams` `<id\|name>` (1 required) | supported | supported | read | Retain managed access and upstream resource permissions. |
| `home` | supported | supported | read | Uses the selected managed AWX account; upstream identity/read diagnostics retained |
| `auth login` | managed equivalent (raw command blocked) | managed equivalent | write | Artium AWX account form accepts a PAT or exchanges username/password for a PAT; raw upstream login is blocked. Passwords and tokens use the managed credential store, never argv. Native PAT effects are described in the generated reference. |
| `auth status` | supported | supported | read | Uses the selected managed AWX account; upstream identity/read diagnostics retained |
| `auth logout` | blocked | managed equivalent | write | Removing a managed account is not upstream PAT revocation. Provide managed token revocation under the target authorization policy. Native PAT effects are described in the generated reference. |
| `setup hooks` | managed equivalent (raw command blocked) | managed equivalent | read | Use artium-axi setup --host <claude\|codex\|opencode> --hook on Linux for authenticated ambient tool context and granted tool skills. Claude Code and Codex use SessionStart; OpenCode 1.19.x uses its local system-context plugin API. Codex host trust and feature controls still apply. Pi and non-Linux hosts retain skill-only setup. Never install hooks in the server runner. |
| `profile list` | managed equivalent (raw command blocked) | managed equivalent | read | Use Artium account discovery and selection; upstream filesystem profiles are not caller-owned. |
| `config path` | not applicable | not applicable | read | Artium materializes private runner configuration. There is no client-owned upstream config path to expose. |
| `doctor` | supported | supported | read | Uses the selected managed AWX account; upstream identity/read diagnostics retained |
| `update` | not applicable | not applicable | read | The deployment pins awx-axi through tools/package.json and integrity.json. Upgrade through a reviewed Artium dependency change; per-run self-update is blocked. |


## Flags by canonical command

The four selection globals above apply to every command in addition to the rows below.
Current supported flags still inherit route authorization, value validation and runner limits.
All file flags, stdin, and `@file` values are currently refused by the adapter.
Inline structured values are accepted only where the corresponding flag is supported; a value beginning with `@` is always rejected.
Target file/stdin equivalents must accept caller-owned bounded bytes through the controlled file channel, materialize private runner leaves, scan/redact secrets and clean up afterward.
They must never accept an arbitrary server path.
Private keys and credential secrets belong in the controlled inputs/password channel or managed account storage, never process arguments, logs, audit payloads or returned secret fields.
Potentially sensitive inline variables, module arguments, SCM URLs and notification bodies require the same secure-delivery review.
`--playbook` names an AWX project file and is not a server file upload.
`job stdout --download` targets a managed artifact rather than a server pathname.
`auth login --allow-http` remains not applicable because managed AWX accounts require HTTPS.
Raw `update`, including `--check`, is not applicable: deployments review and pin package upgrades centrally.

### job list

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--status <value>` | supported | supported | read | filter by status |
| `--type <value>` | supported | supported | read | job type (job, workflow, project-update, all) |
| `--template <value>` | supported | supported | read | filter by template |
| `--failed` | supported | supported | read | filter to failed jobs |
| `--since <value>` | supported | supported | read | filter jobs since relative time (e.g. 2h) |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |
| `--fields <value>` | blocked | supported | read | extra fields Omitted from the reviewed Artium flag schema |


### job show

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--type <value>` | supported | supported | read | concrete job type |


### job stdout

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--tail <value>` | supported | supported | read | tail N lines |
| `--lines <value>` | supported | supported | read | line range A-B |
| `--full` | blocked | supported | read | full output Omitted from the reviewed Artium flag schema |
| `--download <value>` | blocked | managed equivalent | read | download to file Omitted from the reviewed Artium flag schema Use a managed output artifact. |
| `--ansi` | blocked | supported | read | keep ANSI color codes Omitted from the reviewed Artium flag schema |
| `--type <value>` | supported | supported | read | concrete job type |


### job events

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--failed` | supported | supported | read | only failed events |
| `--host <value>` | supported | supported | read | filter by host name |
| `--task <value>` | supported | supported | read | filter by task name |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |
| `--type <value>` | blocked | supported | read | concrete job type Omitted from the reviewed Artium flag schema |


### job hosts

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |


### job launch

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--limit <value>` | supported | supported | write | host limit |
| `--tags <value>` | supported | supported | write | job tags |
| `--skip-tags <value>` | supported | supported | write | skip tags |
| `--extra-vars <value>` | supported | managed equivalent | write | extra vars JSON Potential secret-bearing input: controlled delivery and redaction required. Controlled caller byte channel; no server paths. Inline value follows current flag decision; @file currently rejected, target uses controlled upload. |
| `--inventory <value>` | supported | supported | write | inventory id |
| `--scm-branch <value>` | supported | supported | write | SCM branch |
| `--verbosity <value>` | supported | supported | write | verbosity level 0-5 |
| `--job-type <value>` | supported | supported | write | run or check |
| `--diff` | supported | supported | write | show diffs |
| `--credential-passwords-file <value>` | blocked | managed equivalent | write | path to credential passwords JSON file AWX adapter rejects file inputs before execution Potential secret-bearing input: controlled delivery and redaction required. Controlled caller byte channel; no server paths. |
| `--wait` | supported | supported | write | wait for completion |
| `--timeout <value>` | supported | supported | write | wait timeout in seconds |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | dry run without mutating |


### job cancel

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | dry run without mutating |
| `--type <value>` | supported | supported | write | concrete job type |


### job relaunch

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--failed-only` | supported | supported | write | retry failed hosts only |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | dry run without mutating |
| `--type <value>` | supported | supported | write | concrete job type |


### job watch

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--timeout <value>` | supported | supported | read | timeout in seconds Current bounded runner guidance: 50 seconds or less. |
| `--interval <value>` | supported | supported | read | poll interval in seconds |
| `--type <value>` | supported | supported | read | concrete job type |


### template object-roles

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |


### template credential-add

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--credential <value>` | blocked | supported | write | credential id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### template credential-remove

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--credential <value>` | blocked | supported | write | credential id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### template instance-group-add

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--instance-group <value>` | supported | supported | write | instance group id |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | preview without mutating |


### template instance-group-remove

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--instance-group <value>` | blocked | supported | write | instance group id |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### template label-add

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--label <value>` | supported | supported | write | label id |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | preview without mutating |


### template label-remove

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--label <value>` | blocked | supported | write | label id |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### template notification-add

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--event <value>` | supported | supported | write | started, success, or error |
| `--notification-template <value>` | supported | supported | write | notification template id or name |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | preview without mutating |


### template notification-remove

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--event <value>` | blocked | supported | write | started, success, or error |
| `--notification-template <value>` | blocked | supported | write | notification template id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### template create

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--name <value>` | supported | supported | write | template name |
| `--inventory <value>` | supported | supported | write | inventory id or name |
| `--project <value>` | supported | supported | write | project id or name |
| `--playbook <value>` | supported | supported | write | playbook file path |
| `--description <value>` | supported | supported | write | description |
| `--execution-environment <value>` | supported | supported | write | execution environment id or name |
| `--extra-vars <value>` | blocked | managed equivalent | write | extra vars JSON/YAML Omitted from the reviewed Artium flag schema Potential secret-bearing input: controlled delivery and redaction required. Controlled caller byte channel; no server paths. Inline value follows current flag decision; @file currently rejected, target uses controlled upload. |
| `--limit <value>` | supported | supported | write | host limit |
| `--verbosity <value>` | supported | supported | write | verbosity level 0-5 |
| `--job-type <value>` | supported | supported | write | run or check |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | dry run without mutating |


### template edit

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--name <value>` | supported | supported | write | template name |
| `--inventory <value>` | supported | supported | write | inventory id or name |
| `--project <value>` | supported | supported | write | project id or name |
| `--playbook <value>` | supported | supported | write | playbook file path |
| `--description <value>` | supported | supported | write | description |
| `--execution-environment <value>` | supported | supported | write | execution environment id or name |
| `--extra-vars <value>` | blocked | managed equivalent | write | extra vars JSON/YAML Omitted from the reviewed Artium flag schema Potential secret-bearing input: controlled delivery and redaction required. Controlled caller byte channel; no server paths. Inline value follows current flag decision; @file currently rejected, target uses controlled upload. |
| `--limit <value>` | supported | supported | write | host limit |
| `--verbosity <value>` | supported | supported | write | verbosity level 0-5 |
| `--job-type <value>` | supported | supported | write | run or check |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | dry run without mutating |


### template delete

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | dry run without mutating |


### template copy

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--name <value>` | supported | supported | write | new template name |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | dry run without mutating |


### template list

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--project <value>` | supported | supported | read | filter by project |
| `--search <value>` | supported | supported | read | search templates |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |
| `--fields <value>` | blocked | supported | read | extra fields Omitted from the reviewed Artium flag schema |


### template show

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |


### template survey

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |


### template launch

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--limit <value>` | supported | supported | write | host limit |
| `--tags <value>` | supported | supported | write | job tags |
| `--skip-tags <value>` | supported | supported | write | skip tags |
| `--extra-vars <value>` | supported | managed equivalent | write | extra vars JSON/YAML Potential secret-bearing input: controlled delivery and redaction required. Controlled caller byte channel; no server paths. Inline value follows current flag decision; @file currently rejected, target uses controlled upload. |
| `--inventory <value>` | supported | supported | write | inventory id |
| `--scm-branch <value>` | supported | supported | write | SCM branch |
| `--verbosity <value>` | supported | supported | write | verbosity level 0-5 |
| `--job-type <value>` | supported | supported | write | run or check |
| `--diff` | supported | supported | write | enable diff mode |
| `--credential-passwords-file <value>` | blocked | managed equivalent | write | path to credential passwords JSON file AWX adapter rejects file inputs before execution Potential secret-bearing input: controlled delivery and redaction required. Controlled caller byte channel; no server paths. |
| `--wait` | supported | supported | write | wait for completion |
| `--timeout <value>` | supported | supported | write | wait timeout in seconds |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | dry run without mutating |


### workflow object-roles

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |


### workflow node-create

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--template <value>` | supported | supported | write | unified job template id or name |
| `--inventory <value>` | supported | supported | write | inventory id or name |
| `--extra-vars <value>` | blocked | managed equivalent | write | extra vars JSON/YAML Omitted from the reviewed Artium flag schema Potential secret-bearing input: controlled delivery and redaction required. Controlled caller byte channel; no server paths. Inline value follows current flag decision; @file currently rejected, target uses controlled upload. |
| `--limit <value>` | supported | supported | write | host limit |
| `--scm-branch <value>` | supported | supported | write | SCM branch |
| `--job-type <value>` | supported | supported | write | run or check |
| `--job-tags <value>` | supported | supported | write | job tags |
| `--skip-tags <value>` | supported | supported | write | skip tags |
| `--verbosity <value>` | supported | supported | write | verbosity |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | preview without mutating |


### workflow node-edit

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--template <value>` | supported | supported | write | unified job template id or name |
| `--inventory <value>` | supported | supported | write | inventory id or name |
| `--extra-vars <value>` | blocked | managed equivalent | write | extra vars JSON/YAML Omitted from the reviewed Artium flag schema Potential secret-bearing input: controlled delivery and redaction required. Controlled caller byte channel; no server paths. Inline value follows current flag decision; @file currently rejected, target uses controlled upload. |
| `--limit <value>` | supported | supported | write | host limit |
| `--scm-branch <value>` | supported | supported | write | SCM branch |
| `--job-type <value>` | supported | supported | write | run or check |
| `--job-tags <value>` | supported | supported | write | job tags |
| `--skip-tags <value>` | supported | supported | write | skip tags |
| `--verbosity <value>` | supported | supported | write | verbosity |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | preview without mutating |


### workflow node-delete

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### workflow node-link

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--on <value>` | supported | supported | write | edge type |
| `--to <value>` | supported | supported | write | target node id |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | preview without mutating |


### workflow node-unlink

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--on <value>` | blocked | supported | write | edge type |
| `--to <value>` | blocked | supported | write | target node id |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### workflow node-credential-add

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--credential <value>` | blocked | supported | write | credential id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### workflow node-credential-remove

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--credential <value>` | blocked | supported | write | credential id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### workflow node-label-add

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--label <value>` | supported | supported | write | label id |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | preview without mutating |


### workflow node-label-remove

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--label <value>` | blocked | supported | write | label id |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### workflow node-instance-group-add

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--instance-group <value>` | supported | supported | write | instance-group id |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | preview without mutating |


### workflow node-instance-group-remove

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--instance-group <value>` | blocked | supported | write | instance-group id |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### workflow node-add-approval

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--name <value>` | supported | supported | write | approval name |
| `--description <value>` | supported | supported | write | description |
| `--timeout <value>` | supported | supported | write | timeout seconds |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | preview without mutating |


### workflow notification-add

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--event <value>` | supported | supported | write | started, success, error, or approval |
| `--notification-template <value>` | supported | supported | write | notification template id or name |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | preview without mutating |


### workflow notification-remove

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--event <value>` | blocked | supported | write | started, success, error, or approval |
| `--notification-template <value>` | blocked | supported | write | notification template id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### workflow label-add

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--label <value>` | supported | supported | write | label id |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | preview without mutating |


### workflow label-remove

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--label <value>` | blocked | supported | write | label id |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### workflow copy

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--name <value>` | supported | supported | write | copied workflow name |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | preview without mutating |


### workflow create

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--name <value>` | supported | supported | write | workflow template name |
| `--organization <value>` | supported | supported | write | organization id or name |
| `--description <value>` | supported | supported | write | description |
| `--extra-vars <value>` | blocked | managed equivalent | write | extra vars JSON/YAML Omitted from the reviewed Artium flag schema Potential secret-bearing input: controlled delivery and redaction required. Controlled caller byte channel; no server paths. Inline value follows current flag decision; @file currently rejected, target uses controlled upload. |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | dry run without mutating |


### workflow edit

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--name <value>` | supported | supported | write | workflow template name |
| `--organization <value>` | supported | supported | write | organization id or name |
| `--description <value>` | supported | supported | write | description |
| `--extra-vars <value>` | blocked | managed equivalent | write | extra vars JSON/YAML Omitted from the reviewed Artium flag schema Potential secret-bearing input: controlled delivery and redaction required. Controlled caller byte channel; no server paths. Inline value follows current flag decision; @file currently rejected, target uses controlled upload. |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | dry run without mutating |


### workflow delete

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | dry run without mutating |


### workflow list

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--search <value>` | supported | supported | read | search workflow templates |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |
| `--fields <value>` | blocked | supported | read | extra fields Omitted from the reviewed Artium flag schema |


### workflow show

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |


### workflow survey

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |


### workflow launch

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--extra-vars <value>` | supported | managed equivalent | write | extra vars JSON/YAML Potential secret-bearing input: controlled delivery and redaction required. Controlled caller byte channel; no server paths. Inline value follows current flag decision; @file currently rejected, target uses controlled upload. |
| `--limit <value>` | supported | supported | write | host limit override |
| `--scm-branch <value>` | supported | supported | write | SCM branch override |
| `--wait` | supported | supported | write | wait for completion |
| `--timeout <value>` | supported | supported | write | wait timeout in seconds |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | dry run without mutating |


### workflow nodes

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |


### workflow template-nodes

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |


### workflow template-node

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |


### organization create

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--name <value>` | blocked | supported | write | organization name |
| `--description <value>` | blocked | supported | write | description |
| `--max-hosts <value>` | blocked | supported | write | maximum hosts |
| `--default-environment <value>` | blocked | supported | write | default execution environment id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### organization edit

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--name <value>` | blocked | supported | write | organization name |
| `--description <value>` | blocked | supported | write | description |
| `--max-hosts <value>` | blocked | supported | write | maximum hosts |
| `--default-environment <value>` | blocked | supported | write | default execution environment id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### organization delete

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### organization notification-add

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--event <value>` | blocked | supported | write | started, success, error, or approval |
| `--notification-template <value>` | blocked | supported | write | notification template id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### organization notification-remove

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--event <value>` | blocked | supported | write | started, success, error, or approval |
| `--notification-template <value>` | blocked | supported | write | notification template id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### organization user-add

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--user <value>` | blocked | supported | write | user id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### organization user-remove

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--user <value>` | blocked | supported | write | user id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### organization admin-add

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--user <value>` | blocked | supported | write | user id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### organization admin-remove

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--user <value>` | blocked | supported | write | user id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### organization team-add

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--team <value>` | blocked | supported | write | team id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### organization team-remove

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--team <value>` | blocked | supported | write | team id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### organization instance-group-add

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--instance-group <value>` | blocked | supported | write | instance group id |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### organization instance-group-remove

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--instance-group <value>` | blocked | supported | write | instance group id |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### organization execution-environment-add

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--execution-environment <value>` | blocked | supported | write | execution environment id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### organization execution-environment-remove

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--execution-environment <value>` | blocked | supported | write | execution environment id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### organization notification-template-add

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--notification-template <value>` | blocked | supported | write | notification template id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### organization notification-template-remove

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--notification-template <value>` | blocked | supported | write | notification template id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### organization galaxy-credential-add

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--credential <value>` | blocked | supported | write | credential id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### organization galaxy-credential-remove

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--credential <value>` | blocked | supported | write | credential id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### organization list

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--search <value>` | supported | supported | read | search organizations |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |
| `--fields <value>` | blocked | supported | read | extra fields Omitted from the reviewed Artium flag schema |


### organization show

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |


### system-job-template launch

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--extra-vars <value>` | supported | managed equivalent | write | extra variables JSON object Potential secret-bearing input: controlled delivery and redaction required. Controlled caller byte channel; no server paths. Inline value follows current flag decision; @file currently rejected, target uses controlled upload. |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | preview without mutating |


### system-job-template list

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--search <value>` | supported | supported | read | search system job templates |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |
| `--fields <value>` | blocked | supported | read | extra fields Omitted from the reviewed Artium flag schema |


### system-job-template show

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |


### system-job cancel

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | preview without mutating |


### system-job list

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--search <value>` | supported | supported | read | search system jobs |
| `--template <value>` | supported | supported | read | filter by template |
| `--status <value>` | supported | supported | read | filter by status |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |
| `--fields <value>` | blocked | supported | read | extra fields Omitted from the reviewed Artium flag schema |


### system-job show

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |


### system-job events

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--failed` | supported | supported | read | only failed events |
| `--host <value>` | supported | supported | read | filter by host |
| `--task <value>` | supported | supported | read | filter by task |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |


### system-job notifications

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |


### credential object-roles

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |


### credential copy

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--name <value>` | blocked | supported | write | copy name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### credential create

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--name <value>` | blocked | supported | write | credential name |
| `--credential-type <value>` | blocked | supported | write | credential type id or name |
| `--organization <value>` | blocked | supported | write | organization id or name |
| `--description <value>` | blocked | supported | write | description |
| `--inputs-file <value>` | blocked | managed equivalent | write | JSON file path (or - for stdin) AWX adapter rejects file inputs before execution Potential secret-bearing input: controlled delivery and redaction required. Controlled caller byte channel; no server paths. Preserve upstream stdin '-' semantics via that channel. |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | dry run without mutating |


### credential edit

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--name <value>` | blocked | supported | write | credential name |
| `--credential-type <value>` | blocked | supported | write | credential type id or name |
| `--organization <value>` | blocked | supported | write | organization id or name |
| `--description <value>` | blocked | supported | write | description |
| `--inputs-file <value>` | blocked | managed equivalent | write | JSON file path (or - for stdin) AWX adapter rejects file inputs before execution Potential secret-bearing input: controlled delivery and redaction required. Controlled caller byte channel; no server paths. Preserve upstream stdin '-' semantics via that channel. |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | dry run without mutating |


### credential delete

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | dry run without mutating |


### credential list

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--search <value>` | supported | supported | read | search credentials |
| `--organization <value>` | supported | supported | read | filter credentials by organization id |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |
| `--fields <value>` | blocked | supported | read | extra fields Omitted from the reviewed Artium flag schema |


### credential show

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |


### approval list

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--include-decided` | supported | supported | read | include decided approvals, not just pending |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |


### approval show

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |


### approval approve

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | dry run without mutating |


### approval deny

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | dry run without mutating |


### ad-hoc launch

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--inventory <value>` | supported | supported | write | inventory id or name |
| `--module-name <value>` | supported | supported | write | module name (e.g. command) |
| `--module <value>` | supported | supported | write | alias for module-name |
| `--module-args <value>` | supported | supported | write | module arguments Potential secret-bearing input: controlled delivery and redaction required. |
| `--args <value>` | supported | supported | write | alias for module-args Potential secret-bearing input: controlled delivery and redaction required. |
| `--credential <value>` | supported | supported | write | credential id or name |
| `--limit <value>` | supported | supported | write | host limit |
| `--extra-vars <value>` | supported | managed equivalent | write | extra vars JSON Potential secret-bearing input: controlled delivery and redaction required. Controlled caller byte channel; no server paths. Inline value follows current flag decision; @file currently rejected, target uses controlled upload. |
| `--verbosity <value>` | supported | supported | write | verbosity level 0-5 |
| `--wait` | supported | supported | write | wait for completion |
| `--timeout <value>` | supported | supported | write | wait timeout in seconds |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | dry run without mutating |


### ad-hoc list

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--search <value>` | supported | supported | read | search ad-hoc commands |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |
| `--fields <value>` | blocked | supported | read | extra fields Omitted from the reviewed Artium flag schema |


### ad-hoc show

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |


### ad-hoc events

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--host <value>` | supported | supported | read | filter by host name |
| `--task <value>` | supported | supported | read | filter by task name |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |


### ad-hoc stdout

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--tail <value>` | supported | supported | read | tail N lines |
| `--lines <value>` | supported | supported | read | line range A-B |


### project copy

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--name <value>` | blocked | supported | write | copy name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### project notification-add

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--event <value>` | supported | supported | write | started, success, or error |
| `--notification-template <value>` | supported | supported | write | notification template id or name |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | preview without mutating |


### project notification-remove

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--event <value>` | blocked | supported | write | started, success, or error |
| `--notification-template <value>` | blocked | supported | write | notification template id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### project create

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--name <value>` | supported | supported | write | project name |
| `--organization <value>` | supported | supported | write | organization id or name |
| `--scm-type <value>` | supported | supported | write | SCM type (e.g. git, svn) |
| `--scm-url <value>` | blocked | supported | write | SCM URL Omitted from the reviewed Artium flag schema Potential secret-bearing input: controlled delivery and redaction required. |
| `--scm-branch <value>` | supported | supported | write | SCM branch |
| `--credential <value>` | blocked | supported | write | SCM credential id or name Omitted from the reviewed Artium flag schema |
| `--description <value>` | supported | supported | write | description |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | dry run without mutating |


### project edit

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--name <value>` | supported | supported | write | project name |
| `--organization <value>` | supported | supported | write | organization id or name |
| `--scm-type <value>` | supported | supported | write | SCM type (e.g. git, svn) |
| `--scm-url <value>` | blocked | supported | write | SCM URL Omitted from the reviewed Artium flag schema Potential secret-bearing input: controlled delivery and redaction required. |
| `--scm-branch <value>` | supported | supported | write | SCM branch |
| `--credential <value>` | blocked | supported | write | SCM credential id or name Omitted from the reviewed Artium flag schema |
| `--description <value>` | supported | supported | write | description |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | dry run without mutating |


### project delete

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | dry run without mutating |


### project list

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--search <value>` | supported | supported | read | search projects |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |
| `--fields <value>` | blocked | supported | read | extra fields Omitted from the reviewed Artium flag schema |


### project show

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |


### project playbooks

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |


### project updates

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |


### project roles

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |


### project sync

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--wait` | supported | supported | write | wait for completion |
| `--timeout <value>` | supported | supported | write | wait timeout in seconds |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | dry run without mutating |


### inventory host-bulk-create

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--inventory <value>` | blocked | supported | write | inventory id or name |
| `--hosts-file <value>` | blocked | managed equivalent | write | JSON host array file AWX adapter rejects file inputs before execution Controlled caller byte channel; no server paths. |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### inventory host-bulk-delete

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--hosts-file <value>` | blocked | managed equivalent | write | JSON host id array file AWX adapter rejects file inputs before execution Controlled caller byte channel; no server paths. |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### inventory group-create

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--name <value>` | supported | supported | write | group name |
| `--inventory <value>` | supported | supported | write | inventory id or name |
| `--description <value>` | supported | supported | write | description |
| `--variables <value>` | blocked | supported | write | group variables Omitted from the reviewed Artium flag schema Potential secret-bearing input: controlled delivery and redaction required. |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | preview without mutating |


### inventory group-edit

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--name <value>` | supported | supported | write | group name |
| `--description <value>` | supported | supported | write | description |
| `--variables <value>` | blocked | supported | write | group variables Omitted from the reviewed Artium flag schema Potential secret-bearing input: controlled delivery and redaction required. |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | preview without mutating |


### inventory group-delete

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### inventory group-add-host

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--host <value>` | supported | supported | write | host id or name |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | preview without mutating |


### inventory group-remove-host

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--host <value>` | blocked | supported | write | host id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### inventory group-add-child

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--child <value>` | supported | supported | write | child group id or name |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | preview without mutating |


### inventory group-remove-child

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--child <value>` | blocked | supported | write | child group id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### inventory source-create

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--name <value>` | supported | supported | write | source name |
| `--inventory <value>` | supported | supported | write | inventory id or name |
| `--source <value>` | supported | supported | write | source type |
| `--source-project <value>` | supported | supported | write | source project id or name |
| `--credential <value>` | blocked | supported | write | credential id or name Omitted from the reviewed Artium flag schema |
| `--source-vars <value>` | blocked | supported | write | source variables JSON Omitted from the reviewed Artium flag schema Potential secret-bearing input: controlled delivery and redaction required. |
| `--update-on-launch` | supported | supported | write | update on launch |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | preview without mutating |


### inventory source-edit

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--name <value>` | supported | supported | write | source name |
| `--source <value>` | supported | supported | write | source type |
| `--source-project <value>` | supported | supported | write | source project id or name |
| `--credential <value>` | blocked | supported | write | credential id or name Omitted from the reviewed Artium flag schema |
| `--source-vars <value>` | blocked | supported | write | source variables JSON Omitted from the reviewed Artium flag schema Potential secret-bearing input: controlled delivery and redaction required. |
| `--update-on-launch` | supported | supported | write | update on launch |
| `--no-update-on-launch` | supported | supported | write | do not update on launch |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | preview without mutating |


### inventory source-delete

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### inventory source-credential-add

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--credential <value>` | blocked | supported | write | credential id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### inventory source-credential-remove

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--credential <value>` | blocked | supported | write | credential id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### inventory source-notification-add

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--event <value>` | supported | supported | write | started, success, or error |
| `--notification-template <value>` | supported | supported | write | notification template id or name |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | preview without mutating |


### inventory source-notification-remove

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--event <value>` | blocked | supported | write | started, success, or error |
| `--notification-template <value>` | blocked | supported | write | notification template id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### inventory create

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--name <value>` | supported | supported | write | inventory name |
| `--organization <value>` | supported | supported | write | organization id or name |
| `--kind <value>` | supported | supported | write | inventory kind: standard or smart; host-filter implies smart |
| `--host-filter <value>` | supported | supported | write | smart inventory host filter |
| `--description <value>` | supported | supported | write | description |
| `--variables <value>` | blocked | supported | write | inventory variables YAML/JSON Omitted from the reviewed Artium flag schema Potential secret-bearing input: controlled delivery and redaction required. |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | dry run without mutating |


### inventory edit

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--name <value>` | supported | supported | write | inventory name |
| `--organization <value>` | supported | supported | write | organization id or name |
| `--host-filter <value>` | supported | supported | write | smart inventory host filter |
| `--description <value>` | supported | supported | write | description |
| `--variables <value>` | blocked | supported | write | inventory variables YAML/JSON Omitted from the reviewed Artium flag schema Potential secret-bearing input: controlled delivery and redaction required. |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | dry run without mutating |


### inventory delete

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | dry run without mutating |


### inventory sync

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--wait` | supported | supported | write | wait for completion |
| `--timeout <value>` | supported | supported | write | wait timeout in seconds |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | dry run without mutating |


### inventory host-create

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--name <value>` | supported | supported | write | host name |
| `--inventory <value>` | supported | supported | write | inventory id or name |
| `--description <value>` | supported | supported | write | description |
| `--variables <value>` | blocked | supported | write | host variables YAML/JSON Omitted from the reviewed Artium flag schema Potential secret-bearing input: controlled delivery and redaction required. |
| `--enabled` | supported | supported | write | enable host |
| `--disabled` | supported | supported | write | disable host |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | dry run without mutating |


### inventory host-edit

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--name <value>` | supported | supported | write | host name |
| `--inventory <value>` | supported | supported | write | inventory id or name |
| `--description <value>` | supported | supported | write | description |
| `--variables <value>` | blocked | supported | write | host variables YAML/JSON Omitted from the reviewed Artium flag schema Potential secret-bearing input: controlled delivery and redaction required. |
| `--enabled` | supported | supported | write | enable host |
| `--disabled` | supported | supported | write | disable host |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | dry run without mutating |


### inventory host-delete

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | dry run without mutating |


### inventory list

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--search <value>` | supported | supported | read | search inventories |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |


### inventory show

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |


### inventory groups

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--search <value>` | supported | supported | read | search groups |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |


### inventory hosts

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--search <value>` | supported | supported | read | search hosts |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |
| `--facts` | supported | supported | read | include ansible fact key counts |


### inventory sources

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--search <value>` | supported | supported | read | search sources |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |


### inventory updates

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--search <value>` | supported | supported | read | search updates |
| `--limit <value>` | supported | supported | read | rows to return |
| `--status <value>` | supported | supported | read | filter updates by status |


### inventory constructed-list

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--search <value>` | supported | supported | read | search constructed inventories |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |


### inventory constructed-show

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |


### host inspect

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--inventory <value>` | supported | supported | read | scope names and verify host inventory id |


### host list

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--search <value>` | supported | supported | read | search hosts and related facts |
| `--name <value>` | supported | supported | read | filter by exact host name |
| `--inventory <value>` | supported | supported | read | filter by inventory id |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |


### host show

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |


### group list

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--search <value>` | supported | supported | read | search group names and descriptions |
| `--name <value>` | supported | supported | read | filter by exact group name |
| `--inventory <value>` | supported | supported | read | filter by inventory id |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |


### group show

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |


### inventory-source list

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--search <value>` | supported | supported | read | search source names and descriptions |
| `--name <value>` | supported | supported | read | filter by exact source name |
| `--inventory <value>` | supported | supported | read | filter by inventory id |
| `--source <value>` | supported | supported | read | filter by source type |
| `--status <value>` | supported | supported | read | filter by current source status |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |


### inventory-source show

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |


### schedule credential-add

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--credential <value>` | blocked | supported | write | credential id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### schedule credential-remove

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--credential <value>` | blocked | supported | write | credential id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### schedule label-add

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--label <value>` | supported | supported | write | label id |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | preview without mutating |


### schedule label-remove

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--label <value>` | blocked | supported | write | label id |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### schedule instance-group-add

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--instance-group <value>` | supported | supported | write | instance group id |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | preview without mutating |


### schedule instance-group-remove

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--instance-group <value>` | blocked | supported | write | instance group id |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### schedule create

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--name <value>` | supported | supported | write | schedule name |
| `--template <value>` | supported | supported | write | unified job template id or name |
| `--rrule <value>` | supported | supported | write | recurrence rule string |
| `--description <value>` | supported | supported | write | description |
| `--inventory <value>` | supported | supported | write | inventory id or name (needs ask_inventory_on_launch) |
| `--limit <value>` | supported | supported | write | host limit pattern (needs ask_limit_on_launch) |
| `--extra-vars <value>` | blocked | managed equivalent | write | extra vars JSON object or @file (needs ask_variables_on_launch) Omitted from the reviewed Artium flag schema Potential secret-bearing input: controlled delivery and redaction required. Controlled caller byte channel; no server paths. Inline value follows current flag decision; @file currently rejected, target uses controlled upload. |
| `--job-tags <value>` | supported | supported | write | job tags (needs ask_tags_on_launch) |
| `--skip-tags <value>` | supported | supported | write | skip tags (needs ask_skip_tags_on_launch) |
| `--enabled` | supported | supported | write | enable schedule |
| `--disabled` | supported | supported | write | disable schedule |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | dry run without mutating |


### schedule edit

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--name <value>` | supported | supported | write | schedule name |
| `--template <value>` | supported | supported | write | unified job template id or name |
| `--rrule <value>` | supported | supported | write | recurrence rule string |
| `--description <value>` | supported | supported | write | description |
| `--inventory <value>` | supported | supported | write | inventory id or name (needs ask_inventory_on_launch) |
| `--limit <value>` | supported | supported | write | host limit pattern (needs ask_limit_on_launch) |
| `--extra-vars <value>` | blocked | managed equivalent | write | extra vars JSON object or @file (needs ask_variables_on_launch) Omitted from the reviewed Artium flag schema Potential secret-bearing input: controlled delivery and redaction required. Controlled caller byte channel; no server paths. Inline value follows current flag decision; @file currently rejected, target uses controlled upload. |
| `--job-tags <value>` | supported | supported | write | job tags (needs ask_tags_on_launch) |
| `--skip-tags <value>` | supported | supported | write | skip tags (needs ask_skip_tags_on_launch) |
| `--enabled` | supported | supported | write | enable schedule |
| `--disabled` | supported | supported | write | disable schedule |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | dry run without mutating |


### schedule delete

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | dry run without mutating |


### schedule list

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--search <value>` | supported | supported | read | search schedules |
| `--template <value>` | supported | supported | read | filter schedules by unified job template id |
| `--enabled` | supported | supported | read | show only enabled schedules |
| `--disabled` | supported | supported | read | show only disabled schedules |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |
| `--fields <value>` | blocked | supported | read | extra fields Omitted from the reviewed Artium flag schema |


### schedule show

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |


### execution-environment create

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--name <value>` | blocked | supported | write | environment name |
| `--image <value>` | blocked | supported | write | container image |
| `--description <value>` | blocked | supported | write | description |
| `--organization <value>` | blocked | supported | write | organization id or name |
| `--credential <value>` | blocked | supported | write | registry credential id or name |
| `--pull <value>` | blocked | supported | write | pull policy |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### execution-environment edit

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--name <value>` | blocked | supported | write | environment name |
| `--image <value>` | blocked | supported | write | container image |
| `--description <value>` | blocked | supported | write | description |
| `--organization <value>` | blocked | supported | write | organization id or name |
| `--credential <value>` | blocked | supported | write | registry credential id or name |
| `--pull <value>` | blocked | supported | write | pull policy |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### execution-environment delete

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### execution-environment copy

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--name <value>` | blocked | supported | write | copy name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### execution-environment list

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--search <value>` | supported | supported | read | search execution environments |
| `--organization <value>` | supported | supported | read | filter by organization id |
| `--type <value>` | supported | supported | read | filter by execution environment type |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |
| `--fields <value>` | blocked | supported | read | extra fields Omitted from the reviewed Artium flag schema |


### execution-environment show

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |


### user token-create

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--scope <value>` | blocked | supported | write | token scope |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### user token-revoke

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### user create

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--username <value>` | blocked | supported | write | username |
| `--password-file <value>` | blocked | managed equivalent | write | password file path (or - for stdin) AWX adapter rejects file inputs before execution Potential secret-bearing input: controlled delivery and redaction required. Controlled caller byte channel; no server paths. Preserve upstream stdin '-' semantics via that channel. |
| `--first-name <value>` | blocked | supported | write | first name |
| `--last-name <value>` | blocked | supported | write | last name |
| `--email <value>` | blocked | supported | write | email address |
| `--is-superuser` | blocked | supported | write | make superuser |
| `--is-system-auditor` | blocked | supported | write | make system auditor |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | dry run without mutating |


### user edit

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--username <value>` | blocked | supported | write | username |
| `--password-file <value>` | blocked | managed equivalent | write | password file path (or - for stdin) AWX adapter rejects file inputs before execution Potential secret-bearing input: controlled delivery and redaction required. Controlled caller byte channel; no server paths. Preserve upstream stdin '-' semantics via that channel. |
| `--first-name <value>` | blocked | supported | write | first name |
| `--last-name <value>` | blocked | supported | write | last name |
| `--email <value>` | blocked | supported | write | email address |
| `--is-superuser` | blocked | supported | write | make superuser |
| `--no-superuser` | blocked | supported | write | remove superuser |
| `--is-system-auditor` | blocked | supported | write | make system auditor |
| `--no-system-auditor` | blocked | supported | write | remove system auditor |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | dry run without mutating |


### user delete

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | dry run without mutating |


### user list

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--search <value>` | supported | supported | read | search users |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |
| `--fields <value>` | blocked | supported | read | extra fields Omitted from the reviewed Artium flag schema |


### user show

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |


### notification list

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--status <value>` | supported | supported | read | filter by status |
| `--search <value>` | supported | supported | read | search notifications |
| `--template <value>` | supported | supported | read | filter by notification template id |
| `--job <value>` | supported | supported | read | scope by job id |
| `--workflow-job <value>` | supported | supported | read | scope by workflow job id |
| `--project-update <value>` | supported | supported | read | scope by project update id |
| `--inventory-update <value>` | supported | supported | read | scope by inventory update id |
| `--ad-hoc <value>` | supported | supported | read | scope by ad hoc command id |
| `--system-job <value>` | supported | supported | read | scope by system job id |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |
| `--fields <value>` | blocked | supported | read | extra fields Omitted from the reviewed Artium flag schema |


### notification show

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |


### notification-template create

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--name <value>` | blocked | supported | write | template name |
| `--organization <value>` | blocked | supported | write | organization id or name |
| `--notification-type <value>` | blocked | supported | write | backend type |
| `--configuration-file <value>` | blocked | managed equivalent | write | 0600 JSON configuration file AWX adapter rejects file inputs before execution Potential secret-bearing input: controlled delivery and redaction required. Controlled caller byte channel; no server paths. |
| `--config-file <value>` | blocked | managed equivalent | write | alias for configuration file AWX adapter rejects file inputs before execution Potential secret-bearing input: controlled delivery and redaction required. Controlled caller byte channel; no server paths. |
| `--messages-file <value>` | blocked | managed equivalent | write | JSON message templates file AWX adapter rejects file inputs before execution Potential secret-bearing input: controlled delivery and redaction required. Controlled caller byte channel; no server paths. |
| `--description <value>` | blocked | supported | write | description |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### notification-template edit

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--name <value>` | blocked | supported | write | template name |
| `--organization <value>` | blocked | supported | write | organization id or name |
| `--notification-type <value>` | blocked | supported | write | backend type |
| `--configuration-file <value>` | blocked | managed equivalent | write | 0600 JSON configuration file AWX adapter rejects file inputs before execution Potential secret-bearing input: controlled delivery and redaction required. Controlled caller byte channel; no server paths. |
| `--config-file <value>` | blocked | managed equivalent | write | alias for configuration file AWX adapter rejects file inputs before execution Potential secret-bearing input: controlled delivery and redaction required. Controlled caller byte channel; no server paths. |
| `--messages-file <value>` | blocked | managed equivalent | write | JSON message templates file AWX adapter rejects file inputs before execution Potential secret-bearing input: controlled delivery and redaction required. Controlled caller byte channel; no server paths. |
| `--description <value>` | blocked | supported | write | description |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### notification-template delete

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### notification-template test

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | write | Command help |
| `--confirm` | supported | supported | write | confirm live execution |
| `--dry-run` | supported | supported | write | preview without mutating |


### notification-template copy

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--name <value>` | blocked | supported | write | copy name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### notification-template list

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--search <value>` | supported | supported | read | search notification templates |
| `--type <value>` | supported | supported | read | template notification type (email, slack, webhook, etc.) |
| `--organization <value>` | supported | supported | read | filter by organization id |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |
| `--fields <value>` | blocked | supported | read | extra fields Omitted from the reviewed Artium flag schema |


### notification-template show

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |


### activity-stream list

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--operation <value>` | supported | supported | read | filter by operation |
| `--search <value>` | supported | supported | read | search activity events |
| `--job <value>` | supported | supported | read | scope by job id |
| `--project <value>` | supported | supported | read | scope by project id |
| `--inventory <value>` | supported | supported | read | scope by inventory id |
| `--template <value>` | supported | supported | read | scope by job template id |
| `--workflow <value>` | supported | supported | read | scope by workflow template id |
| `--workflow-job <value>` | supported | supported | read | scope by workflow job id |
| `--organization <value>` | supported | supported | read | scope by organization id |
| `--team <value>` | supported | supported | read | scope by team id |
| `--user <value>` | supported | supported | read | scope by user id |
| `--credential <value>` | supported | supported | read | scope by credential id |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |
| `--fields <value>` | blocked | supported | read | extra fields Omitted from the reviewed Artium flag schema |


### activity-stream show

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |


### team user-add

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--user <value>` | blocked | supported | write | user id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### team user-remove

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--user <value>` | blocked | supported | write | user id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### team credential-create

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--name <value>` | blocked | supported | write | credential name |
| `--credential-type <value>` | blocked | supported | write | credential type id or name |
| `--inputs-file <value>` | blocked | managed equivalent | write | 0600 JSON inputs file AWX adapter rejects file inputs before execution Potential secret-bearing input: controlled delivery and redaction required. Controlled caller byte channel; no server paths. |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | preview without mutating |


### team create

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--name <value>` | blocked | supported | write | team name |
| `--organization <value>` | blocked | supported | write | organization id or name |
| `--description <value>` | blocked | supported | write | description |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | dry run without mutating |


### team edit

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--name <value>` | blocked | supported | write | team name |
| `--organization <value>` | blocked | supported | write | organization id or name |
| `--description <value>` | blocked | supported | write | description |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | dry run without mutating |


### team delete

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | dry run without mutating |


### team list

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--search <value>` | supported | supported | read | search teams |
| `--organization <value>` | supported | supported | read | filter teams by organization id |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |
| `--fields <value>` | blocked | supported | read | extra fields Omitted from the reviewed Artium flag schema |


### team show

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |


### team users

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |


### team projects

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |


### team credentials

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |


### team roles

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |


### team object-roles

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |


### team access-list

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |


### role grant

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--user <value>` | blocked | supported | write | user id or username |
| `--team <value>` | blocked | supported | write | team id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | dry run without mutating |


### role revoke

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | supported | write | Command help |
| `--user <value>` | blocked | supported | write | user id or username |
| `--team <value>` | blocked | supported | write | team id or name |
| `--confirm` | blocked | supported | write | confirm live execution |
| `--dry-run` | blocked | supported | write | dry run without mutating |


### role list

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--search <value>` | supported | supported | read | search roles |
| `--type <value>` | supported | supported | read | filter roles by type |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |
| `--fields <value>` | blocked | supported | read | extra fields Omitted from the reviewed Artium flag schema |


### role show

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |


### role parents

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |


### role children

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |


### role users

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |


### role teams

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |
| `--limit <value>` | supported | supported | read | rows to return (1-1000) |
| `--all` | supported | supported | read | walk all pages within the row and page budgets |
| `--max-rows <value>` | supported | supported | read | row budget with --all (default and maximum 10000) |


### home

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |


### auth login

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | managed equivalent | managed equivalent | write | Command help Artium AWX account form accepts a PAT or exchanges username/password for a PAT; raw upstream login is blocked. Passwords and tokens use the managed credential store, never argv. |
| `--allow-http` | not applicable | not applicable | write | Opt into unencrypted HTTP; unavailable in Artium HTTPS accounts Managed AWX accounts require HTTPS; no HTTP opt-in equivalent Artium AWX account form accepts a PAT or exchanges username/password for a PAT; raw upstream login is blocked. Passwords and tokens use the managed credential store, never argv. |


### auth status

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |


### auth logout

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | managed equivalent | write | Command help Target managed PAT revocation, distinct from removing the account. |


### setup hooks

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | managed equivalent | managed equivalent | read | Command help Use artium-axi setup --host <claude\|codex\|opencode> --hook on Linux for authenticated ambient tool context and granted tool skills. Claude Code and Codex use SessionStart; OpenCode 1.19.x uses its local system-context plugin API. Codex host trust and feature controls still apply. Pi and non-Linux hosts retain skill-only setup. Never install hooks in the server runner. |


### profile list

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | managed equivalent | managed equivalent | read | Command help Use Artium account discovery and selection; upstream filesystem profiles are not caller-owned. |


### config path

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | not applicable | read | Command help Artium materializes private runner configuration. There is no client-owned upstream config path to expose. |


### doctor

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | supported | supported | read | Command help |


### update

| Upstream flag | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- |
| `--help` | blocked | not applicable | read | Command help The deployment pins awx-axi through tools/package.json and integrity.json. Upgrade through a reviewed Artium dependency change; per-run self-update is blocked. |
| `--check` | blocked | not applicable | read | Report current vs latest and exit without installing The deployment pins awx-axi through tools/package.json and integrity.json. Upgrade through a reviewed Artium dependency change; per-run self-update is blocked. |


## Nested inventory aliases

Artium accepts canonical leaf spellings rather than these upstream nested aliases.
Each alias inherits every positional and flag listed under its canonical command, including the four global selection flags and `--help`.
Today all alias invocations and their flags are blocked, including aliases whose canonical command is supported.
Their target is a documented managed equivalent: invoke the named canonical spelling through Artium, with that command's target flag decisions and authorization.
This preserves capability without requiring identical alias syntax.
The pinned group/source router joins trailing tokens into non-CRUD action names, including flags and positional values; those aliases cannot generally execute their intended operation.
Help is intercepted earlier and does not establish that the alias executes successfully.
Use the canonical route, including for affected aliases listed below.

| Upstream alias | Canonical managed equivalent | Artium status today | Target status | Authorization tier | Notes |
| --- | --- | --- | --- | --- | --- |
| `inventory host bulk-create` | `inventory host-bulk-create` | blocked | managed equivalent | write | Canonical spelling has the complete flag contract above. |
| `inventory host bulk-delete` | `inventory host-bulk-delete` | blocked | managed equivalent | write | Canonical spelling has the complete flag contract above. |
| `inventory group create` | `inventory group-create` | blocked | managed equivalent | write | Canonical spelling has the complete flag contract above. |
| `inventory group edit` | `inventory group-edit` | blocked | managed equivalent | write | Canonical spelling has the complete flag contract above. |
| `inventory group delete` | `inventory group-delete` | blocked | managed equivalent | write | Canonical spelling has the complete flag contract above. |
| `inventory group add-host` | `inventory group-add-host` | blocked | managed equivalent | write | Upstream non-CRUD group/source routing limitation; use canonical spelling. |
| `inventory group add host` | `inventory group-add-host` | blocked | managed equivalent | write | Upstream non-CRUD group/source routing limitation; use canonical spelling. |
| `inventory group remove-host` | `inventory group-remove-host` | blocked | managed equivalent | write | Upstream non-CRUD group/source routing limitation; use canonical spelling. |
| `inventory group remove host` | `inventory group-remove-host` | blocked | managed equivalent | write | Upstream non-CRUD group/source routing limitation; use canonical spelling. |
| `inventory group add-child` | `inventory group-add-child` | blocked | managed equivalent | write | Upstream non-CRUD group/source routing limitation; use canonical spelling. |
| `inventory group add child` | `inventory group-add-child` | blocked | managed equivalent | write | Upstream non-CRUD group/source routing limitation; use canonical spelling. |
| `inventory group remove-child` | `inventory group-remove-child` | blocked | managed equivalent | write | Upstream non-CRUD group/source routing limitation; use canonical spelling. |
| `inventory group remove child` | `inventory group-remove-child` | blocked | managed equivalent | write | Upstream non-CRUD group/source routing limitation; use canonical spelling. |
| `inventory source create` | `inventory source-create` | blocked | managed equivalent | write | Canonical spelling has the complete flag contract above. |
| `inventory source edit` | `inventory source-edit` | blocked | managed equivalent | write | Canonical spelling has the complete flag contract above. |
| `inventory source delete` | `inventory source-delete` | blocked | managed equivalent | write | Canonical spelling has the complete flag contract above. |
| `inventory source credential-add` | `inventory source-credential-add` | blocked | managed equivalent | write | Upstream non-CRUD group/source routing limitation; use canonical spelling. |
| `inventory source credential add` | `inventory source-credential-add` | blocked | managed equivalent | write | Upstream non-CRUD group/source routing limitation; use canonical spelling. |
| `inventory source credential-remove` | `inventory source-credential-remove` | blocked | managed equivalent | write | Upstream non-CRUD group/source routing limitation; use canonical spelling. |
| `inventory source credential remove` | `inventory source-credential-remove` | blocked | managed equivalent | write | Upstream non-CRUD group/source routing limitation; use canonical spelling. |
| `inventory source notification-add` | `inventory source-notification-add` | blocked | managed equivalent | write | Upstream non-CRUD group/source routing limitation; use canonical spelling. |
| `inventory source notification add` | `inventory source-notification-add` | blocked | managed equivalent | write | Upstream non-CRUD group/source routing limitation; use canonical spelling. |
| `inventory source notification-remove` | `inventory source-notification-remove` | blocked | managed equivalent | write | Upstream non-CRUD group/source routing limitation; use canonical spelling. |
| `inventory source notification remove` | `inventory source-notification-remove` | blocked | managed equivalent | write | Upstream non-CRUD group/source routing limitation; use canonical spelling. |
| `inventory host create` | `inventory host-create` | blocked | managed equivalent | write | Canonical spelling has the complete flag contract above. |
| `inventory host edit` | `inventory host-edit` | blocked | managed equivalent | write | Canonical spelling has the complete flag contract above. |
| `inventory host delete` | `inventory host-delete` | blocked | managed equivalent | write | Canonical spelling has the complete flag contract above. |
