---
name: awx-axi
description: "Manage AWX 24.6.1 automation from the shell - inspect, create, edit, copy, delete, launch, cancel, associate, and configure controller resources with dry-run previews and gated writes. Use for AWX or Ansible Tower jobs, templates, workflows, hosts, inventories, projects, schedules and their launch-time prompt overrides, organizations, credentials, notifications, execution environments, teams, users, roles, and maintenance runs."
user-invocable: false
author: knowttl
metadata:
  hermes:
    tags: [awx, ansible, automation, devops, jobs, workflows]
    category: devops
---

# awx-axi

Manage AWX automation from the shell.
Prefer this CLI over manual AWX web UI operations or custom REST calls for AWX and Ansible Tower.

Invoke it without a global install with `npx -y awx-axi <command>`.
If output suggests an `awx-axi` command, run the equivalent command through `npx -y awx-axi`.

Configure a profile with an HTTPS `origin`, optional `verifySsl`, and a token SecretRef, or set `AWX_AXI_ORIGIN` and `AWX_AXI_TOKEN` for an environment profile.
Use `--config` / `AWX_AXI_CONFIG` and `--profile` / `AWX_AXI_PROFILE` to select configuration.
Inspect configuration with `config path`, `profile list`, and `auth status`.
Login credentials use `AWX_AXI_USERNAME` and `AWX_AXI_PASSWORD`.
Stored PATs are origin-bound; logout revokes them before local deletion and needs `AWX_AXI_ALLOW_DELETES=1`.
See https://github.com/knowttl/artium-axi/blob/main/docs/credential-standard.md for protected storage and SecretRefs.
Use `awx-axi auth login` only when minting a token is authorized.

## When to use

Use awx-axi for the complete supported AWX management surface: inspect resources, create and edit configuration, copy resources, delete resources, launch and cancel runs, manage associations, and manage RBAC subjects.
All mutating commands preview the request as TOON by default.
A mutation is sent only with `--confirm`, and the matching environment safety gate must also be enabled.

Use `job` for unified job history, stdout, events, host summaries, cancellation, relaunch, and bounded polling.
Use `template` and `workflow` to manage launch templates, inspect workflow-template nodes and topology separately from workflow-job-run nodes, manage edges and notification associations, credentials, labels, instance groups, and launches.
Use `project`, `inventory`, `host`, `group`, `inventory-source`, and `schedule` to manage SCM projects, inventory topology and sources, hosts across inventories, groups and source history, bulk host operations, syncs, schedules, and schedule associations.
For the AWX 24.6.1 smart inventory API, use `inventory create <name> --kind smart --organization <id|name> --host-filter 'name__icontains=web'`; supplying `--host-filter` implies `--kind smart`.
AWX documents smart inventories as deprecated and encourages constructed inventories for new configurations, but this controller's smart inventory support remains available.
Use `organization`, `credential`, `execution-environment`, `notification-template`, `team`, `user`, and `role` for identity, security, RBAC, notifications, and execution configuration.
Common reads include `schedule list`, `execution-environment list`, `organization list`, `credential show <id|name>`, `user show <id|name>`, `system-job-template show <id|name>`, and `system-job notifications`.
`approval list` defaults to pending approvals, limited to 20 rows.
Use `approval list --include-decided --limit 50` to include approved or denied approvals within that row limit.
The former meaning of `approval list --all` is replaced by `--include-decided`.
`--all` now walks pages while preserving the pending-only default; combine it with `--include-decided` to include decided approvals.
See [TOON output behavior](https://github.com/knowttl/awx-axi#toon-output-behavior) for supported collection commands, pagination controls, budgets, and completeness metadata.

## Safety and secrets

Never put a token, password, credential input, notification secret, or private key on the command line.
Use the documented 0600 file flags for secret-bearing inputs.
Credential and identity writes, role grants, team credential creation, and token operations require `AWX_AXI_ALLOW_SECURITY_WRITES=1`.
Ordinary configuration writes require `AWX_AXI_ALLOW_CONFIG_WRITES=1`.
Deletes require `AWX_AXI_ALLOW_DELETES=1`.
Operational actions such as launches, tests, syncs, and cancellation use the operational path.
`AWX_AXI_READ_ONLY=1` blocks every mutation at the transport boundary.
Do not use write commands against a controller that has been designated read-only.

## Workflow

1. Run `npx -y awx-axi` for the current controller dashboard.
2. Run `npx -y awx-axi auth status` to verify the configured credential.
3. List and inspect the object before changing it: `<noun> list` and `<noun> show <id|name>`.
4. Run the mutation without `--confirm` to inspect its dry-run payload.
5. Re-run with `--confirm` and the required `AWX_AXI_*` gate only after the preview is correct.
6. Follow contextual `help` suggestions for the next read, watch, or rollback action.

## Commands

commands[24 total]:
`job`: list, show, stdout, events, hosts, launch, cancel, relaunch, watch.
`template`: create, edit, copy, delete, list, show, object-roles, survey, launch, credential-add/remove, instance-group-add/remove, label-add/remove, notification-add/remove.
`workflow`: create, edit, copy, delete, list, show, object-roles, survey, launch, nodes, template-nodes, template-node, label-add/remove, node-create/edit/delete/link/unlink, node-add-approval, node credential/label/instance-group add/remove, notification-add/remove.
`approval`: list, show, approve, deny.
`project`: create, edit, copy, delete, list, show, playbooks, updates, roles, sync, notification-add/remove.
`inventory`: create, edit, delete, sync, host-create/edit/delete, host-bulk-create/delete, group-create/edit/delete, group-add-host/remove-host, group-add-child/remove-child, source-create/edit/delete, source-credential-add/remove, source-notification-add/remove, list, show, groups, hosts, sources, updates, constructed-list, constructed-show.
`host`: list, show.
`group`: list, show.
`inventory-source`: list, show.
`schedule`: create, edit, delete, list, show, credential-add/remove, label-add/remove, instance-group-add/remove.
`execution-environment`: create, edit, copy, delete, list, show.
`organization`: create, edit, delete, user-add/remove, admin-add/remove, team-add/remove, instance-group-add/remove, execution-environment-add/remove, galaxy-credential-add/remove, notification-template-add/remove, notification-add/remove, list, show.
`credential`: create, edit, copy, delete, list, show, object-roles.
`user`: create, edit, delete, token-create, token-revoke, list, show.
`team`: create, edit, delete, credential-create, user-add/remove, list, show, users, projects, credentials, roles, object-roles, access-list.
`role`: grant, revoke, list, show, parents, children, users, teams.
`system-job-template`: launch, list, show.
`system-job`: cancel, list, show, events, notifications.
`notification-template`: list, show <id|name>, create, edit, copy, delete, test.
`notification`: list, show <id> only.
`activity-stream`: list, show <id> only.
`ad-hoc`: launch, list, show, stdout, events.
`auth`: status, login, logout.
`setup`: hooks.

System-job and notification records are generated by AWX.
AWX exposes no create, edit, or delete operation for those records, and notification has no write endpoint.
Built-in system-job-template definitions are also read-only; only their launch endpoint is supported.
Read-only generated commands: notification list, show <id>; activity-stream list, show <id>.
Use the actual resource nouns above instead of inventing CRUD commands for generated history.

## Output and errors

Output is machine-readable TOON on stdout.
Errors include a stable code and actionable help.
Mutation previews show the HTTP method, route, and redacted payload.
Structured sensitive fields are redacted regardless of value length, including token values returned while creating a token.
Registered secrets of at least eight characters are also replaced in free text; shorter values may appear in free text.
Use per-command `--help` for positional arguments, flags, defaults, and examples.

Run `npx -y awx-axi --help` for top-level usage, or `npx -y awx-axi <command> --help` for a focused reference.

## Tips

- Use numeric ids when a name could be ambiguous.
- Use `--dry-run` explicitly when composing a command in automation.
- Use `job watch <id>` after a launch, sync, or system job.
- Use 0600 JSON files for credential inputs, notification configurations, notification messages, token-adjacent values, and other secret-bearing data.
- Use `inventory host-bulk-create` and `inventory host-bulk-delete` for AWX's genuine bulk host endpoints.
- Use `inventory edit <id|name> --host-filter <filter>` to update a smart inventory's host filter.
- Use `host list` to search visible hosts across inventories, or `host show <id|name>` for groups, variables, and facts.
- Use `group list` and `group show <id|name>` for direct host and child-group membership with parsed variables.
- Use `inventory-source list` and `inventory-source show <id|name>` for source configuration, update state, and direct update history.
- Use `workflow template-nodes <id|name>` and `workflow template-node <id>` for editable workflow-template nodes, prompts, runtime context, convergence, and success/failure/always edges. These are distinct from `workflow nodes <run-id>`, which reads a workflow job run.
- `notification list` and `activity-stream list` remain read-only because AWX does not expose object mutation endpoints for those generated records.
- Use `schedule create`/`schedule edit` with `--inventory`, `--limit`, `--extra-vars <json|@file>`, `--job-tags`, and `--skip-tags` to set a schedule's launch-time prompt overrides; each is rejected before the write if the job template's matching `ask_*_on_launch` setting is disabled.
