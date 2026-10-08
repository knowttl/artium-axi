# S27 local verification

This slice implements T2.7 offline master key rotation.
All checks use disposable stores, synthetic keys and fake services.
No real key, tenant, deployment or production maintenance is exercised.

Run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test` and `pnpm check` against the final implementation commit.
Run the mandatory `pnpm test:runner-container` check and the real private hygiene scan documented in README.
Record command outcomes, the validated head and the deny-list digest in the PR body.
Rerun these checks if a pipeline fix changes source or tests.

The focused checks are `pnpm exec vitest run src/server/store/rotate-key.test.ts test/integration/rotation.test.ts`.

- The real maintenance command rejects unknown arguments with exit 2 and rotates without the development authentication gate.
- A running real server blocks rotation, maintenance blocks startup, and a killed server releases the shared lock.
- Failed later-row updates, receipt insertion and audit insertion roll back every encrypted row and receipt.
- Restart rejects the old key after successful rotation, even for an empty store.
- A SIGKILL after commit and before receipt output leaves durable recovery evidence and accepts the new key.
- Three encrypted credentials survive rotation through their actual store, resolver and adapter preparation interfaces.
- The pinned Vectra binary reads a fake HTTPS appliance using the rotated token.
- Falcon injects its rotated canaries into a real runner child, and Azure executes fake MSAL transport followed by a real runner child checking its token and generated profile.

Falcon and Azure checks here prove rotation and injection, not additional pinned-service or live platform acceptance.
The existing pinned-upstream suites remain part of local validation.
Azure runtime activation remains deferred as recorded in S26.
See [the runbook](runbook.md) for the one-shot container command and both recovery boundaries.
