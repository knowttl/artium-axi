# P5a generic OIDC verification

The maintainer approved the P5a/P5b scope split.
P5a delivers discovery-based provider settings, credentials and invitations, browser and CLI sign-in, multiple sign-in choices, per-provider callbacks and issuer mix-up defences.
P5b is a separate PR for arbitrary claim-name rules, saved-claim migration, role synchronization and the Who matches screen.

Current setup, supported provider requirements and role-assignment limits belong to [Sign-in settings](../README.md#sign-in-settings).

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
No CLI command definitions changed; the normal build regenerates its bundled command/help artifact.
The later CLI polling repair retries transient `DEVICE_POLL_LIMITED` responses without abandoning approval.
[CLI device regression tests](../test/cli-device.test.ts) cover resumed approval, terminal errors and deterministic expiry through clock and timer boundary fakes.

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

These container results precede the CLI polling and expiry-test repairs and are historical evidence, not acceptance of those later inputs.
Relevant input and compiled-output digests must match the values above for reuse; pipeline code, test, pin, script or Docker changes require fresh container acceptance.
The outer validation pipeline owns final-candidate results and cleanup evidence.

## Remaining acceptance

Private hygiene acceptance is performed by firstmate using its private deny list before merge.
The worker does not access that list.

Live validation: **PENDING (maintainer live Entra check)**.
The maintainer will perform the real Entra sign-in and invitation claim after the build.
Fake-provider browser acceptance supplies local protocol evidence, not maintainer live acceptance; no real services or credentials are used here.
