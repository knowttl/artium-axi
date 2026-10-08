# S44 suggestion rewriting verification

T6.4 rewrites only the root `help` suggestion field recorded in the pinned inventories.
The parser validates JSON or TOON before inserting `artium-axi ` at command offsets for the invoked tool.
It preserves the original bytes around each insertion rather than serialising output again.
The TOON parser recognises the pinned primitive suggestion list variant without list markers, checking declared counts before rewriting.
Unsupported shapes, malformed formats, incomplete quoted commands and explicitly truncated streams remain unchanged.
The TOON dependency matches the upstream lockfile pin, version 2.3.1.

## Behavioural evidence

`src/cli/rewrite.test.ts` exercises every empty, error and suggestion capture committed in `test/fake-tool/fixtures/upstreams.json`, including the future Graph fixture without enabling Graph in the runtime.
Exact output assertions prove that only suggestion commands change, followed by a second rewrite proving idempotence.
Additional cases cover quoted commands, arguments containing quotes, escaped multiline strings, TOON list markers, CRLF, JSON Unicode escapes, nested unrelated help fields, wrong tools, duplicate fields, unknown suggestion shapes and malformed or truncated output.
`test/cli.test.ts` exercises the standalone bundle over local trusted HTTPS with synthetic tokens, separate TOON stdout and JSON stderr, upstream exit 7 and stream-specific truncation.
The bundled test failed against the original passthrough with both prefixes absent and exit 7 preserved.
The first full-suite run exposed existing timeouts in the 30-attempt address-limit test and the multi-hash password-change flow.
Their test budgets now accommodate real Argon2 work under concurrent suite load without weakening assertions or production hashing settings.
`test/walking-skeleton/probe.mjs` compares the pinned Falcon and Vectra tools against the bundled client through the real fake-only container server, permitting the wrapper prefix only in root suggestion fields.
AGENTS.md's existing README pointer remains factually correct and requires no change.

## Final candidate verification plan

Run `pnpm install --frozen-lockfile`, then `pnpm check`, then `pnpm test:containers` in sequence against the committed implementation candidate.
Run `ARTIUM_AXI_HYGIENE_DENY_LIST_FILE=<private absolute path> pnpm hygiene:check` using the task's authorised private deny list, without printing its contents.
Container acceptance uses only fakes, synthetic identities and canary credentials, with task-owned resources removed by the harness.
Record final head SHA, command results, timings, container input and compiled-output digests, image identities, cleanup and deny-list revision in the PR body.
Every pipeline source or test repair requires renewed frozen install, aggregate checks, container checks and real private hygiene on the repaired candidate.
Run no-mistakes with `--skip ci` and this verification plan, without `--yes`.
Re-scan the exact published head before delivery and record the no-mistakes per-step timings.
No hosted CI, real service calls, tenant credentials, deployment or merge are part of this verification.
Live output parity and any unsupported real capture formats remain deferred captain checks.
