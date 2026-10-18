# Hosted CLI and authentication fixes

## Verification plan

Reproduce the authentication, doctor, Azure input, audit-redaction and unknown-flag regressions through the existing public API, standalone CLI and adapter interfaces using fakes and synthetic identities.
Run the affected suites, including browser authentication and Azure recovery, with:

```sh
pnpm exec vitest run test/cli.test.ts test/integration/api.test.ts test/integration/browser-auth.test.ts test/integration/azure-write-recovery.test.ts test/integration/azure-read-format.test.ts src/server/adapters/az.test.ts src/server/auth/attempts.test.ts
pnpm lint
pnpm build
docker compose -f compose.example.yaml config --quiet
```

Run the private hygiene check with its externally supplied deny-list input after committing and building the candidate.
The no-mistakes pipeline owns review, aggregate validation and publication.
Follow the [container-test prerequisites](../README.md#development--testing) for privileged-worker requirements and unverified acceptance.
Do not use a live stack, tenant, appliance or real credentials for these checks.

## Scope and regression evidence

Before the fixes, the focused regression selection failed for all five bugs: successful authentication exhausted the username limit, refusals lacked audit records, doctor failed the certificate diagnostic for a liveness error, Azure input never reached the API, piped help retained a bare executable, positional Graph KQL remained visible, and unknown flags returned HTTP-body guidance.
See [CLI input behavior](../README.md#command-surface-and-subcommands) for the supported query/body stdin routes and reviewed file uploads.
The [CLI regression checks](../test/cli.test.ts) cover bounded input, unreadable files and no-input Azure commands completing with stdin left open.
Runbook updates cover secret ownership, proxy header replacement and stable addressing, first-start bootstrap, startup health dependencies, privileged test requirements, scripted bearer administration and scoped image cleanup.
Minor display ergonomics remain outside this change.

## Local results

The six affected suites passed all 404 tests in 122.88 seconds.
Type checking, compilation and Compose configuration validation passed.
Container acceptance was not run because this host forbids privileged containers; it remains unverified.
These results establish fake-only local behavior and do not establish live acceptance.
