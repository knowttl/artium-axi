# Published Graph and Azure re-pin

The previous Graph and Azure pins omit the upstream live-test repairs.
Use the published `@knowttl/mg-axi` 0.1.7 and `@knowttl/az-axi` 0.1.8 artifacts so packaged Artium users receive those repairs.
This change updates package pins, registry integrity, the tools lockfile, generated inventories and schema, current version documentation and existing version expectations.

## Verification plan

Verify each downloaded npm registry tarball against its published SHA-512 integrity and `tools/integrity.json`.
Install with the repository's pnpm toolchain, regenerate inventories and the Graph headless schema with their owning scripts, and check their freshness.
Run `pnpm build`, `pnpm lint` and the focused upstream, CLI, admin-tool and adapter suites before handoff.
The no-mistakes pipeline owns full review, tests, documentation, lint and publication.
Run `pnpm check`, `pnpm test:containers`, Compose configuration validation and the private hygiene check against the final candidate.
Supply the private deny list only through the hygiene command's external input; never publish its contents or location.
Record container head, input/output digests, timings, image identities and cleanup in delivery evidence.
Use only fakes, synthetic identities and canary credentials.
Do not deploy, contact live services or alter the running live-test stack.

## Artifact evidence

Both registry tarballs matched their npm registry SHA-512 values and the committed integrity pins.
Generated inventories contain 124 Azure commands and 279 Graph commands.
These checks make no new live acceptance claim.

## Local results before handoff

Frozen installation, build, type checking, inventory/schema freshness and Compose configuration validation passed.
The eight focused suites exercised 448 tests; the initial run passed 447 and exposed one stale Azure version fixture in hosted discovery.
After updating that fixture, all 134 Azure adapter tests passed on rerun.
The private hygiene scan passed with zero matches across 421 files.
Full aggregate and container acceptance remain assigned to the no-mistakes validation handoff.
