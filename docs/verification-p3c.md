# SSO reauthentication and sign-out verification

This is P3c-1, following invitation claims and role synchronization.
P3c was split before implementation so each PR can be reviewed and exercised independently.
This slice adds browser SSO reauthentication, pending-form resumption and optional provider sign-out.
See [P3c-2 verification](verification-p3c2.md) for break-glass acceptance and [P3 activation verification](verification-p3c2b.md) for completed P3 browser acceptance.
The README owns current [provider activation and setup](../README.md#sign-in-settings).
CLI SSO/device approval and generic OIDC remain later phases.

## Behaviour

Each new SSO browser session stores its sign-in identity reference, without retaining provider tokens.
See the [upgrade runbook](runbook.md#backup-restore-and-upgrade-rollback) for existing-session compatibility.
Explicit reauthentication uses the same authorization code, PKCE, nonce, state and bounded single-use transaction protocol as sign-in, with `prompt=login`.
It requires an integer `auth_time` at or after the transaction start, allowing at most 30 seconds of future clock skew.
It must return the same immutable identity and revalidate the initiating session, user, identity, provider and credential revision before granting recent-auth privilege.
Successful confirmation and its SSO `reauth` audit record commit atomically.
Other sessions retain their own confirmation state.
Ordinary sign-in still grants no recent-auth privilege.

The admin confirmation dialog opens a popup and keeps the pending form in the original document.
No draft or credential is persisted in browser storage for reauthentication.
The callback's Continue link establishes a same-site hop before Strict cookies are required.
The popup signals its opener using the existing external script under the strict CSP.
The original page verifies the message source and origin, then reads the server's confirmation state and verifies the same session before resubmitting once.
Cancel, closing the popup or failed confirmation leaves the draft in place.
The standalone `/reauth` page also offers the Microsoft confirmation link for SSO users.
Local password confirmation follows the [local-password policy](../README.md#sign-in-settings).

Sign-out revokes the artium session and family before any optional provider discovery or navigation.
The Microsoft checkbox uses the bound provider's discovered HTTPS end-session endpoint, client ID and same-origin `/login` return URI.
The signed-out document offers a plain Continue link because the strict CSP blocks a cross-origin redirect from a form submission.
No provider token is stored or sent as a logout hint.
Unavailable discovery or end-session support leaves artium signed out and explains that the provider session may still be active.
An unchecked option stays on artium's login page.

## Local verification

Use only synthetic identities, canary credentials and the local fake provider.
Run `pnpm exec vitest run test/integration/browser-sso.test.ts test/integration/browser-auth.test.ts test/fake-service/oidc.test.ts`.
These exercise fresh, stale, missing and malformed authentication times; identity/session binding; revocation and expiry; audit rollback; replay; sign-out destinations and provider failure, alongside existing protocol and local-password contracts.
Build with `pnpm build` before browser checks.
Run `node --test test/browser/sso-protocol.mjs` for the popup, pending role-form resumption, cancellation, stale authentication refusal and optional provider sign-out through the real pages.
The same suite retains CSP-compatible start links, the Strict-cookie callback hop, uninvited-user refusal, tampered signatures, wrong issuers, callback replay and invitation claim cases.
Run `pnpm check` and `pnpm test:browser` for aggregate validation.
Run the mandatory fake-only `pnpm test:containers` when the host permits its task-owned privileged BuildKit worker and retain its digest-bound evidence and cleanup results.
Record unsupported container acceptance as unverified.
Firstmate owns the private deny-list check; workers must not seek that list.

### Implementation evidence

`pnpm check` passed with 62 Vitest files and 2,682 tests, TypeScript, build and AXI distribution checks.
The four focused popup, cancellation, stale-authentication and provider-sign-out browser cases passed, followed by all 58 cases in `pnpm test:browser`.
`pnpm test:containers` exited 0 in 137,080 ms on Linux x64 with Node v24.14.0.
The task-owned privileged BuildKit worker was permitted, and `cacheRemoved: true` confirms cleanup.
The container run used the complete implementation working tree atop parent `cc5038c07bef8a740cad435aeaa681de37a4f172`; the delivery commit records those same source inputs and verification documentation.
Its input digest was `69bd71752d177de7f751c84494a9e717a55f7e7dda0403b45d72aaab0936d894` and compiled-output digest was `74d9b0f93340d75184acf3561cfa5916f5a13283de86817538f6ff29b2f49e0e`.
The run recorded image identities `sha256:0eb9ea2bfc31dce9e0ade3ac1c0d2b8e4c9c804982a5b6540d86b9fdb7ccf571`, `sha256:522c76e72cbac0ede8cfdc0edbd6496a03b956c6d1b785e0d4a762ea9e34c6aa` and `sha256:470015c1ab1577c19efce2e80cdad4afd9c682cf8f4dcf3dccae5abfd9113397`.
Runner limits and exhaustion, walking skeleton, fake Graph/Azure services, production package execution, backup and restore all passed.
Reuse this evidence only if the final candidate retains both digests; subsequent pipeline source fixes require fresh container acceptance.

## Publication and live acceptance

The PR body must state the problem, consequence, fix, this slice's scope and its P3c-2 follow-up.
Create it through `gh-axi` with `--repo knowttl/artium-axi -B main`.
Stop at a ready, mergeable PR and do not merge.
Live acceptance remains **PENDING (maintainer live Entra check)**: one real Entra sign-in and one invitation claim on the test copy.
The maintainer deferred those live checks until after the build; they do not hold this merge.
The fake-provider browser suite supplies local evidence only.
