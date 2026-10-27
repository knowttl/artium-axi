export const cliOutdatedUpdateNext = 'Run artium-axi update to install the current CLI.'
// Safe default for CLI_OUTDATED: this step works whether or not the client
// has the update command, so it is also the catalogue default below.
export const cliOutdatedDownloadNext = 'Download the current CLI from /cli/artium-axi.mjs on this server, verify it with the SHA-256 checksum at /cli/artium-axi.mjs.sha256, and install it as artium-axi.'

const definitions = {
  STORE_SCHEMA_INVALID: { status: 503, message: 'The store schema is unsupported by this image.', next: 'Use the matching image, or restore the pre-upgrade backup into a new volume with its matching image and key.' },
  BACKUP_FAILED: { status: 500, message: 'Database backup did not complete.', next: 'Check the source store and a writable backup directory; choose a new output file.' },
  RESTORE_FAILED: { status: 500, message: 'Database restore did not complete.', next: 'Stop the destination server and use an empty new data volume, an intact backup and its matching master key.' },
  CLI_OUTDATED: { status: 426, message: 'The CLI version is too old for this server.', next: cliOutdatedDownloadNext },
  CERTIFICATE_INVALID: { status: 503, message: 'The server certificate could not be verified.', next: 'Check certificate trust or set ARTIUM_AXI_CA_FILE to the trusted CA file.' },
  ADMIN_REQUIRED: { status: 403, message: 'Administrator capability is required.', next: 'Ask an administrator to perform this operation.' },
  REVISION_CONFLICT: { status: 409, message: 'The record changed since it was read.', next: 'Read the current record revision and retry your edit.' },
  LAST_ADMINISTRATOR: { status: 409, message: 'The last enabled administrator must remain enabled.', next: 'Enable another administrator before changing this account.' },
  USERNAME_INVALID: { status: 400, message: 'The local username is invalid.', next: 'Supply a nonempty username without whitespace or control characters.' },
  PASSWORD_FILE_INVALID: { status: 400, message: 'The password file is missing or unreadable.', next: 'Supply a readable UTF-8 password file containing the exact password, without an added newline.' },
  BOOTSTRAP_INCONSISTENT: { status: 503, message: 'The store contains data without a bootstrap marker.', next: 'Stop the server and restore a consistent bootstrapped store and matching master key.' },
  RECOVERY_FAILED: { status: 500, message: 'Administrator recovery did not complete.', next: 'Use an existing local username in a bootstrapped store, check the matching master key and inspect local storage.' },
  PASSWORD_INVALID: { status: 400, message: 'The password must be non-empty and at most 512 UTF-8 bytes.', next: 'Enter a password of at most 512 UTF-8 bytes.' },
  SIGN_IN_FAILED: { status: 401, message: 'The username or password is incorrect.', next: 'Check your username and password.' },
  SSO_STATE_INVALID: { status: 400, message: 'The SSO sign-in request expired or was already used.', next: 'Start a new sign-in from this browser.' },
  SSO_TOKEN_INVALID: { status: 401, message: 'The identity provider response could not be verified.', next: 'Start a new sign-in or ask an administrator to check provider settings.' },
  SSO_NOT_INVITED: { status: 403, message: 'This identity is not linked to an artium account.', next: 'Ask an administrator for an invitation and open its link to sign in.' },
  SSO_INVITE_INVALID: { status: 403, message: 'This invitation cannot be claimed by this identity.', next: 'Use the expected sign-in username or ask an administrator for a new invitation link.' },
  SSO_PROVIDER_ERROR: { status: 503, message: 'SSO sign-in is unavailable.', next: 'Ask an administrator to check the provider configuration or try again later.' },
  DEVICE_CODE_INVALID: { status: 400, message: 'The device code is invalid or was already used.', next: 'Run artium-axi login --sso to start a new request.' },
  DEVICE_CODE_EXPIRED: { status: 400, message: 'The device request expired.', next: 'Run artium-axi login --sso to start a new request.' },
  DEVICE_DENIED: { status: 403, message: 'The device request was denied.', next: 'Start a new sign-in only if you requested it.' },
  DEVICE_POLL_LIMITED: { status: 429, message: 'The device request was polled too quickly.', next: 'Wait for the requested polling interval before polling again.' },
  AUTH_RATE_LIMITED: { status: 429, message: 'The authentication attempt limit was reached.', next: 'Wait 15 minutes before trying again.' },
  ACCOUNT_LOCKED: { status: 429, message: 'The account is temporarily locked.', next: 'Wait 15 minutes or ask an administrator to unlock the account.' },
  REAUTH_REQUIRED: { status: 401, message: 'Recent identity confirmation is required.', next: 'In the browser, confirm at /reauth using Microsoft for SSO or your local password. Local CLI users confirm their password through /v1/auth/reauth.' },
  CSRF_INVALID: { status: 403, message: 'The form token or request origin is invalid.', next: 'Reload the form on this server and submit it again.' },
  AUTH_BUSY: { status: 429, message: 'The concurrent password hashing limit was reached.', next: 'Wait for an active authentication request to finish.' },
  MAINTENANCE_BUSY: { status: 503, message: 'The store is held by another server or maintenance process.', next: 'Stop the server and wait for maintenance to finish before retrying.' },
  MAINTENANCE_UNAVAILABLE: { status: 503, message: 'The store maintenance lock is unavailable.', next: 'Check data-volume capacity and permissions.' },
  ROTATION_FAILED: { status: 500, message: 'Master key rotation did not complete.', next: 'Keep both keys. Inspect the durable key_rotations receipt and restart with its latest new_key_id, or the old key if no rotation committed.' },
  CLIENT_CONFIG_INVALID: { status: 400, message: 'The CLI server configuration is invalid.', next: 'Set ARTIUM_AXI_URL to an HTTPS URL; optionally set ARTIUM_AXI_CA_FILE.' },
  SESSION_STORAGE_UNAVAILABLE: { status: 500, message: 'Secure CLI session storage is unavailable.', next: 'Check your configuration folder permissions and capacity, then sign in again.' },
  SESSION_SERVER_MISMATCH: { status: 400, message: 'The stored session belongs to a different server.', next: 'Restore ARTIUM_AXI_URL or use artium-axi logout before signing in to the new server.' },
  SESSION_BUSY: { status: 503, message: 'Another CLI process holds the session lock.', next: 'Wait for the other CLI process. If all CLI processes exited, remove the session.lock directory in your artium-axi configuration folder.' },
  SESSION_CHANGED: { status: 409, message: 'The signed-in user changed during this operation.', next: 'Check the signed-in identity before starting a new operation.' },
  PASSWORD_CHANGE_REQUIRED: { status: 409, message: 'Change your temporary password before using tools.', next: 'Run artium-axi passwd --password-stdin.' },
  SERVER_UNAVAILABLE: { status: 503, message: 'The CLI could not receive a server response.', next: 'Check the server address and certificate trust; confirm the previous call outcome before retrying.' },
  INVALID_RESPONSE: { status: 500, message: 'The server returned an invalid response.', next: 'Check the server URL and API version.' },
  KEY_LEVEL_RESTRICTED: { status: 403, message: 'HTTP 403: restricted key cannot download.', next: 'Request vetted-account download access. Administrator write settings cannot grant upstream entitlement. No other key or route was tried.' },
  PERMISSION_DENIED: { status: 403, message: 'HTTP 403: download denied; key level unknown.', next: 'Check upstream entitlement and request account vetting where required. Administrator write settings cannot grant upstream entitlement. No other key or route was tried.' },
  ARTIFACT_SAVE_FAILED: { status: 400, message: 'The archive was not verified and saved.', next: 'Check the dedicated private destination directory. Start a fresh preview and confirmation; interrupted transfers cannot be retried.' },
  DEV_AUTH_INVALID: { status: 503, message: 'Development authentication settings are unsupported.', next: 'Remove ARTIUM_AXI_DEV and ARTIUM_AXI_DEV_TOKEN_FILE and use local sign-in.' },
  PROXY_HEADERS_UNTRUSTED: { status: 400, message: 'Forwarding headers came from an untrusted address.', next: 'Connect through the configured trusted proxy or remove forwarding headers.' },
  NOT_FOUND: { status: 404, message: 'The endpoint does not exist.', next: 'Use a supported API endpoint and tool name.' },
  AUDIT_UNAVAILABLE: { status: 503, message: 'The audit event could not be stored.', next: 'Ask the administrator to check audit storage capacity and availability.' },
  TOKEN_INVALID: { status: 401, message: 'The token is invalid or revoked.', next: 'Sign in again to obtain a valid token.' },
  TOKEN_EXPIRED: { status: 401, message: 'The token has expired.', next: 'Sign in again.' },
  USER_DISABLED: { status: 403, message: 'The user is disabled.', next: 'Ask the administrator to enable the user.' },
  TOOL_DISABLED: { status: 403, message: 'The tool is disabled.', next: 'Ask the administrator to enable the tool.' },
  TOOL_NOT_GRANTED: { status: 403, message: 'The user has no role granting this tool.', next: 'Ask the administrator to assign a role granting the tool.' },
  MASTER_KEY_INVALID: { status: 503, message: 'The master key is missing or invalid.', next: 'Supply a 32-byte master key file or a base64 master key.' },
  CREDENTIAL_INVALID: { status: 503, message: 'The stored credential is invalid.', next: 'Ask an administrator to check the named field, matching master key and credential JSON, then save and test again.' },
  CREDENTIAL_EXPIRED: { status: 503, message: 'The GitHub credential expired or was revoked.', next: 'Ask an administrator to reconnect at /admin/tools/gh-axi. Tokens are never refreshed automatically.' },
  FLAG_BLOCKED: { status: 400, message: 'The arguments override the managed tool boundary.', next: 'Remove destination, tenant, credential or local configuration overrides.' },
  CREDENTIAL_NOT_CONFIGURED: { status: 503, message: 'No credential is configured for the tool.', next: 'Ask an administrator to save a credential and run Test credential.' },
  UPSTREAM_AUTH_FAILED: { status: 503, message: 'The upstream service rejected the credential.', next: 'Ask an administrator to check the provider code, identity, secret expiry and permissions, then test again.' },
  UPSTREAM_NETWORK_FAILED: { status: 503, message: 'The upstream service could not be reached.', next: 'Ask an administrator to check DNS, routing, firewall rules and the diagnostic host and stage.' },
  UPSTREAM_TLS_FAILED: { status: 503, message: 'The upstream certificate could not be verified.', next: 'Ask an administrator to check the host, certificate chain and trusted CA configuration.' },
  TOOL_REJECTED_INPUT: { status: 503, message: 'The tool rejected its configuration or arguments.', next: 'Ask an administrator to correct the field or combination named by the tool and test again.' },
  TOOL_FAILED: { status: 503, message: 'The tool exited unsuccessfully.', next: 'Ask an administrator to inspect the diagnostic message and hint from Test credential.' },
  INVALID_INPUT: { status: 400, message: 'The request input is invalid.', next: 'Check the request fields and content type.' },
  UNSUPPORTED_INPUT: { status: 400, message: 'The input file is not a matching upload.', next: 'Upload the file using a reviewed input-file flag.' },
  SECRET_IN_OUTPUT: { status: 500, message: 'A known secret was detected in tool output.', next: 'Check upstream output redaction before retrying.' },
  SPAWN_FAILED: { status: 500, message: 'The upstream tool could not be started.', next: 'Check the configured executable and environment.' },
  PROCESS_SIGNAL: { status: 500, message: 'The upstream tool ended on a signal.', next: 'Check the tool status before retrying.' },
  TIMEOUT: { status: 504, message: 'The upstream tool exceeded its timeout.', next: 'Check the tool status before retrying.' },
  UNKNOWN_OUTCOME: { status: 504, message: 'The write may have changed state before the tool stopped.', next: 'Check current state before trying again.' },
  CANCELLED: { status: 500, message: 'The call was cancelled.', next: 'Check the tool status before retrying.' },
  OUTPUT_LIMIT: { status: 500, message: 'The upstream tool exceeded the output limit.', next: 'Use a command that produces less output.' },
  TOO_MANY_CALLS: { status: 429, message: 'The concurrent call limit was reached.', next: 'Wait for an active call to finish.' },
  RUNNER_CLOSED: { status: 503, message: 'The runner is shutting down.', next: 'Wait for the server to become available.' },
  TEMP_UNAVAILABLE: { status: 503, message: 'The private call inputs could not be created.', next: 'Check temporary storage capacity and permissions.' },
  INTERNAL_ERROR: { status: 500, message: 'The server could not complete the request.', next: 'Contact the administrator with the request ID.' },
} as const

export type ErrorCode = keyof typeof errors

const usageErrors: readonly (keyof typeof definitions)[] = ['INVALID_INPUT', 'UNSUPPORTED_INPUT', 'FLAG_BLOCKED', 'CLIENT_CONFIG_INVALID']

export const errors = Object.fromEntries(Object.entries(definitions).map(([code, definition]) =>
  [code, { ...definition, source: 'artium-axi', exitCode: usageErrors.includes(code as keyof typeof definitions) ? 2 : 1 }])) as {
    [Code in keyof typeof definitions]: typeof definitions[Code] & { source: 'artium-axi', exitCode: 1 | 2 }
  }

export class ArtiumError extends Error {
  diagnostic?: Diagnostic
  readonly source: 'artium-axi'
  readonly next: string
  constructor(readonly code: ErrorCode, message: string = errors[code].message, next: string = errors[code].next, readonly requestId?: string) {
    super(message)
    this.source = errors[code].source
    this.next = next
  }
}

// Only administrator credential-test and cached-health responses may serialize this detail.
export interface Diagnostic {
  stage: 'configuration' | 'token acquisition' | 'DNS' | 'TCP' | 'TLS' | 'authentication' | 'tool run'
  message: string
  toolCode?: string
  providerCode?: string
  hint?: string
  host?: string
  issuer?: string
  trust?: 'self-signed' | 'untrusted'
  checkedAt?: number
  credentialRevision?: number | null
}

export function errorResponse(error: ArtiumError, requestId: string) {
  return { error: { code: error.code, source: error.source, message: error.message, next: error.next, requestId: error.requestId ?? requestId } }
}
