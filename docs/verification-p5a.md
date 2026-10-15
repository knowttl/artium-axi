# P5a generic OIDC verification

Scope split approved by firstmate under the maintainer's standing rule for smaller, independently testable slices.
P5a delivers discovery-based provider settings, credentials and invitations, browser and CLI sign-in, multiple sign-in choices, per-provider callbacks and issuer mix-up defences.
P5b is a separate PR for arbitrary claim-name rules, saved-claim migration, role synchronization and the Who matches screen.
Review and Test scope decisions must preserve that split.

## Verification plan

1. Exercise generic provider creation, credential retention and replacement, issuer changes and explicit activation through the real admin API and pages.
2. Sign in through two fake providers concurrently configured, including identical subjects under different issuers, secret and certificate client authentication, and a generic invitation claim with the exact username guard.
3. Refuse a callback sent to another provider, a mismatched authorization-response issuer, a signed ID token with the wrong issuer, discovery issuer mismatch and discovery redirects.
4. Drive the bundled CLI through the real browser approval page with a generic provider while Entra remains available.
5. Keep the existing Entra browser/API suite green, run the aggregate local check, rebuild the derived CLI bundle and run fake-only container acceptance if the host permits the task-owned privileged builder.
6. Run no-mistakes with this plan and stop at a ready, mergeable PR targeting knowttl/artium-axi main; every PR creation must explicitly pass --repo knowttl/artium-axi -B main.
   Put this approved P5a/P5b split at the top of the PR body, followed by problem, consequence, fix and scope.
   Do not implement P5b during validation; scope-only findings are resolved by the approved split above.

## Evidence

The generic-provider API and fake-provider suite passed 18 checks, including discovery-selected Basic authentication with reserved characters in its canary secret and RSA certificate authentication.
Five new real-browser checks passed: generic settings/credential/activation, simultaneous Entra and generic sign-in choices, wrong-provider callback refusal, wrong-token-issuer refusal, and bundled CLI sign-in through the generic provider.
The existing admin-provider, browser-SSO and fake-provider focused suites passed 150 checks before the Basic fixture repair.
`pnpm check` passed: the current error reference, TypeScript lint, all 2,766 tests across 63 files, the build and AXI distribution checks.
`pnpm test:browser` passed all 72 real-browser checks in 417 seconds at b66d5542cb10f8bb699fb08dc178a263990d6caf.
The complete browser run includes the existing Entra flows and all five new generic-provider journeys.
A previous run was interrupted by a concurrent rebuild; the browser fixture cleanup now also handles a process that exited before teardown.
The passing browser run used a stable build with no concurrent compilation.
All provider requests use injected local fake transports; browser tests drive the real server-rendered pages through chrome-devtools-axi.
Production discovery uses verified TLS and rejects redirects away from the configured discovery URL.
Generic client secrets use the discovered authentication methods, preferring POST when available and otherwise Basic; omitted methods default to Basic.
Fresh installs have no providers, and every newly configured provider starts disabled.
Entra's tenant-specific settings and immutable tid + oid binding remain unchanged; generic identities use exact issuer + sub and invitation claims require preferred_username.
Generic providers currently grant tools through direct artium roles; arbitrary claim mapping belongs to P5b.
No CLI command definitions changed; the normal build regenerates its bundled command/help artifact.

## Container acceptance

`pnpm test:containers` exited 0 in 140,174 ms on Linux x64, Node v24.14.0 and Docker 29.8.1.
The fake-only runner, walking skeleton, Graph headless, fake-service, packaged CLI and backup/restore probes passed.
The private privileged builder was artium-test-build-f4146343-76c0-4032-97c1-bb8193f01ece.
The container evidence reported passed=true and cacheRemoved=true; the runner, probe containers, images, recovery volumes and private builder cache were removed by the gate.

| Evidence | Value |
| --- | --- |
| Tested head | 9b5f7245c02c8f72c5fb61f32b34c9c60aec9546 |
| Relevant input digest | e89f1fe0c997662a473a7c2e3a78072186de37b03774edf83c319ca7185a980a |
| Compiled output digest | 855448d4c31fe3554186060de92e33ee790200ebc04d3d08265b39ef6e0fd494 |
| Runner image | sha256:d82410fd923b8f8a8cb3936271ed8b601fcedf1078066bcc418d929593f55056 |
| Server and production fake image | sha256:d722f210259ea8b1af8139894e45c60c361db61cdf424aea418cef719f55c866 |
| Node-only and fake-service image | sha256:470015c1ab1577c19efce2e80cdad4afd9c682cf8f4dcf3dccae5abfd9113397 |

The evidence-recording commit after the tested head changes documentation only.
Relevant input and compiled-output digests must match the values above for reuse; pipeline code, test, pin, script or Docker changes require fresh container acceptance.

## Remaining acceptance

Private hygiene acceptance is performed by firstmate using its private deny list before merge.
The worker does not access that list.

Live validation: **PENDING (maintainer live Entra check)**.
The maintainer will perform the real Entra sign-in and invitation claim after the build.
Fake-provider browser acceptance is the local live-validation evidence; no real services or credentials are used here.
