# Browser SSO protocol verification

P3b is delivered in two sequential slices.
P3b-1 implemented browser sign-in for already-linked Entra identities before provider activation was available.
P3b-2 adds invitation claiming with the expected-username guard, local account linking, rule role synchronization and labels.
P3c-1 added [SSO reauthentication and optional provider sign-out](verification-p3c.md).
See [P3 activation verification](verification-p3c2b.md) for the completed P3 scope and fake-provider browser acceptance.

## Protocol boundary

The login page offers a plain link only for enabled Entra providers.
The README owns [provider activation and setup](../README.md#sign-in-settings).
The start route uses tenant-specific discovery, encrypted client credentials, authorization code, S256 PKCE, nonce and query response mode.
Certificate authentication signs a client assertion with the certificate fingerprint; client-secret authentication is supported too.
An opaque Secure, HttpOnly, SameSite=Lax cookie identifies a bounded, process-local transaction; [ssoDefaults](../src/server/config.ts) owns its lifetime and capacity.
State is bound to the provider and callback URL and consumed before exchange, including failed callbacks.
A server restart invalidates pending sign-ins.
Provider or credential revision changes invalidate pending sign-ins.
ID token signatures are checked against JWKS, with exact issuer, audience, authorized party when present, expiry, issue time and nonce validation.
Entra identity lookup uses provider, issuer and the immutable `tid:oid` subject.
Without a valid invitation, unknown identities are refused without account creation or automatic username linking.
Provider tokens are discarded after validation and never stored in artium sessions or audit.
Successful session creation and its sign-in audit event commit atomically.
Invitation links bind their hashed token to the pre-auth transaction and are checked again after token exchange.
Claims require an exact, case-sensitive preferred username match and an unused, unexpired, unrevoked link for the same provider.
Replaced links and already-bound identities are refused.
New accounts receive invitation direct grants without administrator capability.
Local links retain the account id, username, profile, administrator flag and history, clear the password and revoke prior sessions and tokens.
At each sign-in, only the signing-in provider's rule-origin grants are synchronized; direct and other-provider grants remain intact.
Audited rule deletion or changes to its provider, claim, value or target role remove that rule's grants, including grants retained by archived users, under the existing recent-authentication requirement.
Direct grants and grants from other rules remain intact; failed changes roll back grant removal with the rule mutation.
Claim, identity-link, role-sync and sign-in audits commit in the same transaction as account, identity, grant and session changes.
Role-sync audit arguments identify added and removed rule origins, which reference their target roles.
Audit records identify the SSO method, provider, subject when validated and user when linked.
An explicit same-site Continue link on the callback document allows Strict session cookies to reach the account page.
Ordinary SSO sign-in carries no recent-auth privilege; P3c-1 adds explicit SSO reauthentication.

## Local checks

Use only local fake services, synthetic identities and canary credentials.
Run `pnpm exec vitest run test/integration/browser-sso.test.ts test/fake-service/oidc.test.ts` for protocol and provider checks.
The integration cases cover invalid audience, authorized party, nonce, expiry, future issue time and immutable identity claims; transaction expiry; missing browser binding; provider changes; disabled users; audit rollback and callback rate limits.
Run `pnpm build` before browser probes.
Run `node --test test/browser/sso-protocol.mjs` for real-page sign-in against the fake provider through a cross-site HTTPS proxy.
Browser cases prove the CSP-compatible start link, absent Strict cookies on the cross-site callback, accepted Strict cookies after the document hop, refusal of uninvited users, tampered signatures, wrong issuers and callback replay.
They also cover successful invitation claim, wrong-username refusal, reused and expired links, local linking, role synchronization and Direct/Entra rule labels on the real user page.
Integration cases additionally cover revocation, resend and expiry during exchange, old-session and bearer-token revocation, other-provider grant preservation and claim audit rollback.
Run `pnpm check` and `pnpm test:browser` for aggregate and existing browser regressions.
Run `pnpm test:containers` when the host permits the task-owned privileged BuildKit worker, retaining digest-bound evidence and cleanup results.
An unsupported container host is unverified, never a pass.
Firstmate owns the private deny-list check before merge; workers must not seek that list.

## Publication and live acceptance

Create the pull request through `gh-axi` with `--repo knowttl/artium-axi -B main`.
The pull request must state the problem, consequence, fix and P3b-2 scope, including the P3c follow-up.
Include the rule-management behaviour: deletion and retargeting clear only that rule's grants, so archived users cannot permanently block rule changes.
P3b-2 stacks on https://github.com/knowttl/artium-axi/pull/77, which must merge first; the pull request still targets main.
Live acceptance remains **PENDING (maintainer live Entra check)**: one real Entra sign-in and one invitation claim on the test copy.
The fake-provider browser suite supplies local protocol and invitation claim evidence, not live acceptance.
Stop at a ready, mergeable pull request and do not merge.
