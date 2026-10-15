# Browser SSO protocol verification

This is P3b-1 of two sequential slices within P3b.
It implements browser sign-in for already-linked Entra identities while provider activation remains unavailable.
P3b-2 adds invitation claiming with the expected-username guard, local account linking, rule role synchronization and labels.
P3c adds safe activation, break-glass policy, SSO reauthentication, provider sign-out, setup help and complete browser acceptance.

## Protocol boundary

The login page offers a plain link only for enabled Entra providers.
Production settings still create and retain disabled providers; only the synthetic test fixture seeds an enabled provider.
The start route uses tenant-specific discovery, encrypted client credentials, authorization code, S256 PKCE, nonce and query response mode.
Certificate authentication signs a client assertion with the certificate fingerprint; client-secret authentication is supported too.
An opaque Secure, HttpOnly, SameSite=Lax cookie identifies a bounded, process-local transaction; [ssoDefaults](../src/server/config.ts) owns its lifetime and capacity.
State is bound to the provider and callback URL and consumed before exchange, including failed callbacks.
A server restart invalidates pending sign-ins.
Provider or credential revision changes invalidate pending sign-ins.
ID token signatures are checked against JWKS, with exact issuer, audience, authorized party when present, expiry, issue time and nonce validation.
Entra identity lookup uses provider, issuer and the immutable `tid:oid` subject.
Unknown identities are refused without account creation or automatic username linking.
Provider tokens are discarded after validation and never stored in artium sessions or audit.
Successful session creation and its sign-in audit event commit atomically.
Audit records identify the SSO method, provider, subject when validated and user when linked.
An explicit same-site Continue link on the callback document allows Strict session cookies to reach the account page.
SSO sessions carry no recent-auth privilege before P3c.

## Local checks

Use only local fake services, synthetic identities and canary credentials.
Run `pnpm exec vitest run test/integration/browser-sso.test.ts test/fake-service/oidc.test.ts` for protocol and provider checks.
The integration cases cover invalid audience, authorized party, nonce, expiry, future issue time and immutable identity claims; transaction expiry; missing browser binding; provider changes; disabled users; audit rollback and callback rate limits.
Run `pnpm build` before browser probes.
Run `node --test test/browser/sso-protocol.mjs` for real-page sign-in against the fake provider through a cross-site HTTPS proxy.
Browser cases prove the CSP-compatible start link, absent Strict cookies on the cross-site callback, accepted Strict cookies after the document hop, refusal of uninvited users, tampered signatures, wrong issuers and callback replay.
Run `pnpm check` and `pnpm test:browser` for aggregate and existing browser regressions.
Run `pnpm test:containers` when the host permits the task-owned privileged BuildKit worker, retaining digest-bound evidence and cleanup results.
An unsupported container host is unverified, never a pass.
Firstmate owns the private deny-list check before merge; workers must not seek that list.

## Publication and live acceptance

Create the pull request through `gh-axi` with `--repo knowttl/artium-axi -B main`.
The pull request must state the problem, consequence, fix and P3b-1 scope, including the P3b-2 and P3c follow-ups.
Live acceptance remains **PENDING (maintainer live Entra check)**: one real Entra sign-in and one invitation claim on the test copy.
The fake-provider browser suite supplies local protocol evidence, not live acceptance or invitation claim evidence.
Wrong-username, reused-link and expired-link claim browser checks belong to P3b-2.
Stop at a ready, mergeable pull request and do not merge.
