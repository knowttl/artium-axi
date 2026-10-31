# AWX capability parity

Tracks #237's capability inventory and delivery slices, including the ordinary configuration writes implemented in slice b.
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
Regeneration detects metadata drift, but does not prove classifications for a new upstream release: slice f must review changed handlers, aliases, flags, controls and managed equivalents.

## Reading the matrix

Each command and flag has an upstream effect, current Artium status, target slice and required administrator control.
Flags inherit their containing command's conditional security controls and restrictions.
The JSON carries upstream descriptions and help, input delivery requirements, reasons, conditional effects and alias relationships.
Four selection globals are listed once and apply across leaves; `--help` is included for every leaf, while `--version`, `-v` and `-V` apply to bare invocations.
Domain/group help is discovery, not another AWX operation.
Nested aliases have the canonical command's flag contract and are separately listed because Artium does not normalize them.
The pinned router's non-CRUD group/source aliases join trailing flags and values into the action name, so these spellings cannot substitute for working canonical invocations.
Their JSON entries explicitly record this upstream limitation for slice f.

`supported` means the reviewed route or flag passes Artium validation, subject to upstream validation, managed account permissions and execution limits.
It does not claim live acceptance or complete upstream behavior for every value.
`blocked` includes routes rejected even for `--help` or `--dry-run`, flags omitted from the adapter schema and all file/stdin input.
`managed equivalent` identifies an Artium-owned workflow rather than permission to execute the upstream command or override.
`not applicable` identifies a client-local operation with an explicit managed-deployment reason.
Target slices assign future work; slice f on already supported rows means retain and verify behavior, not postpone existing support.

See the [AWX write boundary](safety.md#write-gates-by-tool) for current write permissions and blocked operation classes.
See the [client command reference](commands.md) for preview and confirmation behavior.
The proposed destructive and security authorizations remain requirements for later slices.
All write classes must retain managed account access, upstream permissions, confirmation, write coordination, audit and unknown-outcome handling.

Upstream tags matter: credential association operations are security writes, and inventory-source and execution-environment create/edit become security writes when `--credential` is supplied.
Notification-template create/edit become security writes with configuration or message input.
Credential, project, execution-environment and notification-template copies are tagged security upstream; template and workflow copies are configuration writes.
Deleting a security resource is tagged delete upstream and must also receive security authorization in Artium's target policy.
`user token-revoke` uses an upstream security-tagged DELETE, so the target also needs destructive authorization even though upstream does not check its delete gate there.
`auth login` and `auth logout` belong to client-local credential lifecycle, but also mint/revoke PATs upstream.
The managed account form already supports PAT entry or username/password token acquisition; removing an Artium account is not equivalent to revoking a PAT.

## Sensitive and file inputs

Every file flag, `--extra-vars @file`, and upstream stdin form is marked in the matrix.
Private keys, passwords, tokens and other credential fields belong inside credential `--inputs-file` JSON, `--password-file`, launch `--credential-passwords-file` JSON, or managed account credentials, never secret argv flags.
Notification configuration/messages, variables, module arguments and SCM URLs are marked as potentially secret-bearing structured input.
Slice c must deliver caller-owned file or secret bytes through the **TD-066 file channel**, materializing only bounded private runner leaves, with scanning, redaction and cleanup.
No flag may read an arbitrary server file path.
This includes stdin values represented upstream by `-`: credential inputs and user passwords must use the same controlled channel.
Managed account PAT/password entry stays in Artium's existing credential storage workflow, rather than becoming command input.
Global `--config` refers to managed runner configuration and has no caller file-upload equivalent.
`auth login --allow-http` has no equivalent because managed AWX accounts require HTTPS.
`--playbook` names a file inside an AWX project, not an uploaded runner file.
`job stdout --download` is an output path and needs a managed artifact equivalent; it must never write a caller-selected server path.

## Delivery slices

| Slice | Work and acceptance boundary | Required controls |
| --- | --- | --- |
| b | Implements the reviewed ordinary configuration writes in the [current boundary](safety.md#write-gates-by-tool). Verify preview and confirmed requests against fake AWX endpoints. | Current boundary controls apply. Credential/secret-bearing variants wait for c/e. |
| c | Add credential create/edit/copy and team credential creation, structured and secret inputs, extra-vars files, notification input and stdin through TD-066. Verify preserved bytes, permissions, redaction and cleanup using canaries. | Administrator write and security authorization for credentials/secret configuration; retain each operation's base controls. |
| d | Enable deletions and host bulk operations, with explicit target/budget checks and unknown-outcome handling. Verify fake bulk success and partial/failure outcomes. | Separate destructive authorization for deletes, configuration authorization for bulk create, security authorization when deleting security resources; confirmation and native gates. |
| e | Enable users, teams, roles, membership/admin changes, token lifecycle and credential associations, including conditional security variants from b/c. Verify denial before send and each granted operation against fakes. | Separate security authorization; destructive authorization for revocation/deletion; managed account scope and native security gate. |
| f | Audit upgraded upstream metadata and handler tags, resolve currently omitted read flags (`--fields`, stdout `--full`/`--ansi`/`--download`, job-events `--type`), normalize nested aliases and maintain managed lifecycle exceptions. Add semantic drift checks covering changed commands/flags, not only generated bytes. | Preserve all controls; output downloads require managed artifacts, not server paths. |

All later acceptance uses synthetic identities, fake AWX endpoints and canary credentials.
No live tenant or appliance evidence is claimed here.
