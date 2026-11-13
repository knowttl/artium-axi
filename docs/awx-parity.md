# AWX capability parity

Tracks #237's capability inventory and delivery slices, including the S1 authorization model.
The [S0 published-package audit](parity/awx-axi.md) owns command and flag target decisions, managed equivalents, release sequencing and counts against `@knowttl/awx-axi@0.1.11`.
The generated [target authorization policy](awx-parity-matrix.md#target-authorization-policy) owns target permissions.
The exhaustive [command and flag matrix](awx-parity-matrix.md) and [JSON inventory](../tools/inventories/awx-axi-parity.json) describe the installed `awx-axi` version pinned in [tools/package.json](../tools/package.json) and [tools/integrity.json](../tools/integrity.json).

## Reproduction and freshness

With the frozen tools dependencies already installed, run these offline commands from the repository root:

```sh
node scripts/awx-parity.mjs --write
node scripts/awx-parity.mjs
```

The extractor imports upstream `DOMAINS` to enumerate every leaf, flag, positional contract and help string before the Artium inventory filters flags.
It calls upstream `main` only with `--help` and `update --help`, with an empty environment, to discover selection globals and SDK update flags without contacting a controller or registry.
Core commands come from top-level help, `AUTH_HELP` and `SETUP_HELP`.
Nested inventory aliases follow the pinned router in `dist/domains/inventory/index.js`.
The JSON records SHA-256 hashes of every upstream JavaScript source; effect classifications are reviewed against the plan write tags and `core/transport.js` gates.
Current status is compared with `tools/inventories/awx-axi.json` and the restrictions in `src/server/adapters/awx.ts`.
The existing upstream inventory freshness check now also checks both parity artifacts, so `pnpm test` rejects stale generated output.
Regeneration also fails until a reviewer classifies new upstream surface: every flag name needs a form in `flagForms`, credential-bearing flags on non-security writes need a conditional effect or reviewed exception, and `reviewedSurface` pins the command, alias and flag counts, a digest of the upstream surface and a digest of the inventory router.
A new upstream release must change those reviewed values in the same diff as its classifications; handlers still need review, which the digests do not replace.

## Reading the matrix

Each command and flag has an upstream effect, current Artium status, target slice and target authorization.
Use the [S0 decisions](parity/awx-axi.md) for target support and alias equivalents.
Upstream effect tags describe operation effects, not target administrator permissions.
The JSON carries upstream descriptions and help, input delivery requirements, reasons, conditional effects and alias relationships.
Four selection globals are listed once and apply across leaves; `--help` is included for every leaf, while `--version`, `-v` and `-V` apply to bare invocations.
Domain/group help is discovery, not another AWX operation.
Nested aliases have the canonical command's flag contract and are separately listed because Artium does not normalize them: each is a `managed equivalent` whose canonical command is the supported spelling.
The pinned router's non-CRUD group/source aliases join trailing flags and values into the action name, so these spellings cannot substitute for working canonical invocations.
Their JSON entries record this upstream limitation.

`supported` means the reviewed route or flag passes Artium validation, subject to upstream validation, managed account permissions and execution limits.
It does not claim live acceptance or complete upstream behavior for every value.
`blocked` includes unsupported routes and inputs; it does not imply that route help is refused.
Sensitive inputs use the [controlled input channel](client-reference.md#command-surface-and-subcommands); see the [current input boundary](safety.md#write-gates-by-tool) for supported inputs and remaining restrictions.
`managed equivalent` identifies an Artium-owned workflow rather than permission to execute the upstream command or override.
`not applicable` identifies a client-local operation with an explicit managed-deployment reason.
Target slices group delivery work; already supported rows, including those assigned to slice f, mean retain and verify behavior, not postpone existing support.

See the [AWX write boundary](safety.md#write-gates-by-tool) for current write permissions and blocked operation classes.
See the [client command reference](commands.md) for preview and confirmation behavior.
`auth login` and `auth logout` belong to client-local credential lifecycle, but also mint/revoke PATs upstream.
The managed account form already supports PAT entry or username/password token acquisition; removing an Artium account is not equivalent to revoking a PAT.

## Sensitive and file inputs

Every file flag, `--extra-vars @file`, and upstream stdin form is marked in the matrix.
Private keys, passwords, tokens and other credential fields belong inside credential `--inputs-file` JSON, `--password-file`, launch `--credential-passwords-file` JSON, or managed account credentials, never secret argv flags.
Notification configuration/messages, variables, module arguments and SCM URLs use the private structured input channel.
See [client input handling](client-reference.md#command-surface-and-subcommands) for S2's TD-066 file channel, structured flag syntax, supported stdin forms and response placeholders.
The [AWX write boundary](safety.md#write-gates-by-tool) owns supported input classes, SCM URL restrictions and retained-log limitations, private delivery guarantees and blocked paths or overrides.
Managed account PAT/password entry stays in Artium's existing credential storage workflow, rather than becoming command input.
Global `--config` refers to managed runner configuration and has no caller file-upload equivalent.
`auth login --allow-http` has no equivalent because managed AWX accounts require HTTPS.
`--playbook` names a file inside an AWX project, not an uploaded runner file.
See the [client command reference](commands.md) for managed stdout downloads, admitted output flags and bounded waits.

## Delivery slices

These work packages retain the earlier b-f labels; their target controls follow the [target authorization policy](awx-parity-matrix.md#target-authorization-policy).
S1 enabled the mutation routes in b-e; S2 adds secure structured, credential, notification and bulk file inputs.
These rows retain the remaining acceptance work and original grouping.

| Slice | Work and acceptance boundary | Required controls |
| --- | --- | --- |
| b | Retain reviewed ordinary configuration writes. Verify preview and confirmed requests against fake AWX endpoints. | [Current boundary controls](safety.md#write-gates-by-tool) apply. Secure inputs are delivered by c (S2). |
| c | Add secure inputs to credential create/edit/copy and team credential creation, structured and secret inputs, extra-vars files, notification input and stdin through TD-066. Verify preserved bytes, permissions, redaction and cleanup using canaries. | S0 target controls; secure input delivery as described above. |
| d | Retain deletions and add host bulk inputs, with explicit target/budget checks and unknown-outcome handling. Verify fake bulk success and partial/failure outcomes. | S0 target controls; confirmation and native gates. |
| e | Retain users, teams, roles, membership/admin changes, token lifecycle and credential associations; add secure-input variants from b/c. Verify denial before send and each granted operation against fakes. | S0 target controls; managed account scope and native security gate. |
| f | Audit upgraded upstream metadata and handler tags, resolve currently omitted read flags (`--fields`, stdout `--full`/`--ansi`/`--download`, job-events `--type`), record nested aliases as canonical equivalents and maintain managed lifecycle exceptions. Add semantic drift checks covering changed commands/flags, not only generated bytes. Delivered: flags admitted, bounded waits and managed download, reviewed-surface guard, and fake-backed acceptance journeys. | Preserve all controls; output downloads require managed artifacts, not server paths. |

All later acceptance uses synthetic identities, fake AWX endpoints and canary credentials.
No live tenant or appliance evidence is claimed here.

## Inventories and sources (S4)

See the [command reference](commands.md) for inventory and source operations, [structured input handling](client-reference.md#command-surface-and-subcommands) for variable formats and uploads, and the [AWX safety boundary](safety.md#write-gates-by-tool) for permissions and read redaction.
Acceptance scenarios in [the AWX inventory integration suite](../test/integration/awx-inventory.test.ts) use the public run API with the pinned CLI and fake AWX service, including credential-bearing writes, deletion, disabled-write and permission denials, private variable handling and later reads.

## Templates and workflows (S6)

The [command reference](commands.md) describes template/workflow variables, associations, graph edits and approval templates.
See [structured input handling](client-reference.md#command-surface-and-subcommands) for extra-variable formats and private input metadata.
Acceptance in [the AWX orchestration integration suite](../test/integration/awx-orchestration.test.ts) uses the public run API and fake AWX controller to verify association additions/removals, all graph edge types, approval nodes, private variable handling and interrupted node creation recovery through `template-nodes` and `template-node`.
The synthetic onboarding journey provisions inventory, a host and a canary SSH machine credential, attaches the credential to a template and submits a connectivity launch.
It verifies the controller request flow without executing a real playbook or contacting a target server.

## Schedules (S7)

See the [command reference](commands.md) for schedule inputs, associations and readback limitations, [structured input handling](client-reference.md#command-surface-and-subcommands) for private variables, and the [AWX safety boundary](safety.md#write-gates-by-tool) for write controls.
Acceptance in [the AWX orchestration integration suite](../test/integration/awx-orchestration.test.ts) verifies schedule creation, preview and edits with structured request payloads through the public run API.
It also verifies schedule show/list with writes disabled after an interrupted rename.
Fixed synthetic controller timing verifies that previews and edits which omit the recurrence rule preserve timing values; no scheduler waits or real jobs are used.
Extra-variable writes are verified against fake controller requests.

## Execution environments (S9)

S1's shared write path already admits execution-environment create/edit and supplies the native configuration and security gates under the single tenant writes switch.
The [command reference](commands.md) describes image settings and attachment of an existing registry credential by ID or name.
Acceptance in [the AWX resources integration suite](../test/integration/awx-resources.test.ts) verifies image configuration and credential attachment, preview without mutation and confirmed writes through the public run API against a fake controller.
It also verifies persisted image changes and read-only recovery after an interrupted rename.
See [S13](#copy-and-delete-s13) for copy/delete acceptance coverage.

## Organizations, users, teams and roles (S10)

S1's shared write path admits organization configuration and associations, team configuration and membership, user configuration and password inputs, role grant/revoke and token revocation under the single tenant writes switch.
See the [command reference](commands.md) for operations, privilege flags and private password-file/stdin handling.
Acceptance in the [AWX configuration](../test/integration/awx-configuration.test.ts) and [access](../test/integration/awx-access.test.ts) integration suites uses the public run API and pinned CLI against the fake controller to verify preview, confirmation, disabled writes, AWX permission denials, tenant isolation, exact configuration and association payloads, private password handling and audit.
Stateful journeys verify membership and role grant/revoke readback with writes disabled, privilege removal and interrupted username recovery, and authentication failure after PAT revocation.
Organization association requests are verified against the fake controller; see the [command reference](commands.md) for readback limitations.
The [token integration suite](../test/integration/awx-tokens.test.ts) verifies read/write token scopes, disabled writes, preview, confirmation, denied/malformed/uncertain creation without a result reference, caller and credential isolation, current permission checks, expiry, consumption and canary redaction.
See the [AWX security boundary](safety.md#write-gates-by-tool) for protected token delivery and managed logout, and [recovery guidance](runbook.md#retention-and-export) for lost results and token lookup limitations.

## Bulk hosts (S12)

See the [command reference](commands.md) for bulk host commands and file formats, the [AWX write boundary](safety.md#write-gates-by-tool) for permissions and private inputs, and [recovery guidance](runbook.md#retention-and-export) for partial or interrupted outcomes.
Acceptance in [the AWX inventory integration suite](../test/integration/awx-inventory.test.ts) verifies disabled writes, redacted previews without mutation, AWX permission denial, exact create payloads, rejected duplicate batches, mixed delete results, malformed host files, interrupted deletes reported as `UNKNOWN_OUTCOME`, and recovery through full and limited host reads against a fake controller.

## Copy and delete (S13)

The [copy/delete integration suite](../test/integration/awx-copy-delete.test.ts) exercises create/delete state transitions for organizations, inventories, hosts, groups, inventory sources, templates, workflows, workflow nodes, schedules, projects, execution environments, notification templates, users, teams and credentials through the public run API and pinned CLI against the fake controller.
For templates, workflows, projects, execution environments, notification templates and credentials, these journeys also copy a resource and delete the copy.
The suite covers preview, confirmation, disabled-write refusals, controller-denied deletions, audit, private input cleanup and canary redaction.
Interrupted project deletion and execution-environment copying cover `UNKNOWN_OUTCOME` and list-based reconciliation with writes disabled.
These synthetic scenarios do not establish live controller acceptance.
