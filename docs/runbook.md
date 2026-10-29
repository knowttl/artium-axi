# Operations runbook

Contents:

- [Scope and prerequisites](#scope-and-prerequisites)
- [Platform limits](#platform-limits)
- [npm client releases](#npm-client-releases)
- [Verify a later published image](#verify-a-later-published-image)
- [Proxy and certificate trust](#proxy-and-certificate-trust)
- [TLS inspection and private upstream CAs](#tls-inspection-and-private-upstream-cas)
- [Trusting one tool from the administration UI](#trusting-one-tool-from-the-administration-ui)
- [CLI launchers and password changes](#cli-launchers-and-password-changes)
- [Scripted administrator sessions](#scripted-administrator-sessions)
- [Roles, credentials and health](#roles-credentials-and-health)
- [Falcon RTR execution](#falcon-rtr-execution)
- [Retention and export](#retention-and-export)
- [First administrator and offline recovery](#first-administrator-and-offline-recovery)
- [Offline master key rotation](#offline-master-key-rotation)
- [Backup, restore and upgrade rollback](#backup-restore-and-upgrade-rollback)
- [Upgrading stores without a key binding](#upgrading-stores-without-a-key-binding)

## Scope and prerequisites

This runbook covers local operation of the packaged server and client, npm client releases and GHCR server-image releases.
Exercise changes first in disposable Linux stores with synthetic identities, canary credentials and fake upstream services.
Live host provisioning, proxy deployment, client installation and live adapter acceptance belong to the owner and have not been exercised here.
The local rehearsal and its limitations are recorded in [S49 verification](https://github.com/knowttl/artium-axi/blob/archive/internal-docs/docs/verification-s49.md).
The [README](../README.md), [Dockerfile](../Dockerfile), [Compose example](../compose.example.yaml) and [server configuration](../src/server/config.ts) own installation, packaging and executable defaults.

The Linux deployment host needs Docker with Compose, space for persistent SQLite data and protected backups, and a trusted HTTPS reverse proxy.
Use the pinned image inputs and record the resulting immutable image identity for recovery; do not treat the mutable `artium-axi:local` tag as a rollback identity.
The image runs as UID 10001 with a read-only root filesystem, writable `/data`, and a 256 MiB `/tmp` tmpfs.
The Compose example sets a 6 GiB memory limit, 192-process limit and an init process.
See the [supported capability boundaries](safety.md) for hosted Hybrid Analysis, Check Point, Microsoft Graph and BeyondTrust download availability and [the approved Hybrid Analysis design](hybrid-download-design.md) for its native transfer contract.
These tools share an internal artifact owner that requires a separate, dedicated `/tmp/artium-artifacts` tmpfs of exactly 1 GiB, owned by UID 10001 with mode 0700 and explicit `noexec,nosuid,nodev` mount flags.
It refuses ordinary directories, symlink components, disk fallback, missing cgroup v2 memory evidence, swap allowance and insufficient memory headroom.
The container needs at least 6 GiB of bounded memory with no swap; admission reserves 250 MiB per artifact and budgets 768 MiB resident memory per native child, in addition to the full 1 GiB artifact capacity.
The executable host admission contract is in [src/server/artifacts.ts](../src/server/artifacts.ts); transfer limits are defined in [src/shared/api.ts](../src/shared/api.ts).
Set Docker `--memory` and `--memory-swap` to the same positive value, and verify cgroup v2 `memory.swap.max=0` and `memory.swap.current=0`; the artifact owner checks both before admission.
This prevents tmpfs pages written by the container from entering swap without depending on the optional `noswap` mount spelling, which Docker's `--tmpfs` parser rejects.
See [Docker's swap-limit contract](https://docs.docker.com/engine/containers/resource_constraints/#prevent-a-container-from-using-swap) and the [kernel cgroup v2 swap controller](https://docs.kernel.org/admin-guide/cgroup-v2.html).
Four reservations globally and one per user include incomplete files and remain charged until deletion succeeds.
The ten-minute deadline begins at preparation, cancels generation or delivery, and never extends on activity.
Startup purges stale entries before admission and marks pending transfer metadata interrupted; shutdown stops consumers before unlinking.
Cleanup failure emits a fixed operator diagnostic and blocks admission until cleanup is retried successfully.
The ordinary `/tmp` mount in the Compose example does not satisfy this contract; the example does not provision the dedicated artifact mount.
The server initializes the artifact owner before serving, purging stale bytes even when writes are off; unavailable host admission keeps transfers unavailable.
Missing or invalid dedicated storage blocks artifact admission.
Use fake-only container acceptance to establish mount, maximum-size native RSS and concurrent memory headroom before enabling downloads; an unavailable or refused host check remains unverified.
Operators must arrange security-team-approved, narrowly scoped AV/EDR handling for the dedicated artifact mount and controlled client download directory, exclude the mount from backups and core dumps, and prevent swap capture before enabling downloads.
Never disable protection globally or exclude `/data`, tool installations or a general downloads directory.
Artium does not automatically change AV/EDR policy.
Security software can quarantine or lock even compressed samples, causing delivery failure, changed availability or blocked cleanup; resolve those failures under the approved narrowly scoped policy.
Use a dedicated controlled Linux analysis client and dedicated private download directory, without sync, indexing or automatic opening.
Keep subsequent analysis outside Artium.
See CLI saving for [Hybrid Analysis archives](client-reference.md#hybrid-analysis-archive-saving), [Check Point emails and attachments](client-reference.md#check-point-email-and-attachment-saving) and [Microsoft Graph mail](client-reference.md#microsoft-graph-mail-saving) for destination requirements and verified saving, and [the account screen](admin-guide.md#browser-administration) for browser guidance and metadata.
Live malware: this archive may contain executable malware.
Save only; do not extract or execute.
Password protection is unverified; bytes are saved exactly as provided.
Upstream success, completed server delivery and a client verified-save receipt are separate outcomes; missing receipt is unconfirmed.
For `/v1/transfers/hybrid/*`, `/v1/transfers/checkpoint/*`, `/v1/transfers/mg/*` and `/v1/transfers/beyondtrust/*`, reverse proxies must disable caching, request/response body logging, response transformation, automatic retries and range/resume handling, and preserve backpressure and disconnect cancellation.
Unlinking frees temporary storage and does not promise forensic erasure.
Provision data directories for that UID with mode 0700 and key files readable only by the intended runtime and owner.
The Compose example mounts the initial master-key file read-only.
Non-swarm Compose file secrets retain host ownership, so mode-0600 files owned by the operator are not readable by the image's UID 10001.
After preparing the master-key file and exact bootstrap-password file, make both readable by that UID on a standard rootful Docker host:

```sh
sudo chown 10001:10001 ./private/artium_master_key ./private/artium_bootstrap_password
sudo chmod 600 ./private/artium_master_key ./private/artium_bootstrap_password
```

The bootstrap file contains UTF-8 password bytes with no added newline; the master-key file contains exactly 32 raw bytes.
Keep their host directory protected and retain operator access through the approved privileged account.
For rootless Docker or user-namespace remapping, use the mapped host UID corresponding to container UID 10001.
See [master-key custody](#backup-restore-and-upgrade-rollback) for key formats and the saved local copy.
The owner decides key creation; the synthetic key used in rehearsal is not a production provisioning recommendation.

For source-based local rehearsal, use the [source toolchain](../CONTRIBUTING.md#build-from-source).
From the repository root, run:

```sh
pnpm install --frozen-lockfile
pnpm check
docker compose -f compose.example.yaml config --quiet
pnpm test:containers
```

The Compose validation creates no stack and reads no secret contents.
Container acceptance uses only task-owned fake networks, stores and images and removes them before returning.
Check the [container-test prerequisites](../CONTRIBUTING.md#container-acceptance) before running `pnpm test:containers`; arrange verification on a permitted host when local container acceptance is unverified.
Do not use real adapter credentials or globally prune Docker resources.

## Platform limits


Linux client and Linux amd64 container paths have local fake-service acceptance.
Windows/macOS execution, token storage and actual agent-host loading remain unverified.
Local tests do not establish live vendor permissions or production host acceptance.
LDAP uses simple bind over verified TLS; ambient Kerberos, per-user upstream credentials and external secret stores are unsupported.
Azure has reviewed bounded input/upload support; ADO and AWX reject stdin and file uploads.
See [client input handling](client-reference.md#command-surface-and-subcommands) for Hybrid Analysis uploads and explicit JSON stdin, and [Safety](safety.md) for its capability boundaries.
See [adapter limits](tool-credentials.md) and [deployment requirements](runbook.md#scope-and-prerequisites).

## npm client releases

The [release workflow](../.github/workflows/release-please.yml) runs on pushes to `main` and uses release-please to create or update a release PR.
Review and merge that PR to create the GitHub release and trigger publication from its tag.
The [release configuration](../release-please-config.json) and [version manifest](../.release-please-manifest.json) own release naming and version tracking.
The publish job installs frozen dependencies, runs `pnpm check`, then stages the client with `pnpm build:npm` and publishes `@knowttl/artium-axi` with public access and provenance.
It skips publication when no release was created or the staged version already exists on npm.
After npm publication succeeds, the release-only image job builds the same release tag's Dockerfile for Linux amd64 and publishes `ghcr.io/knowttl/artium-axi:<release-tag>`.
It preserves the pinned upstream tools and bundled client; server deployment remains a separate operation.
The image carries OCI version, source and checked-out revision labels, BuildKit provenance and a GitHub build-provenance attestation bound to the pushed digest.
The image job exposes the digest as an output and records the immutable `ghcr.io/knowttl/artium-axi@sha256:...` identity, tag and revision in the workflow summary.
Use that digest for deployments and rollback records; version tags can move on a rerun.

Before the first automated release, the owner must enable GitHub Actions, allow GitHub Actions to create pull requests, and configure the npm package's GitHub Actions trusted publisher for `knowttl/artium-axi` and workflow filename `release-please.yml`, without an environment name.
The workflow uses `GITHUB_TOKEN` for release management and OIDC for npm publication; no npm publish token is required.
The owner must also permit this repository's Actions token to write GHCR packages and attestations and issue OIDC tokens.
Repository or organization Actions policy must allow the image job's `packages: write`, `attestations: write` and `id-token: write` permissions.
For an existing GHCR package, grant this repository Actions access before release; set package visibility deliberately if public pulls are intended.
Only the image job receives `packages: write` and `attestations: write`; it authenticates to GHCR with `GITHUB_TOKEN` and needs no registry password secret.
Before merging every release PR, require passing local [container acceptance](../CONTRIBUTING.md#container-acceptance) and [private hygiene](../CONTRIBUTING.md#private-hygiene-check) evidence for the release candidate, even when the release PR changes only version metadata.
Record that evidence in the release PR before merge; the workflow's `pnpm check` does not include these checks.
Hosted release handling, npm trusted-publisher configuration, GHCR permissions and actual publication remain unverified by local checks.
An image-job failure emits a setup reminder; inspect the failed step and resolve permissions or build failures before accepting the release.

### Verify a later published image

After an authorized release, record its tag, source commit and image digest from the successful workflow run.
Require successful npm publication, image push and attestation steps before accepting the release.
Resolve the version tag with `docker buildx imagetools inspect ghcr.io/knowttl/artium-axi:<release-tag>` and compare its digest with the workflow's recorded digest.
Pull by that recorded digest and inspect its labels:

```sh
docker pull ghcr.io/knowttl/artium-axi@sha256:<recorded-digest>
docker image inspect ghcr.io/knowttl/artium-axi@sha256:<recorded-digest> --format '{{json .Config.Labels}}'
gh attestation verify oci://ghcr.io/knowttl/artium-axi@sha256:<recorded-digest> \
  --repo knowttl/artium-axi \
  --signer-workflow knowttl/artium-axi/.github/workflows/release-please.yml
```

Require `org.opencontainers.image.version` to match the release version without its `v` prefix, `org.opencontainers.image.source` to equal `https://github.com/knowttl/artium-axi`, and `org.opencontainers.image.revision` to equal the release tag's commit.
Check the verified attestation's source repository and commit against that same tag and commit, rather than accepting any attestation from the repository.
The attestation subject must match the recorded image digest; a missing or failed attestation is an incomplete release even if the image push succeeded.
The attestation verification follows [GitHub's container verification guidance](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations).
Retain the successful verification output and immutable image identity with the release's local container and hygiene evidence.
These are future owner release checks, not evidence that this change published or verified a hosted image.

## Proxy and certificate trust

The packaged API listens on HTTP port 8080 and the Compose example publishes it only on host loopback.
Terminate HTTPS at the owner's proxy and prevent clients from reaching the HTTP listener directly.
Replace incoming forwarding headers, rather than appending to untrusted client values.
Set `ARTIUM_AXI_TRUSTED_PROXIES` to the verified proxy source IP addresses as seen by the server, separated by commas; the default trusts none.
Keep the external origin consistent for browser forms and forward the original HTTPS scheme correctly.
Verify certificate hostname, expiry and full chain before switching traffic.
Proxy installation, firewall configuration, production forwarding-header verification and certificate renewal remain unexercised owner steps.

For a containerized nginx proxy, an owner-configured override can use this static source IP and wait for the example's readiness healthcheck.
Select an unused subnet and update both the proxy address and trusted-proxy setting together.
Use an approved nginx image digest in place of the placeholder and provision the mounted certificate, key and configuration first.

```yaml
services:
  artium:
    environment:
      ARTIUM_AXI_TRUSTED_PROXIES: 172.30.88.10
  proxy:
    image: <approved-nginx-image-digest>
    ports:
      - "443:443"
    depends_on:
      artium:
        condition: service_healthy
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
      - ./tls:/etc/nginx/tls:ro
    networks:
      default:
        ipv4_address: 172.30.88.10
networks:
  default:
    ipam:
      config:
        - subnet: 172.30.88.0/24
```

The corresponding `nginx.conf` replaces client forwarding headers with the proxy's own values:

```nginx
server {
    listen 443 ssl;
    server_name artium.example.test;
    ssl_certificate /etc/nginx/tls/server.crt;
    ssl_certificate_key /etc/nginx/tls/server.key;
    client_max_body_size 16m;
    location / {
        proxy_pass http://artium:8080;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header Forwarded "";
        proxy_set_header X-Forwarded-Port "";
    }
}
```

Replace the synthetic hostname with the certificate's trusted hostname.
The static proxy IP survives recreates; do not trust the whole Docker subnet.
The health dependency waits during initial startup and does not promise uninterrupted traffic during later recreates.

Set `ARTIUM_AXI_URL` to the trusted HTTPS base URL without credentials, query or fragment.
For a private CA, use curl's `--cacert` on both downloads and set `ARTIUM_AXI_CA_FILE` to the readable PEM CA file for the CLI.
Never bypass certificate verification.
The checksum comes from the same trusted server and detects corruption or mixed releases; it does not establish trust in an unknown server.

## TLS inspection and private upstream CAs

For server-wide trust of private upstream CAs, including a network TLS-inspection CA, set `ARTIUM_AXI_EXTRA_CA_FILE` to a readable PEM bundle.
For one tool credential, use the [administration UI flow below](#trusting-one-tool-from-the-administration-ui).
Obtain the public CA certificates and confirm their SHA-256 fingerprints through a trusted operator channel.
The file must contain one or more PEM certificates and whitespace only, with no private keys.
Mount it read-only and make it readable by container UID 10001, using the commented CA secret entries in `compose.example.yaml`.
Use the file's path inside the container for the setting.

The server refuses startup for unreadable, empty or malformed bundles and for any bundle containing a private key.
It warns on expired certificates and certificates expiring within 30 days; an expired certificate is not made valid by trusting it.
Warnings identify fingerprints and never print PEM contents.
After startup, open **Tools** in the administration UI to inspect the loaded subject, issuer, expiry and SHA-256 fingerprint of every certificate.
This view is read-only and shows the loaded snapshot.
Replace the mounted file and restart the server to rotate trust; replacing the file alone does not reload it.

The server adds the bundle to its default Node TLS trust before outbound connections, including global `fetch`, SSO discovery and Azure token acquisition.
The runner supplies `NODE_EXTRA_CA_CERTS` and `REQUESTS_CA_BUNDLE` centrally on every call through private temporary files.
The Requests bundle includes the server's default Node public roots as well as the additional CAs, since Requests replaces its default certifi bundle when this variable is set.
LDAP and Vectra credential-specific CA files receive the server bundle too, preserving those credential-specific CAs as an additive option.
For endpoints with UI-confirmed trust, the [credential-scoped policy below](#trusting-one-tool-from-the-administration-ui) takes precedence.
Certificate verification and hostname verification remain enabled.
With the setting absent, no server-wide trust is added; credential-specific trust still applies.

This setting trusts upstream services from the server and its tools.
The CLI's separate `ARTIUM_AXI_CA_FILE` setting trusts the Artium server from a client.
If an inspected upstream still fails, confirm the intended issuer and fingerprint with the network operator and check certificate validity and the hostname.
Do not disable verification; a temporary network-policy exemption is an alternative while the correct CA is provisioned.

### Trusting one tool from the administration UI

After a credential test reports a TLS verification failure, select the affected **Saved TLS endpoint** on the tool page and choose **Inspect certificate**.
AWX also allows inspection before a credential test or token save; first save the controller address as described in [the password sign-in flow](#roles-credentials-and-health).
This uses the existing certificate-inspection timeouts and follows no redirects.
Inspection connects only to an endpoint from the saved credential and tool inventory, performs a TLS handshake, and sends no credentials or application requests.
For LDAP StartTLS, it sends only the anonymous protocol upgrade before reading the TLS chain.
Administration capability and recent identity confirmation are required.
If the endpoint verifies with the server's existing trust, including its server-wide CA bundle, inspection reports that no trust is needed and offers no trust confirmation.
The API also refuses to save CA trust or a strict pin for that inspection, and no trust change is recorded.

Review the hostname, subject, issuer, names, validity dates, key, signature algorithm and full SHA-256 fingerprint.
When a certificate has no nonblank subject, its displayed subject falls back to the first subject alternative name, or `(no subject)` if none is available.
This applies to inspection, trusted certificate and pinned leaf details, audit subjects and the server-wide CA bundle listing; a missing issuer displays as `(no issuer)`.
An empty subject does not prevent inspection or trust, and two empty subject and issuer names do not establish a self-signed match.
Compare the fingerprint with the appliance’s own display through a trusted channel.
Trust is only as safe as the network path during inspection: an intercepted certificate would be trusted too.
The window highlights weak keys, validity and hostname problems, and fingerprints that differ from previously trusted certificates at the endpoint.
The confirmation window and inspection API report the leaf and trust anchor expiry, with informational warnings when either expires within seven days.
For a short-lived intermediate anchor, the window warns that it will rotate and recommends trusting the long-lived root through the server-wide bundle to avoid repeated confirmation.
Expiry warnings do not block confirmation or change hostname and date verification.
**Trust certificate for this tool** defaults to **Trust the CA**; choose **Strict leaf pinning** explicitly to require confirmation after each leaf rotation.
GitHub is an exception: its editor accepts only an issuing CA, and strict leaf pinning is refused because GitHub CLI cannot enforce it.
For self-signed GitHub endpoints or a missing issuing CA, configure the server-wide bundle above.
The GitHub CLI child receives system roots, the server bundle and credential CAs together through a private `SSL_CERT_FILE`; those CAs are additive across the child's connections rather than restricted to the inspected endpoint.
No certificate file or private key is accepted by this flow.

Trust is stored with that tool’s credential and audited with the administrator, time, tool, subject and fingerprint.
Except for the GitHub CLI child described above, each confirmed certificate applies only to the inspected endpoint's hostname and port; other endpoints of the same tool require their own confirmations.
Azure inspection includes login, ARM, Graph and Log Analytics.
For Storage, Key Vault and ACR, save service names in the Azure native setting `tlsDestinations`, for example `{"storageAccounts":["synthetic"],"keyVaults":["synthetic-vault"],"registries":["syntheticregistry"]}`.
These saved names produce endpoints under `blob.core.windows.net`, `vault.azure.net` and `azurecr.io` respectively; URLs and caller-supplied inspection hosts are refused.
A complete private chain trusts the issuing CA, while a self-signed endpoint trusts its own certificate for tools supporting leaf pins.
CA trust accepts renewed leaves under the stored issuing CA, including when that CA is an intermediate.
The server may present the leaf and issuing intermediate without the root; confirmation anchors trust on the presented intermediate and accepts renewed leaves it issues.
Except for the GitHub CLI child, connections to an endpoint with confirmed CA trust or strict pins must validate against its saved anchors; a different CA is rejected even if the server otherwise trusts it.
Strict leaf pinning also checks the observed leaf fingerprint before application data is sent, so another certificate under the same issuer requires another inspection and confirmation.
On a pin mismatch, the error explains that the stored fingerprint differs from the presented one and directs the administrator to re-inspect the certificate on the tool page.
For failed tool runs, including background health checks, the shared runner checks endpoints with strict pins and replaces the CLI error with this message if it observes a different leaf fingerprint.
If the fingerprint still matches or cannot be observed, the original error is retained.
When a failed handshake does not expose its leaf, diagnostics can open a separate, unverified handshake solely to read the fingerprint, using an anonymous StartTLS upgrade for LDAP.
This diagnostic connection sends no credentials or application requests, establishes no trust and leaves the real connection rejected; mismatch errors omit certificate contents and fingerprint values.
On upgrade, saved pins with separate CA anchors are converted once to CA trust; self-signed leaf pins and leaf pins with no issuing CA stored remain pins.
Each converted or retained entry is recorded in the audit log, and cached tool health is cleared.
If migration leaves both modes at one endpoint, connections accept leaves issued by its saved CA anchors or the retained pinned leaves themselves; a retained pin does not extend CA trust to its issuer.
Previously saved automatic intermediate repairs are removed on upgrade, clearing affected tools' cached health; they do not become confirmed CA anchors.
The shared runner adds the certificate to its existing Node, Python, LDAP and Vectra trust injection, and server-side token acquisition uses the same credential trust.
Trust does not disable hostname or date verification.
Confirming an expired or hostname-mismatched certificate saves trust but does not fix the connection: renew the certificate or use its matching hostname.

If the server omitted an intermediate, inspection can retrieve the leaf certificate’s AIA issuer automatically.
Retrieval accepts only HTTP or HTTPS, follows no redirects, has a three-second total deadline, and reads at most 128 KiB.
An obtained private issuer is offered for explicit CA confirmation even when it is not already trusted.
When no issuing CA can be obtained for a non-self-signed leaf, CA trust is unavailable and strict leaf pinning requires an explicit choice.
Automatic intermediate repair is not included because treating a repaired intermediate as trusted could bypass the confirmed anchor's expiry.
If an endpoint omits an intermediate below a confirmed root, confirm that intermediate as the CA anchor or configure the endpoint to present its complete chain.

The tool page lists trusted certificates and their expiry dates, with warnings within 30 days of expiry.
For CA rotation or a leaf rotation in strict pinning mode, re-inspect the saved endpoint.
If inspection reports that no trust is needed, use **Remove trust** to retire the old entries and let the endpoint use the server's existing trust.
Otherwise, confirm the replacement, then use **Remove trust** to retire the old entry.
Confirmation in the same mode keeps previously confirmed entries trusted during rolling rotation.
Switching between CA trust and strict pinning replaces the endpoint's entries in the other mode.
These changes take effect on subsequent calls and survive server restarts.
Use the server-wide bundle above for organization-wide inspection CAs instead of confirming the same CA separately for every tool.

## CLI launchers and password changes

Follow the [Linux download and launcher installation](client-reference.md#verified-client), including both downloads and checksum verification before executing the bundle.
Keep Node on PATH and retain the installed launcher path; rerun setup if the bundle moves.
Install agent skills using the [skill installation guidance](../README.md#use-with-your-agent) for your host.
With that installation and trust configured, the following commands are the local-account operator checks:

```sh
artium-axi login --username synthetic-admin --password-stdin
artium-axi passwd --password-stdin
artium-axi login --username synthetic-admin --password-stdin
artium-axi whoami
artium-axi tools
# Requires an enabled Falcon tool granted through a role:
artium-axi tools show falcon-axi
artium-axi doctor
artium-axi logout
```

Supply passwords through stdin or the hidden terminal prompt, never command arguments.
The first login with a temporary password intentionally returns `PASSWORD_CHANGE_REQUIRED` and exit 1.
Change the password, then log in again; a password change revokes existing sessions.
For an ordinary password change, confirm the current password through the hidden prompt or `ARTIUM_AXI_CURRENT_PASSWORD`, and supply the new password on stdin or at the prompt.
Clear temporary password environment values after use.
Browser users sign in at `/login`, change temporary passwords at `/password`, and sign in again.
See [browser administration](admin-guide.md#browser-administration) for `/account` usage and session management.
See the administrator guide's [password rules](admin-guide.md#security-and-acceptance-boundaries); this runbook does not decide or waive the owner's Password and Secrets Standard.

See [host verification](https://github.com/knowttl/artium-axi/blob/archive/internal-docs/docs/verification-s45.md) for local skill discovery evidence and outstanding host acceptance.
Windows/macOS launchers and live client trust remain unexercised owner acceptance.
Follow [client settings](client-reference.md#client-settings) for default session-file protection and `SESSION_BUSY` recovery, or [externally managed client sessions](client-reference.md#externally-managed-client-sessions) when the caller owns token custody.
An uncertain network outcome is never retried automatically; inspect audit and platform state before deciding whether to repeat a call.

## Scripted administrator sessions

There is no dedicated administrator CLI.
Scripts use the JSON API over the same trusted HTTPS origin; see the [shared contracts](../src/shared/api.ts) for route bodies and revision fields.

Test credential performs credential validation followed by DNS, TCP and verified TLS preflight for every endpoint in the [tool inventory](../src/server/tool-endpoints.ts) before running the tool.
This includes Azure destinations derived from saved `tlsDestinations`; see [credential certificate trust](#trusting-one-tool-from-the-administration-ui) for configuration.
A preflight failure at any inventory endpoint stops the test, even if the health read would use another endpoint.
LDAP URLs negotiate StartTLS before the handshake; LDAPS starts TLS directly.
Preflight sends no credentials.
The administrator test response and tool page show the current failure's stage and the tool's error text and hint when available.
Network and TLS diagnostics name the destination host for both manual tests and background checks; background checks run the tool without preflight.
Checks admitted to run also update revision-bound cached health on `/admin/tools`, except for transient admission or authorization failures.
Failures before admission, including missing credentials, overlapping checks and unavailable adapters, return configuration-stage diagnostics without replacing cached health; an absent credential revision is `null`.
Preflight certificate-verification diagnostics identify the chain as self-signed or untrusted and include the presented issuer when available, except for [pin mismatches](#trusting-one-tool-from-the-administration-ui), which omit certificate details.
For TLS failures, follow [TLS inspection and private upstream CAs](#tls-inspection-and-private-upstream-cas).
Follow the diagnostic hint to repair token-acquisition failures; see the [error reference](errors.md) for categories, next steps and the Graph provider-code limitation.
Azure identity-provider HTTP service failures, including throttling and server errors, return `TOOL_FAILED` at the token-acquisition stage with service-availability advice; credential rejection returns `UPSTREAM_AUTH_FAILED`.
These Azure diagnostics never include raw response bodies.
Tool codes `API_RESPONSE_INVALID`, `AUTH_RESPONSE_INVALID`, `RESPONSE_INVALID`, `MALFORMED_RESPONSE` and `INVALID_RESPONSE` return `UPSTREAM_RESPONSE_INVALID` at the response stage, preserving the tool's redacted diagnostic text.
For BeyondTrust schema-validation failures, `API_RESPONSE_INVALID` includes HTTP `status`, normalized `contentType` and a bounded `shape` report containing JSON paths and value types, never response values.
`shapeTruncated` indicates that the shape report reached a native reporting limit; administrator diagnostic text remains subject to the host limits below.
These details appear in managed command output and credential-test diagnostics; audit records retain the error code without the shape report.
Inspect the message and hint, then check the service endpoint and API compatibility.
`AUTH_ENDPOINT_NOT_FOUND` returns `TOOL_REJECTED_INPUT` at the configuration stage; check the configured service host and the tool's hint for the token endpoint.
Diagnostics include check time and credential revision, are bounded to 4096 characters, and are discarded entirely if the exact-value secret scanner finds a credential value or one of its canonical encodings.
The current credential-test and health-check diagnostic cache is held only in server memory; after a restart, rerun Test credential for current detail or inspect retained failure diagnostics in Audit as described below.
The browser temporarily holds the save-and-test result in session storage to display it after reloading the tool page.
After upgrading, cached categories removed from the error catalogue are ignored; rerun Test credential for a current result.
Audit records retain categories, timing, revision, exit status and byte counts, never diagnostic text or output streams.
Failed tool runs, including credential-test and background health-check runs, separately retain the available exact-secret-scanned diagnostic in an administrator-only SQLite table keyed by request ID for 14 days.
The stored diagnostic is bounded to 4 KiB of serialized JSON and appears in the terminal audit row's details at `/admin/audit`; it is excluded from the audit API, CSV/JSONL exports, audit stream and operational logs.
Diagnostics containing a known secret are discarded in full; exact-value scanning cannot identify unknown upstream-minted tokens or all sensitive data.
Expired diagnostics are hidden immediately and removed by startup and daily retention; protect database backups separately because retention does not rewrite existing backups.
Ordinary users receive catalogue categories without this administrator detail.
For local accounts, start with `POST /v1/auth/login`, with JSON `{ "username": "synthetic-admin", "password": "<password>" }` supplied from protected stdin or a protected file, never command arguments.
Require an `authenticated` response; a `password-change-required` response must complete the password-change flow first.
Keep the returned `accessToken` and `refreshToken` private and out of logs.
Then send `POST /v1/auth/reauth` with `Authorization: Bearer <accessToken>` and JSON `{ "password": "<password>" }` from the same protected input source.
The response contains `ticket` and `expiresAt` (Unix milliseconds).
SSO administrators instead follow the administrator guide's [CLI sign-in and bearer reauthentication instructions](admin-guide.md#sign-in-settings) to obtain artium tokens and a recent-auth ticket through browser approval.
Send both `Authorization: Bearer <accessToken>` and `x-artium-reauth-ticket: <ticket>` on every `/v1/admin/...` request, including reads such as `GET /v1/admin/users` and `GET /v1/admin/audit`.
With curl, provide sensitive headers through a protected configuration file or stdin with `--config -`, rather than command arguments.
Bearer sessions do not use browser CSRF tokens.

The ticket is bound to the login session family and lasts 15 minutes; on `REAUTH_REQUIRED`, obtain a new ticket with that family's access token.
Access tokens last one hour; `POST /v1/auth/refresh` takes `{ "refreshToken": "<refreshToken>" }` and returns replacement tokens.
Replace both stored tokens atomically and never reuse a consumed refresh token.
The ticket remains usable through a refresh of its own family, but cannot authorize another login session.
At completion, send `POST /v1/auth/logout` with the refresh token as the bearer credential, then discard local tokens, tickets and temporary inputs.
See [authentication limits](admin-guide.md#security-and-acceptance-boundaries) for how successful authentication and failures affect the attempt budgets.

## Roles, credentials and health

Follow [browser administration](admin-guide.md#browser-administration) to create local users, edit role grants and assign roles through the user detail pages.
Grant changes apply on the next call, including calls using existing tokens.
Users with no enabled granted tools receive an explanatory empty list.
Review actor, change time and revision before saving; reload stale forms instead of overwriting newer edits.
See [browser administration](admin-guide.md#browser-administration) for timestamp display and inline identity confirmation.

Write access ships with each write-capable tool but defaults to off independently of whether the tool is enabled.
Follow [browser administration](admin-guide.md#browser-administration) to use the Write access switch or preserve write policy when replacing Native settings.
For scripted administration, read `GET /v1/admin/tools` or `GET /v1/admin/tools/:tool` to review normalized `writeAccess` capability, current state, fixed read-only reasons, supported and allowed operations, and the actions a grant unlocks or leaves blocked.
Use `PATCH /v1/admin/tools/:tool/write-access` to change only write access while preserving other native settings and credential values.
Follow the [scripted administrator session procedure](#scripted-administrator-sessions); the request requires administrator capability, recent confirmation and the current tool revision.
The [API contract](../src/shared/api.ts) (`adminToolRoutes.writeAccess`) owns the input and response fields and allow-list update semantics.
See the [AWX supported boundary](tool-credentials.md#awx) before enabling its write switch.
See [GitHub setup and limitations](tool-credentials.md#github) before activation.
See the [Tenable One supported boundary](tool-credentials.md#tenable-one) before enabling its operation allow-list, including export jobs.
See the [Hybrid Analysis supported boundary](safety.md) before enabling its operation allow-list and [credential setup](tool-credentials.md#hybrid-analysis) before activation.
See [Check Point setup and commissioning](tool-credentials.md#check-point-email-security) before activation; enable only exact intended writes and independently selected downloads.
Check Point uses the same artifact mount, global capacity, expiry and revocation contract as Hybrid Analysis, with a 50 MiB native limit and host-owned download confirmation/evidence.
The owner commissions live authentication, permissions, scopes and hash availability through Artium after the complete build; local checks use fakes only.
For AWX password sign-in, enter the controller HTTPS origin and choose **Save controller address** first.
This saves only the address before first sign-in; changing an existing address removes its previous token and certificate trust.
Choose **Inspect certificate** for that saved endpoint and follow the [certificate review and scoped trust flow](#trusting-one-tool-from-the-administration-ui) when required.
Then choose password sign-in, enter the username and password and choose **Save credential**.
Until a token is saved, the credential remains unconfigured and ordinary calls cannot use the address-only record.
The same sequence applies when switching controllers; the paste-a-token path remains available.
See the [hosted credential contract](credential-standard.md#per-tool-host-facing-schemas) for the one-time token exchange and password handling.
Graph and Vectra still restrict writes to the operations allow-list, and native confirmation gates still apply.
Write-policy changes, including changes through Native settings or complete credential replacement, commit atomically with a dedicated [write-access audit event](admin-guide.md#audit-screen-and-api).
Stale revisions never mutate settings, and an audit failure rolls back the change.
Tool lists and health responses report `readOnly`; LDAP remains fixed read-only.
GitHub writes require exact administrator-selected operations and Artium-owned preview/confirmation; see [GitHub setup](tool-credentials.md#github) for the tiers and interrupted-write recovery.
Existing configurations without an explicit `allowWrites: true` remain off, while existing explicit opt-ins are preserved.
The write-access endpoint rejects changes for LDAP with the fixed read-only reason.
See [Falcon RTR execution](#falcon-rtr-execution) for its additional profile and confirmation gates.

For credential rotation, obtain the replacement through the owner's approved process, then open the tool at `/admin/tools`.
Follow the [credential editor guidance](admin-guide.md#browser-administration) for guided fields and combined certificate PEM uploads.
Use “Test credential” or select “Test after saving” on the tool page to test the replacement with the fixed harmless read before enabling it.
Check cached health and a permitted fake read, then revoke the old upstream credential through the owner's process after acceptance.
AWX username-and-password sign-in mints a personal access token during credential save.
Other upstream credential issuance, and revocation for every tool including AWX, remain live-only owner steps and are not exercised here.
Credential replacement advances credential and tool revisions, clears health, and invalidates old Azure resource-token cache entries.
The [credential-save contract](../src/shared/api.ts) (`adminToolRoutes.save`) owns API request fields, retention, identity-change restrictions and revision requirements.
This API uses the same authorization, encryption, audit, health refresh and cache invalidation as complete replacement.
Failure to commit the audit event rolls back the local replacement.
Rotate upstream credentials separately from the offline database master key.
See [browser administration](admin-guide.md#browser-administration) for native-settings guidance and the live-results and maintainer-approval requirements before enabling Graph on a running installation.

Check liveness and readiness through the trusted endpoint:

```sh
if [ -n "${ARTIUM_AXI_CA_FILE:-}" ]; then
  set -- --cacert "$ARTIUM_AXI_CA_FILE"
else
  set --
fi
curl --fail "$@" "$ARTIUM_AXI_URL/health/live"
curl --fail "$@" "$ARTIUM_AXI_URL/health/ready"
```

Both return `status: ok` when healthy; readiness returns HTTP 503 when local migration-table access fails.
These checks do not test remote services or reload the key.
Use doctor for the [CLI diagnostics](client-reference.md#toon-output-behavior), including separate TLS-verification and liveness results and cached tool health.
Background checks for enabled configured tools become due on the first 10-second tick after startup, then normally 15 minutes after each check completes.
Reachability failures (`UPSTREAM_NETWORK_FAILED`, `TIMEOUT`, `TEMP_UNAVAILABLE`) retry early: consecutive failures wait 1, 2, 4 and 8 minutes after completion, then stay at the normal 15-minute interval.
Success resets the retry backoff; authentication, TLS and configuration failures use the normal interval.
Runner admission failures also use the normal interval, except that queued checks rejected with `TOO_MANY_CALLS` stay due for a later tick.
Credential, native-settings, write-access and certificate-trust changes reset the backoff and request a fresh check for enabled configured tools without a manual test.
While that check is running or queued and no current cached result exists, tool lists and administrator health responses report `checking` instead of `unknown`, including while waiting for runner capacity.
GitHub device connection explicitly checks the new credential revision even when the tool is disabled.
If runner capacity is occupied or another check is in flight, the credential remains saved with a revision-bound `TOO_MANY_CALLS` result and the diagnostic `Credential check pending: runner busy.`
The existing health refresh mechanism retries that revision once capacity is available, including for disabled tools; completion of an older revision cannot overwrite its result.
Disabled tools retain their `disabled` health status while exposing the recorded check's revision, timestamp and error details.
Results superseded by a later configuration change cannot change the schedule or cached health, even when the credential revision is unchanged.
At most two background checks run at once, including replacement checks; work deferred by this cap stays due for a later tick.
Manual tests and background checks share the one-check-per-tool exclusion and runner admission rules.
The schedule is fixed, not operator-configurable; [healthDefaults](../src/server/config.ts) owns the executable constants.
Use “Test credential” on the tool page for a current check and inspect cached health at `/admin/tools` and safe error codes in Tools and Audit; never log secret values to diagnose a failure.

### Troubleshoot a failed tool call

Read the tool's output and follow its `code:` and `help` lines.
For a non-zero tool exit, keep the stderr request ID described in [client output behavior](client-reference.md#toon-output-behavior).
Artium errors include a server `requestId` in their TOON error envelope; follow `next`.
Every server response also carries `x-artium-request-id`, and browser error pages display the ID.
Client-local failures have no server request ID; follow the [client error guidance](client-reference.md#toon-output-behavior).
Never retry a write with `OUTCOME_UNKNOWN` or `UNKNOWN_OUTCOME` until you have checked current state.
When escalating, send the administrator the request ID, tool name and time, without credentials or potentially sensitive command output.

Administrators can open `/admin/audit?requestId=<id>` to inspect run-start and run-terminal evidence for admitted runs, or denial evidence for refused calls.
Expand the terminal row for any retained failure diagnostic; see [diagnostic storage and retention](#scripted-administrator-sessions).
Use `/admin/audit?failed=1&tool=<tool>` to find recent failed runs.
See [Audit screen and API](admin-guide.md#audit-screen-and-api) for filter semantics, recorded fields, API queries, pagination and exports.
For a credential, TLS, DNS or network problem, use **Test credential** on the tool page for a current secret-scanned diagnostic.

Search `docker compose -f compose.example.yaml logs --timestamps artium` for the request ID to find the `run` event and any related `error` event.
Operational logs are JSON lines on stderr with `ts` (UTC), `level`, `event` and `requestId` (`null` for events without request context, including lifecycle events).
Background credential checks use a generated request ID shared with their audit records.
Each tool call emits one `run` record with the tool, outcome, exit code, error code, duration, output byte counts and truncation flag, without arguments, stdin or output text.
`startup`, `listening` and `shutdown` identify the server lifecycle; `retention` errors identify the affected store in `target`.
`artifact-cleanup` errors mean new artifact admission is blocked; `trusted-ca` warnings report `CA_EXPIRING` or `CA_EXPIRED`, so inspect the configured bundle's certificates.
The optional audit stream remains on stdout, separate from operational logs.
For `INTERNAL_ERROR` and `SPAWN_FAILED`, the `error` event carries additional safe diagnostics.
The server's stderr JSON line contains `requestId`, a sanitized `errorClass` and the matched route template in `route` (or `(unmatched)`), without actual path parameter values, query strings, request bodies, secrets, certificate contents or error messages.
When available, `errorCode` is a bounded Node errno token such as `ENOENT`; `frames` contains at most five application `dist/` or dependency `node_modules/` file:line locations without function names or messages.
Startup failures also include these safe fields when available and retain the Artium error code for known configuration failures.
Schema validation failures also include `validationFields`, limited to recognized certificate field names; this array can be empty.
These diagnostics leave response error codes unchanged and are separate from audit records.

### Falcon RTR execution

Enable Falcon's audited **Write access** switch and select `rtr run` with recent identity confirmation, then separately save Native settings with profile opt-in, for example `{"writes": {"allowWrites": true, "operations": ["rtr run"]}, "rtr": {"enabled": true, "commands": ["ps"]}}`.
Native settings replace the whole object, so preserve the `writes` selection when saving the profile opt-in.
Existing `allowWrites: true` settings retain RTR permission only; saving the write switch converts them to the explicit operation selection.
Select `malquery search` separately in **Write access** to enable it; existing RTR grants do not select it.
See [supported Falcon capabilities](safety.md), [upstream permissions and licensing](tool-credentials.md#falcon) and [audit classification](admin-guide.md#audit-screen-and-api) before enabling it.
Omit `rtr.commands` to use the standard read-only command allowlist or supply a subset to narrow it; the [API contract](../src/shared/api.ts) owns accepted settings and command names.
The switch never supplies profile opt-in or execution confirmation for the caller.
Preview with `artium-axi falcon-axi rtr run <device_id> --command ps`, then execute the same call with `--execute --confirm '<device_id>:ps'`.
Confirmation must match the device ID and complete command exactly.
Without the `rtr run` capability enabled, the [native read-only override](credential-standard.md#per-tool-host-facing-schemas) blocks RTR execution, NG-SIEM job start/stop, `host usb` and identity activity; RTR session and audit history reads and local previews remain available.
Execution deletes its session afterward and records a durable redacted journal; see [retention and export](#retention-and-export).
RTR reads successive output chunks and reports `complete` and `truncated`; check both before treating the returned output as complete.
Avoid overlapping sessions for the same host and API client, including from other machines.
After ambiguous session initialization or failed deletion, reconcile sessions in Falcon before retrying; never replay automatically.
Keep the example deployment's shutdown grace period when adapting it so native session cleanup can complete before container termination.

## Retention and export

SQLite audit retention runs at startup and daily, deleting events strictly older than the captured 90-day cutoff in batches of at most 500.
Each batch commits its count and cutoff with the deletion.
Azure, ordinary Graph runs, Vectra and Falcon use isolated native journals at `<configured write-log path>.runs/run-*/writes.log`.
At startup and daily, retention removes run directories whose modification time is strictly older than 90 days, after validating any journal present.
Graph and Vectra keep each run's native intent/outcome entries together; the legacy Vectra journal still retains paired entries with its existing daily cutoff.
Graph mail downloads instead retain native intent/outcome journals at `<configured write-log path>.<transferId>`; run-journal retention does not prune these files.
Falcon execution journals persist after calls and expire with their run directory after 90 days.
Tenable, Hybrid Analysis and Check Point writes each keep one shared native journal at `<database directory>/tool-logs/<tool>/writes.log` so sequential and concurrent invocations retain native intent replay protection.
Check Point downloads use host-owned transfer audit evidence with empty native journal fields; the upstream downloader emits no native journal.
These journals are not pruned by run-journal retention.
Tenable and Hybrid Analysis reserve intent IDs indefinitely; deleting old entries would allow a previously reserved intent to execute again.
Keep their shared journals and adjacent lock files intact, including across restarts.
Check Point's shared journal uses audit IDs rather than the legacy Vectra intent-key format and remains outside automatic retention.
Successful reads for these tools report `read`; executed writes report `write` only when the output's native audit ID matches an intent in the journal, otherwise `unknown`.
Tenable's adjacent `profiles/` directory stores stable configuration files containing secret references; secret values remain in per-call environment variables.
BeyondTrust executed mutations persist a redacted host `intent.json` before starting the child at `<database directory>/tool-logs/beyondtrust-axi/writes.log.runs/run-*/`.
Native intents live under that run directory's `beyondtrust-axi/writes/`; these directories survive runner cleanup and expire at startup and daily when the run directory's modification time is strictly older than 90 days.
Retention validates the host intent and any native intents before removing the whole directory.
Reconcile an ambiguous write using its native intent ID when available, otherwise its host intent ID, together with the affected remote state.
BeyondTrust downloads use host-owned transfer evidence with empty native journal fields; see [client usage](client-reference.md#beyondtrust-pm-cloud).
Retention leaves malformed Azure, Graph, Vectra, Falcon and BeyondTrust native journals untouched and reports `AUDIT_UNAVAILABLE`; investigate before assuming export is complete.
Cleanup continues for independent run journals and tools even when another journal or SQLite audit retention fails.
Monitor free space on the persistent `/data` volume and track growth under `<database directory>/tool-logs/`, especially the unpruned shared journals and Graph mail-download journals.
Set a capacity alert with enough headroom for writes and backups, and expand storage before it fills.
Do not delete replay-protection journals to reclaim space; reconcile malformed evidence before arranging cleanup.
AWX's upstream journal stays in its isolated per-call state directory and is removed with that directory after the call; Artium retains its host audit without a second persistent AWX journal.
There is no audit deletion endpoint or general export CLI.
See [Audit screen and API usage](admin-guide.md#audit-screen-and-api) for filtered review, pagination, CSV and JSON-lines downloads and read authorization.

For continuous export, set `ARTIUM_AXI_AUDIT_STDOUT=1` in the server environment and send its committed JSON-line records, containing exactly the persisted fields, to the owner's protected collector before retention expires.
The example Compose service uses Docker's `json-file` log driver with `max-size: 10m` and `max-file: 5` to bound local container logs, including the optional audit stream.
`docker compose -f compose.example.yaml logs --timestamps artium` remains available; rotated local logs are not a substitute for the protected audit collector.
SQLite remains authoritative if the optional stream fails; monitor collector failures and reconcile retained records through the audit API.
Key-rotation receipts are separate maintenance output, not audit export.
The owner selects collector storage, access, retention and deletion policy; no external collector is configured by this runbook.
See [backup retention](#backup-restore-and-upgrade-rollback) for audit data retained in snapshots.

## First administrator and offline recovery

Use the [first-start settings](admin-guide.md#server-settings-and-custody) in the administrator guide.
The username is trimmed and lowercased for lookup, must be nonempty without whitespace or control characters, and keeps the entered spelling as its display name.
The canonical name `synthetic-development-user` remains reserved and cannot be used for bootstrap or recovery.
Use the administrator guide's [local password rules](admin-guide.md#security-and-acceptance-boundaries).
For a source-based disposable first start after building, prepare the protected synthetic files and empty data directory, then run from the repository root:

```sh
ARTIUM_AXI_DATABASE_FILE=/absolute/path/copied-data/artium.db \
ARTIUM_AXI_MASTER_KEY_FILE=/absolute/path/synthetic-key \
ARTIUM_AXI_ADMIN_USERNAME=synthetic-admin \
ARTIUM_AXI_ADMIN_PASSWORD_FILE=/absolute/path/bootstrap-password \
pnpm start
```

The production listener is fixed at port 8080; use an isolated environment and stop the process with SIGTERM after rehearsal.
For Compose first start, uncomment the first-start environment block and both bootstrap-password secret entries in [compose.example.yaml](../compose.example.yaml) before creating the service.
Prepare both secret files with the runtime ownership described above.
The master-key secret alone does not bootstrap a fresh store.
The store must be empty except for migrations and the default tool registry, and must never have been bootstrapped.
Startup commits the administrator and one-time marker atomically, with must-change set and no tool grants.
Remove the bootstrap settings after first start.
Later starts ignore both bootstrap settings and never recreate an administrator, even when no enabled administrator remains.
A missing marker with existing account, role, credential, audit, rotation or changed tool data fails with `BOOTSTRAP_INCONSISTENT`.
Restore a consistent bootstrapped store and matching key.
Do not delete data or manufacture a marker to bypass the startup refusal.

The database prevents disabling, demoting or deleting the last enabled administrator.
Offline recovery can restore an existing, non-archived local account's administrator capability and access, reset its password and clear its lockout.
It sets must-change, revokes every existing CLI token and browser session for the account, and commits a durable audit event in the same transaction.
It also designates the recovered local administrator as break-glass so password access remains possible when SSO is enabled.
The event has action `recover-admin`, the account's internal ID as target and no online actor or password data.
The command does not create an account or bootstrap an inconsistent store.

During development, exercise recovery only on a copy of a disposable store with a canary password and key.
Real administrator recovery requires separate approval.
Stop the server, take a consistent backup and retain its matching master key separately.
After `pnpm build`, run:

```sh
ARTIUM_AXI_DATABASE_FILE=/absolute/path/copied-data/artium.db \
ARTIUM_AXI_MASTER_KEY_FILE=/absolute/path/synthetic-key \
node bin/artium-axi-server recover-admin --username synthetic-admin --password-file /absolute/path/recovery-password
```

For the equivalent stopped-store container command, use the same image, runtime UID and data volume as the server:

```sh
docker run --rm --network none --read-only --tmpfs /tmp \
  --mount type=volume,src=artium-data,dst=/data \
  --mount type=bind,src=/absolute/path/synthetic-key,dst=/run/secrets/artium_master_key,readonly \
  --mount type=bind,src=/absolute/path/recovery-password,dst=/run/secrets/recovery_password,readonly \
  --env ARTIUM_AXI_MASTER_KEY_FILE=/run/secrets/artium_master_key \
  artium-axi:local artium-axi-server recover-admin --username synthetic-admin --password-file /run/secrets/recovery_password
```

Supply an existing local username and readable files, never a password or key value in arguments.
Recovery checks the mounted key against the store's active key ID, authenticates every stored credential and takes the same maintenance lock as the server and rotation.
An unrelated key fails with `MASTER_KEY_INVALID` even if the store has no credentials or rotation history.
An audit failure rolls back the entire recovery.
After success, restart the server, sign in with the recovery password and change it.
Use the [CLI quickstart](client-reference.md#verified-client) or the administrator guide's [browser sign-in and forced password-change flow](admin-guide.md#browser-administration).

## Offline master key rotation

During the build, use only disposable stores and synthetic 32-byte key files.
Production key rotation requires separate approval.

1. Stop the server and take a consistent database backup, including retained audit and account data.
   Protect the backup as sensitive data.
   Keep the matching old master key separately from that backup.
   The online backup command below can also run before stopping; take the final pre-rotation snapshot after admission has stopped.
2. Mount the same data volume and both raw 32-byte key files in a one-shot container using the same application image.
   The new key must differ from the old key, and both files must be readable by the container's runtime UID.
   Set `ARTIUM_AXI_MASTER_KEY_FILE` to the old key file.
   Set `ARTIUM_AXI_DATABASE_FILE` if the store differs from `/data/artium.db`.
3. Run the maintenance command.
   It authenticates existing rows and commits every re-encrypted row, the active store key ID, a key-ID receipt and an audit event in one transaction.
4. Save the printed key-ID receipt, switch the server's mounted startup key to the new key and restart.
   Rotation does not update the saved `.env`; restart with the explicit new key so startup replaces the saved old key before relying on it again.
5. Check every configured adapter before retiring the old key.
   Retain the old key until backups encrypted with it expire.

For an already stopped disposable store, the exact container invocation is:

```sh
docker run --rm --network none --read-only --tmpfs /tmp \
  --mount type=volume,src=artium-data,dst=/data \
  --mount type=bind,src=/absolute/path/old-key,dst=/run/secrets/old_master_key,readonly \
  --mount type=bind,src=/absolute/path/new-key,dst=/run/secrets/new_master_key,readonly \
  --env ARTIUM_AXI_MASTER_KEY_FILE=/run/secrets/old_master_key \
  artium-axi:local artium-axi-server rotate-key --new-key-file /run/secrets/new_master_key
```

Use the same runtime UID and data-volume ownership as the server.
Replace `artium-data` in the invocation with the server's actual volume name; Compose normally prefixes it with the project name.
Replace the bind source paths with the absolute paths of the synthetic key files.
Maintenance does not require development authentication.
For local disposable-store work after `pnpm build`, run `node bin/artium-axi-server rotate-key --new-key-file <path>` with the same database and old-key environment settings.
Only key file paths go in arguments, never key bytes.

The server holds `<database>.maintenance` for its entire lifetime, including shutdown of active calls.
Offline rotation, administrator recovery and restore hold the same SQLite writer lock until they finish.
Online backup does not acquire this lock.
`MAINTENANCE_BUSY` means another server or maintenance process owns the store.
Never remove or replace the lock database to bypass contention.
The operating system releases the lock on process exit or crash.

An interruption before commit leaves the old encrypted rows and previous receipt unchanged.
Restart with the old key.
After commit, restart with the new key, even if no success receipt reached stdout.
The database's `key_rotations` table stores the old and new full SHA-256 key IDs atomically with the credentials.
The `store_metadata` row records the required startup key, and the latest rotation receipt must agree with it.
Inspect it with `SELECT old_key_id, new_key_id FROM key_rotations ORDER BY rowid DESC LIMIT 1` while the server is stopped.
Startup rejects a different key and reports the required full SHA-256 key ID in the `startup` error event's `requiredKeyId` field, including when no credentials remain.
The durable audit event uses action `rotate-key`, no user identity for offline maintenance, and the new key ID as its target.
Maintenance keeps its receipt output separate from the optional online audit stream.

## Backup, restore and upgrade rollback

After a task-owned image build is no longer needed, remove its built tag with `docker image rm <task-owned-tag>`.
On containerd-snapshotter hosts, build-cache cleanup cannot be scoped to one build by cache ID; removing the built image tag is the scoped cleanup step, although shared cached layers may remain.
Do not use global builder or system prune commands to clean up one build, and retain images still needed for rollback.

After `pnpm build`, run `node bin/artium-axi-server backup --out /absolute/path/protected-backups/pre-upgrade.db` with the source database and matching master-key environment settings.
The backup directory must already exist and be protected from other users.
The command uses SQLite online backup with a pinned read snapshot, so it can run while the server writes, including when the server holds its maintenance lock.
It validates schema, integrity, foreign keys, the active key ID and every encrypted credential before publishing a new mode-0600 file.
It refuses to replace an existing destination.
The backup includes encrypted platform credentials, password hashes, accounts, roles, retained audit data and retained failure diagnostics, and must be treated as sensitive data.
Never copy only a live `artium.db` file: committed changes can still be in its WAL.
The master key is never bundled with the backup.
Save the printed full SHA-256 key ID, backup timestamp and the source image digest in a protected recovery inventory.

For a container backup, use the matching image and runtime UID, mount the source volume at `/data`, the protected backup directory at `/backups`, and the matching raw 32-byte key read-only at `/run/secrets/artium_master_key`.
Set `ARTIUM_AXI_MASTER_KEY_FILE=/run/secrets/artium_master_key` and run `artium-axi-server backup --out /backups/pre-upgrade.db` in a one-shot container with `--network none --read-only --tmpfs /tmp`.
The source-volume directory must be writable by the runtime UID because SQLite may need its WAL shared-memory file.
The backup directory must be writable by that UID.

Choose a new, empty data volume, provision it for the same runtime UID with directory mode 0700, and keep its server stopped throughout restore.
Mount the backup read-only and the same matching master key separately.
Set the destination `ARTIUM_AXI_DATABASE_FILE` and run `artium-axi-server restore --from /backups/pre-upgrade.db` using the image matching the backup, with the same isolated one-shot container settings above.
For a local disposable restore, run:

```sh
ARTIUM_AXI_DATABASE_FILE=/absolute/path/new-data/artium.db \
ARTIUM_AXI_MASTER_KEY_FILE=/absolute/path/synthetic-key \
node bin/artium-axi-server restore --from /absolute/path/protected-backups/pre-upgrade.db
```

Restore refuses a running destination or a nonempty destination directory.
The maintenance lock file and its journal are the only permitted existing files; never delete them to bypass a running owner.
Restore validates SQLite integrity, foreign keys, supported migration history, the required key ID and authenticated credentials on a private copy before publication.
It migrates that copy to the restoring image's schema, removes all saved CLI access, refresh and password-change tokens, browser sessions, session families and reauthentication tickets, then publishes a durable mode-0600 database.
Thus even a token revoked after backup cannot authenticate after restore.
The source backup is unchanged.
Start the matching image with the new volume and key, sign in again, and check credentials, roles and retained audit data before switching traffic.
Do not assume a restored login still works.

Before every upgrade, stop the server, take a pre-upgrade backup, and record the previous immutable image digest and matching key ID.
Restore that backup into a separate rehearsal volume using the candidate image and matching key to test its migration before touching the live volume.
Start the candidate only against the rehearsal volume and verify fresh login, credentials, role permissions and audit reads.
The Graph and Azure re-pin preserves retained tool configuration and credentials; no administrator edit is needed to refresh the displayed versions.
When an upgraded tool pin activates its credential schema, stored credentials are not automatically converted.
Replace any incompatible credential on its `/admin/tools/:tool` page using the current editor before enabling the tool; stored secrets remain hidden.
A successful migration alone is insufficient acceptance for an upgrade.
Retain the pre-upgrade backup and previous image until the upgrade is accepted and its recovery window expires.
If migration or acceptance fails, stop the candidate, restore the pre-upgrade backup into another empty volume using the previous image and matching key, verify it, then start that previous image on the restored volume.
Rollback loses changes made since the pre-upgrade backup; keep the failed-upgrade volume for investigation until the owner approves its disposal.
Never run an old image against the upgraded volume.
Startup refuses migration versions unknown to its image with `STORE_SCHEMA_INVALID`.
The SSO identity migration preserves local accounts, credentials, grants, sessions and audit history, and marks existing role grants as direct.
Table rebuilds and master-key validation share one transaction; a failure rolls back the schema and migration version records.
The migration checks foreign keys before committing and enables enforcement before exposing the connection.
Reopening an upgraded store does not reapply migrations or enable SSO providers.
Migration 017 adds break-glass designation, defaulting existing accounts to undesignated and preserving their sessions.
See [Sign-in settings](admin-guide.md#sign-in-settings) for designation and session-revocation behaviour.
Migration 014 adds encrypted provider credential storage without rewriting existing identity or tool data.
Provider credentials participate in startup authentication, offline master-key rotation, backup and restore with the same AES-256-GCM format as tool credentials.
Follow [Sign-in settings](admin-guide.md#sign-in-settings) for provider setup and credential replacement rules.
Migration 016 adds a sign-in identity reference to browser sessions without backfilling existing sessions.
Existing SSO sessions must sign in again before SSO confirmation or optional provider sign-out can work.
Local sessions follow the [local-password policy](admin-guide.md#sign-in-settings) for confirmation.
Migration 018 adds last-successful-sign-in role claims and their observation time to identities without backfilling existing identities.
Existing identities remain unknown to Who matches counts until their next successful sign-in, even if they already hold rule-origin grants.
Migration 019 converts the saved role-value arrays into named claim maps under `roles`, preserving observation times, rules and grants.
Other generic-provider claims become available after the next successful sign-in.
The [populated-copy migration regression](../src/server/store/provider-credentials.test.ts) checks preservation, repeat migration and foreign keys without changing the original store.
See [Sign-in settings](admin-guide.md#sign-in-settings) for match-count interpretation.

The interim master-key location is an owner-only `.env` in the directory of `ARTIUM_AXI_DATABASE_FILE`; [server configuration](../src/server/config.ts) owns the default database path.
After validating the database key, server startup atomically replaces this file, saving the plaintext key as canonical base64 in `ARTIUM_AXI_MASTER_KEY` with mode 0600 and preserving unrelated settings.
This happens even when the key comes from a mounted secret; the data volume therefore contains both the encrypted database and its decryption key.
Protect access to the whole volume, and do not treat a volume copy as a database-only backup.
Startup fails with `MASTER_KEY_INVALID` if it cannot read or save the key.
`ARTIUM_AXI_MASTER_KEY_FILE` takes precedence and must contain exactly 32 raw bytes; an unreadable configured file never falls back to another source.
Otherwise, `ARTIUM_AXI_MASTER_KEY` must contain canonical base64 for exactly 32 bytes.
When that environment value is unset, the server and maintenance commands read only `ARTIUM_AXI_MASTER_KEY` from the saved `.env`; other settings in that file are not loaded into the process environment.
An empty or invalid explicit environment key fails instead of falling back.
No key is generated or uploaded by this mechanism.
The owner still decides the later vault, access policy and recovery custody.
Keep escrow separate from database backups and retain every required old key until its last backup expires.
The owner must also set the backup schedule, retention window and deletion procedure; database backups retain their captured audit records even after the live store's 90-day audit cleanup.
Remove expired backups under that policy, and retire a key only after all backups requiring it expire.
Without its matching key, a backup cannot recover encrypted platform credentials.
Exercise recovery periodically on isolated copies and record the image digest, required key ID, backup identity and verification results without key bytes or credentials.

## Upgrading stores without a key binding

Follow the [upgrade precautions](#backup-restore-and-upgrade-rollback), but the backup and restore commands require a key-bound store and cannot process an unbound legacy store.
Migration 006 creates store metadata, and opening the store records the supplied key ID only when existing credentials or a rotation receipt provide key evidence.
Every stored credential must authenticate, and the latest rotation receipt must match when present.
Schema migration and binding commit together; refusal rolls back both.
A legacy store with no binding, credentials or rotation receipt cannot establish which key is correct and fails with `MASTER_KEY_INVALID`.
Do not manufacture metadata to bypass that refusal.
For a disposable development store, start a new database with synthetic settings instead.
For a retained store, preserve the backup and use the previous image on its unchanged pre-upgrade volume pending a separately approved migration decision.
