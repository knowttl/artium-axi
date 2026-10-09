# S49 local runbook rehearsal

Scope is T7.5, the local runbook and generic-command rehearsal.
The [S48 review substitution and limitations](verification-s48.md) stand; no separate security review, embedded-store exception or live deployment was performed.
The [runbook](runbook.md) retains the owner decisions on the Password and Secrets Standard, master-key escrow and operational retention policy.

## Local environment and method

Rehearsal ran on disposable Linux x86_64 stores and a fresh synthetic client home on 2026-10-08.
The local toolchain was Node v24.17.0, pnpm 10.22.0 and Docker 29.8.1.
The baseline was `bb0eee1d53b36f46e831e069e5820b95679d4180`, latest `origin/main` when the task branch was created.
Only documentation changed; runtime source and packaging inputs remain at that baseline.
Every runbook command was executed with synthetic files and task-owned volume/image names substituted for the generic absolute paths, volume names and image tag.
Passwords were passed through stdin or protected files, never arguments.
No application request contacted a real tenant, appliance or upstream service.

The one-off rehearsal used the repository's ephemeral certificate fixture and readiness observer, a loopback HTTPS test proxy, the real production server entry point and the downloaded standalone CLI.
It used the real maintenance launcher and encrypted SQLite store for offline commands.
Its scratch scripts and synthetic state were removed after verification; no extra operational automation is shipped.

## Command results

`pnpm install --frozen-lockfile`, `pnpm build`, `pnpm start`, `pnpm check` and `docker compose -f compose.example.yaml config --quiet` completed successfully.
The aggregate passed 50 test files and 1,864 tests, type checking, generated-reference freshness, build and Linux AXI/distribution checks.
The test-suite duration was 81.02 seconds.

The local rehearsal executed both HTTPS downloads with the synthetic CA, checksum verification, executable rename/mode, and checksum-file removal.
It executed all three setup hosts, including the Claude hook, temporary-password login (expected exit 1 with `PASSWORD_CHANGE_REQUIRED`), forced password change, new login, identity, tools, tool detail, doctor, ordinary password change and logout.
All succeeded except the intentional temporary-password restriction and an expected `TOOL_NOT_GRANTED` detail request for the newly bootstrapped administrator with no tool grants.
The aggregate's fake-adapter CLI checklist separately verified the successful granted Falcon detail and first-call paths and cached-healthy doctor output.
Both curl health commands returned HTTP 200 and `status: ok` through verified synthetic HTTPS.
The server's audit stdout stream emitted committed JSON-line events into the disposable capture.

Online backup completed while the real server held the maintenance lock.
After shutdown, the local backup, recovery, master-key rotation and restore commands all returned exit 0.
A synthetic encrypted Falcon credential and role grant survived backup/restore and key rotation.
The documented rotation-receipt SQL returned the durable old/new key IDs.
Restored tokens were absent, retained audit records and role grants were present, and the restored store accepted a fresh login with the matching backup key.
The recovered store restarted with the rotated key, required a password change and accepted a fresh login after that change.

`pnpm test:containers` returned exit 0 in 160.704 seconds with `passed: true` and `cacheRemoved: true`.
It exercised runner bounds, clean Linux distribution, pinned Falcon and Vectra fake reads, native write gates, synthetic secret-output refusal, and non-root backup/restore with old-token rejection.
Its input digest was `7147fda7e6fa8fc000a8dd98add46333ea387789dd1c14bcc4da5186a1569097` and compiled-output digest was `bd13b2573c19b608e13cf62a883246afce0908cb7e5d15a1978b0dc876e411f6`.
The production server image identity was `sha256:8f147c48218b2a89f7dece78d989ae46050b2e3a68e6aa9d63d6f85354c48383`, and the clean Node 22.12 client image was `sha256:1d0274fb8467281ab377b40e1e5442ab8ab69a665ce7b5f85649a925ad5d46ad`.
The fake-service image was `sha256:5b34a45edccbef2f6b5da60598b81702819e9ae16241ce3f60bb192194e660db` and the runner image was `sha256:59e53b2e5937f335624df1cbc046e4fefaf5af2be825fc2e04a7e5aed3f09053`.
Their build times were 57.602, 2.710, 1.745 and 12.319 seconds respectively, with the later identical production-image build taking 3.790 seconds on the private cache.

The separate container-command rehearsal returned exit 0 in 74.477 seconds, including its private production-image build of 57.323 seconds.
Image identity was `sha256:b981bced55b43cfc0b09237ccb8f634f12652ae67fab613af2ac8ae3b4df42b3`.
It executed the runbook's recovery and rotation container examples and the container backup/restore invocations with synthetic bind-mounted files and uniquely named volumes.
All four commands passed as UID 10001 with `--network none --read-only --tmpfs /tmp`.
Its owned volumes, image and private builder were removed; the aggregate container block also removed all owned containers, networks, volumes, images and cache.
The differing rehearsal image identities are recorded as observed build outputs, not asserted reproducible image digests.

The mandatory private hygiene scan passed with zero matches across 445 candidate files after scratch cleanup.
The private deny-list SHA-256 was `bddd1b07500f81245fc34634459368648db992b7127d66ff94330849eda45ad2`; no list terms were printed or copied into the repository.
The committed candidate is rescanned before handoff, and the no-mistakes pipeline owns publication and final-head validation.

## Limits and owner acceptance

The full local suite supplies fake-time retention and migration/refusal evidence; the rehearsal did not wait 90 days or claim a real historical-image upgrade.
Snapshot restore and current-image migration were exercised, while selecting and accepting actual previous/candidate deployment digests remains an owner step.
Live host provisioning, filesystem ownership on the deployment host, reverse-proxy/firewall installation, production certificate renewal, live client trust, actual agent host skill/hook loading, upstream credential issuance/revocation and live platform permissions were not exercised.
Windows and macOS execution remain unverified.
No external export collector, backup schedule, deletion policy, Password and Secrets Standard exception or master-key escrow destination was chosen.
