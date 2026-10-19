# Contributing

Use Linux and the Node and pnpm versions declared in [package.json](package.json).
The [source toolchain](README.md#build-from-source) lists the remaining build prerequisites and approved native dependencies.
Develop only against fakes, synthetic identities and canary credentials.
Never contact real tenants, appliances or services during validation.
Keep code, documentation, fixtures and generated output generic.

## Local validation and delivery

Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` verifies generated references, types, inventory and schema freshness, the test suite, compilation and the AXI/distribution checklist.
It does not run container acceptance or the private hygiene check.
Before publication, commit and build the candidate, set `ARTIUM_AXI_HYGIENE_DENY_LIST_FILE` to the absolute path of the private deny list outside the checkout, then run:

```sh
pnpm hygiene:check
```

Never copy the list or its terms into the repository or public review artifacts.
Record only the list revision or SHA-256, candidate SHA and pass/fail result.
Include intended release assets outside the checkout as additional arguments.
See [private hygiene requirements](#private-hygiene-check) for scan coverage and refusal conditions.

Every change ships from a feature branch through the local no-mistakes pipeline configured in [.no-mistakes.yaml](.no-mistakes.yaml).
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
