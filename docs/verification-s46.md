# S46 AXI checklist and distribution

Run `node scripts/axi-check.mjs` or `pnpm test:axi` with the [development prerequisites](../README.md#development--testing).
The script completes compilation before importing the test server.
It uses the real Fastify app, SQLite authentication, password-change flow, policy, runner and bundled CLI, with the existing synthetic user fixture and fake executable at the adapter boundary.
An ephemeral HTTPS listener and test CA provide certificate-verified loopback transport.
Each invocation gets a fresh home and a minimal environment, without user credentials or agent settings.
All temporary files, calls and listeners are removed in `finally`.

The download routes are implemented in [cli-download.ts](../src/server/cli-download.ts).
They read the compiled bundle relative to the compiled server module, independent of its working directory.
Both responses identify the version and SHA-256; the checksum response names the downloaded `artium-axi.mjs` file.
The checklist downloads both over HTTPS, checks the digest with sha256sum, rejects deliberate corruption, checks metadata and byte equality, then renames the one-file bundle to the executable `artium-axi`.
It launches from a directory containing only that file, installs the three supported skills, executes the recorded Claude hook, changes a synthetic temporary password, signs in again and runs one fake first call.
Unknown hosts and unsupported hooks return actionable usage errors.

The ten script-visible checks are:

| Principle | Executed check |
| --- | --- |
| 1. Token-efficient output | Strict decoding with the pinned TOON decoder, plus upstream stdout checks under the [README output contract](../README.md#toon-output-behavior) |
| 2. Minimal default schemas | Three-field tools rows and a separate command/detail/help view |
| 3. Content truncation | `--full` reaches the adapter unchanged; both actual runner streams exceed 4 MiB and expose their truncation diagnostic |
| 4. Pre-computed aggregates | Counted home/tools arrays and all doctor pass lines through real HTTPS |
| 5. Definitive empty states | Removing the synthetic user's roles yields zero, a reason and an administrator contact |
| 6. Structured errors and exit codes | Usage and blocked-flag exit 2, disabled-tool exit 1, upstream exit 7 and separate stderr |
| 7. Ambient context | Embedded skill installation and execution of the installed opt-in hook's recorded command |
| 8. Content first | No-argument output contains current identity, roles and tools |
| 9. Contextual disclosure | The displayed tools suggestions execute through the CLI |
| 10. Consistent help | All local help commands have the same parsed layout; tool detail includes bundled upstream help |

The checklist reports only these observed portions as passing.
It prints human review items for principles 1, 2, 3, 7, 8, 9 and 10: representative token cost, sufficient fields, useful retained/full content, actual host loading and trust, home relevance, contextual command relevance across upstream output and concise help.
No script can certify those judgments from a synthetic fixture.
The emitted local help and next-command arrays now include TOON list markers, so strict decoding succeeds.

`pnpm test:containers` also runs a distribution journey through the production container server on the existing private fake-only network.
Its client uses the runtime pinned in the [standalone client Dockerfile](../test/walking-skeleton/Dockerfile) with only the probe and certificates mounted, without the repository, application packages or upstream tools.
It downloads through certificate-verified HTTPS, verifies the exact digest, launches the downloaded shebang executable with no sibling assets, installs all supported skills, changes the temporary password, signs in and completes one pinned Falcon read against the fake service.
Separate volumes keep this journey independent of the existing parity and canary probes.
The harness removes its task-owned containers, volumes, network and images.
Final-candidate head, input/output digests, image identities, timings and cleanup evidence belong in the delivery report.

The existing [S45 verification](verification-s45.md) owns reviewed host sources, setup paths, merge and hook-schema contracts, including unsupported-hook explanations.
No new host integration or guessed host path is introduced here.
Actual Windows/macOS execution, actual agent session loading and live server installation remain unverified captain acceptance.
