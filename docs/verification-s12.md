# S12 verification

All credentials are synthetic canaries, and application requests go only to isolated fake services.
Live Falcon checks remain on the captain checklist in [the evidence ledger](evidence-ledger.md).
There is no hosted CI.

1. Run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test` and `pnpm check` against the final implementation commit.
   The adapter tests execute preparation, blocked arguments, secret-file failures and the real runner against the TLS fake.
2. Run `pnpm test:runner-container` for the mandatory Linux runner resource and cleanup checks.
3. Build the slice-owned production image with `node scripts/build-fake-service-image.mjs --production`.
   Run `node scripts/fake-services.mjs --falcon` after `pnpm build`.
   The existing S03/04 harness routes trusted Falcon names to the fake origin on internal Docker networks with an ephemeral CA.
   The actual pinned parser verifies that no aliases or short flags exist, repetitions select the last value, equals forms work and `--` is not a delimiter.
   Prepared canary files feed two-page detection reads, with and without the managed member CID.
   The emitted cursor advances the same-origin query from offset 0 to 1 and returns distinct hydrated records, with no continuation after the final page.
   Replaying each cursor under managed region us-2 yields VALIDATION_ERROR after authentication but before any detection query or hydration request.
   Token and API redirects are refused without a request to their destinations.
   Every unsafe override is refused with unavailable secret paths before the runner can send another request.
   The client has no default IPv4 route and cannot connect to the separate fake network.
4. Remove only the slice-owned `artium-axi:local` image after these checks.
   The harness removes its owned containers, networks and temporary certificates, and the builder removes its private cache.
5. Run `pnpm hygiene:check` with the private `ARTIUM_AXI_HYGIENE_DENY_LIST_FILE` against the final commit and again against the exact published head.
   Never print the private input.
   Record the head SHA, command results and deny-list SHA-256 in delivery evidence and the PR body.

Rerun frozen install, lint, tests, aggregate checks and private hygiene after pipeline source or test fixes.
Repeat the image and Falcon harness checks if preparation, parser inventory, transport fixtures or packaging changes.
Use no-mistakes with `--skip ci --verification-plan docs/verification-s12.md` for local validation and private PR delivery.
