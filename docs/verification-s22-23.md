# S22+S23 local verification

T2.4 supplies Vectra credential preparation, the reviewed boundary and native write policy.
T2.6 retains the existing streaming scanner and extends end-to-end evidence through the bundled CLI and upstream redaction probes.
All credentials and identities are synthetic, and every service is a local fake.
Real appliance acceptance remains deferred to the captain after the full build.

Run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test` and `pnpm check` on the final implementation commit.
Run `pnpm test:walking-skeleton` and `pnpm test:runner-container` for mandatory container acceptance.
Run the real private hygiene scan against the exact committed and built candidate, without printing the list.
Record the final SHA, results and timings in the delivery status and PR body.
Source or test changes during validation require renewed checks.

The adapter tests execute pinned Vectra 0.1.3 against the fake HTTPS appliance using QUX token, QUX OAuth and RUX OAuth profiles.
Each variant uses its own generated profile and trusted private CA, with certificate rejection and zero requests when CA trust is removed.
Unsafe config/profile overrides, delimiter attempts, setup commands and server file paths fail before credential retrieval.
Retrieved credentials that fail the schema are refused before child execution.
Profile preparation assertions verify the native write policy described in [README.md](../README.md).

The API test compares the native dry-run result locally and through the audited runner.
Dry runs, disabled writes, out-of-scope operations, missing or wrong confirmation and native platform denial produce zero mutations.
One confirmed tag replacement reaches the fake once.
The mode 0600 native intent/outcome journal remains after private call directories disappear, and Artium's terminal event identifies the requesting user.
Uploaded tags and piped stdin use the real upstream parser and file consumer.
A recorded mutation followed by HTTP 503 sends once and advises read-back.
A dropped response sends once, returns the native uncertain-result guidance and records `OUTCOME_UNKNOWN`.
Other mutation families are not proven by this tag-replacement case.

The walking-skeleton harness extends its internal Docker network with a fake appliance origin.
It seeds an encrypted Vectra credential and uses the production server entry point and pinned executable paths.
Read and preview output and missing-confirmation refusal match local execution through the bundled CLI.
The confirmed write and protected native journal prove that call cleanup preserves evidence.
Only newly created `artium-test-*` resources are removed.

The current scanner behavior is documented in [README security boundaries](../README.md#security-and-acceptance-boundaries).
Existing tests cover short values, every byte split, separate stream overlap and scanning across and beyond the 4 MiB retention cap.
New bundled CLI tests receive `SECRET_IN_OUTPUT` for every encoding on both streams, with no captured stream returned and safe tool-named terminal audit.
An empty secret is refused, and no short-value threshold bypasses scanning.

Pinned Vectra redaction probes echo injected and OAuth-minted canaries from fake detection detail responses.
Raw injected secrets and raw minted access/refresh tokens are redacted by the upstream CLI.
A base64-encoded minted access token remains visible because upstream redaction does not cover that form and Artium cannot know a token minted inside the child.
The Falcon container probe similarly echoes a canary-minted token in a displayed field and reports whether it is visible.
These probes characterize exact local paths, rather than proving comprehensive redaction.
Exact-value scanning cannot detect unknown generated tokens, arbitrary transformations, substrings or every possible encoding.
Live Falcon and Vectra redaction re-probes, real appliance authentication and permissions, native logs on the deployment host and later Graph redaction remain on the captain checklist.
