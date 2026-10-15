# Generic OIDC claim rules verification

P5b completes generic-provider claim rules, saved-claim migration, sign-in synchronization and the Who matches screen.
Entra continues to accept only the `roles` claim and retains its existing token validation and grant behavior.
Rules never set administrator capability.

## Focused evidence

The generic-provider, admin-provider, Entra browser-sign-in and provider-store suites passed 159 checks.
The admin-provider suite subsequently passed all 72 checks including the new audited generic claim-name change case.
The populated-store migration check upgrades a copy of a version-18 store, preserves saved role values, rules and grants, reruns the migration and validates foreign keys without changing the original.
Two fake providers simultaneously synchronize independent array and scalar claims; removal preserves direct and other-provider grants.
Issuer mix-up tests remain in the same focused suite.
The real-page browser check adds a generic rule, previews only that provider's matching user, edits its claim name, verifies the empty result and removes it, checking all three audit events.
The final focused browser run passed all eight checks for generic settings, simultaneous providers, named rules, callback and issuer mix-ups, CLI approval, saved-claim previews and existing Entra account-linking/role synchronization.
`pnpm lint`, the generated error-reference check and `pnpm test:axi` passed, including the packaged CLI distribution journey.
The normal build regenerates the bundled CLI command/help artifact; no command definitions changed.

## Final verification plan

Run the configured `pnpm test` baseline once through no-mistakes, plus `pnpm lint`, generated-reference freshness, build and AXI distribution checks from `pnpm check` as needed without duplicating the unchanged baseline.
Run `pnpm test:browser` against the real pages with the existing isolated chrome-devtools-axi harness and injected fake providers.
Include generic named-claim rule editing, Who matches, simultaneous providers, issuer mix-up refusal and the existing Entra invitation and synchronization journeys.
Complete the build before browser or container probes and keep compiled output stable while they run.
Run `pnpm test:containers` using only its uniquely owned fake-only resources if the host permits its self-removing privileged BuildKit builder.
Record command, exit status, timings, environment, head SHA, input/output digests, image identities and cleanup from container-inputs/container-evidence.
If the host forbids the builder, record the container gate as not run.
Firstmate performs the private deny-list check on the PR diff before merge; the worker does not access that list.
Create the PR against main in the designated repository, with problem, consequence, fix and P5b scope in its body.
Confirm the final PR is ready and mergeable, report the pushed head SHA, and leave merging to firstmate.

## Remaining acceptance

Live validation: **PENDING (maintainer live Entra check)**.
The maintainer's real Entra sign-in and invitation claim happen after the build.
The fake-provider browser suite supplies local acceptance evidence; no real tenant or credentials are used.
