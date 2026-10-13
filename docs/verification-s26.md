# S26 local verification

S26 implements T2.5 steps 5-7 and the local portion of T0.5.
[az.ts](../src/server/adapters/az.ts) prepares the designated identity with validated native `subscriptions`, `managementGroup`, workspace GUID aliases, `description` and `allowWrites`.
Its private token-mode profile contains no client secret, private key, assertion or access token.
The explicit child environment sets only config, durable write-log path and resource tokens used by the command.
No read-only variable or Artium subscription/resource permission layer is added.
The scan set includes the authentication secret or private key, every injected token and every exact MSAL assertion returned by the cache.
The adapter requires a revision-bound credential reference; the [credential-store interface](../src/server/store/credential-store.ts) owns the store's reference and read contract.
Replacement producers must still evict the cache as described in S25.

The generated [manifest](../tools/inventories/az-axi.json) owns the global flag and environment classifications, reviewed inputs, command resources and pinned parser hashes.
Config, profile and tenant selection remain server-owned.
Subscription flags, repeated lists, accepted aliases and short flags retain their upstream spelling and values.
Leading native selectors are moved behind the command and before any literal `--` separator.
Literal arguments after `--` remain positional input rather than flags.
The adapter restricts file inputs to supplied uploads and normalizes equals forms for runner path substitution.
The pinned clients own fixed API origins, metadata endpoint name validation and opaque continuation markers.
Local config, setup, Azure CLI passthrough and unknown routes remain adapter gaps.

`pnpm test:fake-services` completes compilation before executing the real compiled adapter, MSAL fake transport, runner and pinned az-axi in an isolated internal Docker network with synthetic DNS and a trusted ephemeral CA.
The client has no default route and the harness proves outside TCP is denied.
It reads ARM subscriptions, Log Analytics query rows, Graph users, Storage blob listings, Key Vault secret properties and Registry repositories in token mode.
The first ARM read mints only ARM, and each subsequent resource mints only its own audience.
Vault output includes the synthetic name and properties while discarding a response's canary value.
Storage requests only listing metadata and returns the synthetic blob name and size, never blob content or account keys.
Registry exchange/access tokens are minted inside the upstream process, so exact injected-value scanning does not prove containment of unknown transformed tokens.

The same profile permits a read outside its configured subscription list through `-s`, preserves an upstream permission denial and rejects a foreign API origin upstream.
The leading-selector probe checks separate and equals forms of `--subscription` and `-s` with Resource Graph and Logs queries after `--`, preserving the raw query and Resource Graph subscription override.
Write-enabled credentials with omitted or empty subscriptions prepare ARM and Graph reads without an Artium restriction; pinned az-axi still rejects those profiles through its native write-configuration gate.
Native write tests show zero mutations during preview, one successful executed canary PATCH, a durable log after call cleanup, default opt-in denial, configured write-scope denial and destructive confirmation errors.
Uploaded KQL, piped KQL, uploaded JSON bodies and piped JSON bodies execute through the real runner.
See [Azure safe-pin verification](verification-azure-safe-pin.md) for subsequent ambiguous-write checks and activation evidence.
Other write families remain unverified.
The server's Vectra journal retention format must not be applied to Azure's different native log format.

Final implementation validation requires frozen installation, lint, full tests, aggregate check, walking-skeleton, runner-container, fixed-origin fake-services and the real private hygiene scan.
The PR body and delivery status bind command results to the exact committed and published heads.
Any source/test pipeline fix repeats frozen install, lint, tests, aggregate check and private hygiene before delivery.
The harness removes all containers, networks and temporary files it creates.
The worker removes its created `artium-test-node22` image after verification.
AGENTS.md's existing README pointer remains factually correct and is unchanged under the project-memory correction rule.

Captain acceptance remains pending for both live auth methods, exact successful audience trailing-slash forms, six live reads, real metadata-only output, designated-account native permissions and separately approved sandbox writes.
No fake result closes these live gates.
