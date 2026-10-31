# Contributing

[Build from source](#build-from-source) · [Local validation and delivery](#local-validation-and-delivery) · [Container acceptance](#container-acceptance) · [Compatibility policy](#compatibility-policy) · [Private hygiene check](#private-hygiene-check) · [Historical verification records](#historical-verification-records)

Use Linux and the Node and pnpm versions declared in [package.json](package.json).
The [source toolchain](#build-from-source) lists the remaining build prerequisites and approved native dependencies.
Develop only against fakes, synthetic identities and canary credentials.
Never contact real tenants, appliances or services during validation.
Keep code, documentation, fixtures and generated output generic.

## Build from source

Use Node 24.11.0+, pnpm 10.22.0, OpenSSL, Python 3, curl and sha256sum on Linux.

```sh
git clone https://github.com/knowttl/artium-axi.git
cd artium-axi
pnpm install --frozen-lockfile
pnpm build
node dist/cli/artium-axi.mjs --help
```

Use `node dist/cli/artium-axi.mjs` in place of `artium-axi` for the same login and discovery steps.
The root install also installs frozen upstream dependencies; native build approval is limited to argon2, better-sqlite3 and esbuild.
`pnpm build:npm` stages the public client in `dist/npm`; `npm pack --dry-run ./dist/npm` inspects its contents.

## Local validation and delivery

Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` verifies generated references, types, inventory and schema freshness, the test suite, compilation and the AXI/distribution checklist.
It does not run container acceptance or the private hygiene check.
Before publication, follow the [private hygiene requirements](#private-hygiene-check).

Every change ships from a feature branch through the local no-mistakes pipeline configured in [.no-mistakes.yaml](.no-mistakes.yaml).
Before submission, check the intended public outcomes across sibling callers and error paths using the review checklist in the gate configuration.
For startup changes, cover installed executable paths, every supported host hook, account replacement, cancellation and session-lock release.
For write changes, cover uncertain outcomes, rename recovery, native help and confirmation rules.
Repair the whole reported invariant together, then review the complete base-to-candidate diff, including earlier repairs and final documentation.
Batch documentation against the repaired behavior before final candidate review; focused checks do not replace the full final-diff review or required validation.
Keep valid findings, acceptance standards and the configured repair budget intact.
Coordinate overlapping upstream pin or generated-inventory changes while an approved change awaits merge, and refresh the base before expensive validation where practical.
Commit the changes before starting:

```sh
no-mistakes doctor
no-mistakes axi run --intent "Describe the requested outcome and acceptance criteria" --wait 8m
```

Keep the run in the foreground.
If the wait returns before completion, reattach with bare `no-mistakes axi run`.
Read each gate and follow its instructions until the pipeline reports checks passed.
Product and scope decisions require owner approval.
The repository declares `no_ci: true`: there is no hosted test CI, and local no-mistakes validation is the change gate.
Release automation is separate from local acceptance.

The local Test step uses `pnpm test:gate` (G1 affected-test selection).
It compares the working tree, staged changes and untracked inputs with the unique merge base of `HEAD` and `origin/main`.
Use `pnpm test:gate --base <commit>` only with a known ancestor when the default base is unavailable.
`pnpm test:gate --plan` prints the selected tests, commands, reasons, base, head and SHA-256 of repository input bytes and the Node version without executing checks.
Keep that output with the validation evidence.
Import dependents select module tests; explicit owners retain CLI bundles, installed package journeys and public API journeys for runtime changes.
Embedded skills run CLI and package checks rather than taking the documentation shortcut.
Generated inventories, schemas, dynamic fixtures, migrations, shared contracts, toolchain changes, unknown paths, deleted runtime inputs, missing or ambiguous bases, unchanged inputs and empty runtime test selections require the full suite.
Every selection checks `docs/errors.md` freshness with `scripts/errors-reference.mjs`.
Changes or deletions of `docs/awx-parity-matrix.md` also select `scripts/awx-parity.mjs`; these generated-reference edits and other documentation-only edits select no runtime tests.
README and license changes also run the package journeys that copy those files.
Freshness checks and types run for runtime changes.
Run `pnpm test:gate --full` before every release and at least weekly during active local development to catch missing ownership relationships.
`pnpm test` and `pnpm check` always retain the full suite, including release automation.
Each Vitest invocation prepares the standalone CLI and npm tarball once in a unique temporary directory and removes them after the run.
CLI and package journeys use private writable copies, install prefixes, npm caches and session directories rather than rebuilding shared `dist/` inputs.
Preparation always rebuilds from current source and package content; it does not reuse artifacts from previous invocations.
Selection does not waive the separate container acceptance or private hygiene requirements.

The [gate configuration](.no-mistakes.yaml) owns the validation-handoff evidence fields, reuse rules, repair requirements and documentation-stage policy.
The Test report includes the absolute path to the handoff outside the checkout and its raw logs and selection records, so a later run can receive them through `--verification-plan <file>`.
The verification plan is a UTF-8 file that identifies the saved handoff and the required offline checks, not a command string or a replacement for the baseline.
Keep process evidence uncommitted.

## Container acceptance

Run `pnpm test:containers` when required by the [gate configuration](.no-mistakes.yaml), which owns the triggering paths, exemptions and release requirements.

Docker must support a private privileged BuildKit worker and its task-owned tmpfs cache.
If the host forbids privileged containers, record acceptance as unverified and arrange a permitted host before delivery when the check is required.
Build before probing compiled output:

```sh
pnpm build
pnpm test:containers
```

The container command builds before its fake-only acceptance phases and removes its uniquely owned `artium-test-*` resources and BuildKit cache before returning.
Its production-image artifact probe also requires cgroup v2 memory and swap controls and the dedicated tmpfs and memory contract in the [runbook](docs/runbook.md#scope-and-prerequisites).
The probe exercises four concurrent maximum-size inert artifacts through the pinned native CLI, checking unchanged bytes, child RSS, container memory, zero swap and cleanup.
This local evidence does not establish live deployment acceptance or enable hosted downloads.
Use only isolated internal or no-network Docker networks and synthetic fixtures.
Pinned dependency and image downloads are permitted; application probes must never reach real services.
Never prune globally, change shared Docker settings or touch resources belonging to another run.

Record the command, exit status, timings, environment, tested head SHA, input digest and compiled-output digest emitted by container-inputs/container-evidence, plus image identities and cleanup results.
Reuse evidence only when relevant input and compiled-output digests match the candidate, and explain the relationship between the tested and candidate heads.
Changed relevant inputs require fresh checks.
A failed or refused required check remains unverified until resolved.
See the [release runbook](docs/runbook.md#npm-client-releases) for release evidence requirements.

## Compatibility policy

Deprecated aliases remain supported for one minor release after deprecation, then are removed.
Document the replacement and deprecation in user-facing migration guidance so callers can migrate during that window.
This policy does not introduce new aliases or remove existing ones in this change.

## Private hygiene check

Before publishing a candidate, commit and build it, then set `ARTIUM_AXI_HYGIENE_DENY_LIST_FILE` to an absolute path to the private deny list **outside the checkout** and run:

```sh
pnpm hygiene:check
```

The UTF-8 list contains one literal term per line, matched after trimming whitespace using context-independent Unicode simple case folding; blanks and case-equivalent duplicates are ignored.
Unset, unreadable, empty or in-tree lists fail.
Never copy real terms or the list into this repository.
Record only its revision or SHA-256, candidate commit and pass/fail result.

The check scans tracked, untracked and ignored files, generated output and every commit message reachable from `HEAD`, excluding only `.git` metadata and installed `node_modules` directories.
Supply intended release assets outside the checkout as additional `pnpm hygiene:check` arguments, keeping the list outside those directories too.
Symlinks, unreadable files and BOM-marked UTF-16/UTF-32 assets fail rather than reducing coverage; convert unsupported encodings to UTF-8.
Diagnostics report location (with one-based columns in the original text's UTF-16 code units) and normalized entry number without secret excerpts, and redact labels whose paths match a term using the same folding rule.
The scan cannot guarantee absence of unknown sensitive values and does not approve publication.


## Historical verification records

Historical verification records and the evidence ledger are preserved on [archive/internal-docs](https://github.com/knowttl/artium-axi/tree/archive/internal-docs/docs).
They describe evidence for historical candidates and do not establish acceptance for a new host or release.
Current installation and operation guidance lives in the [README](README.md) and [runbook](docs/runbook.md).
