export const errors = {
  CLI_OUTDATED: { status: 426, message: 'The CLI version is too old for this server.', next: 'Download the current CLI from /cli/artium-axi.mjs.' },
  CERTIFICATE_INVALID: { status: 503, message: 'The server certificate could not be verified.', next: 'Check certificate trust or set ARTIUM_AXI_CA_FILE to the trusted CA file.' },
  ADMIN_REQUIRED: { status: 403, message: 'Administrator capability is required.', next: 'Ask an administrator to perform this operation.' },
  REVISION_CONFLICT: { status: 409, message: 'The record changed since it was read.', next: 'Read the current record revision and retry your edit.' },
  LAST_ADMINISTRATOR: { status: 409, message: 'The last enabled administrator must remain enabled.', next: 'Enable another administrator before changing this account.' },
  USERNAME_INVALID: { status: 400, message: 'The local username is invalid.', next: 'Supply a nonempty username without whitespace or control characters.' },
  PASSWORD_FILE_INVALID: { status: 400, message: 'The password file is missing or unreadable.', next: 'Supply a readable UTF-8 password file containing the exact password, without an added newline.' },
  BOOTSTRAP_INCONSISTENT: { status: 503, message: 'The store contains data without a bootstrap marker.', next: 'Stop the server and restore a consistent bootstrapped store and matching master key.' },
  RECOVERY_FAILED: { status: 500, message: 'Administrator recovery did not complete.', next: 'Use an existing local username in a bootstrapped store, check the matching master key and inspect local storage.' },
  PASSWORD_INVALID: { status: 400, message: 'The password does not meet the local password rules.', next: 'Use 15 to 128 Unicode code points, at most 512 UTF-8 bytes, and avoid common passwords.' },
  SIGN_IN_FAILED: { status: 401, message: 'The username or password is incorrect.', next: 'Check your username and password.' },
  AUTH_RATE_LIMITED: { status: 429, message: 'The authentication attempt limit was reached.', next: 'Wait 15 minutes before trying again.' },
  ACCOUNT_LOCKED: { status: 423, message: 'The account is temporarily locked.', next: 'Wait 15 minutes or ask an administrator to unlock the account.' },
  REAUTH_REQUIRED: { status: 401, message: 'Recent password confirmation is required.', next: 'Confirm your password through /v1/auth/reauth.' },
  CSRF_INVALID: { status: 403, message: 'The form token or request origin is invalid.', next: 'Reload the form on this server and submit it again.' },
  AUTH_BUSY: { status: 429, message: 'The concurrent password hashing limit was reached.', next: 'Wait for an active authentication request to finish.' },
  MAINTENANCE_BUSY: { status: 503, message: 'The store is held by another server or maintenance process.', next: 'Stop the server and wait for maintenance to finish before retrying.' },
  MAINTENANCE_UNAVAILABLE: { status: 503, message: 'The store maintenance lock is unavailable.', next: 'Check data-volume capacity and permissions.' },
  ROTATION_FAILED: { status: 500, message: 'Master key rotation did not complete.', next: 'Keep both keys. Inspect the durable key_rotations receipt and restart with its latest new_key_id, or the old key if no rotation committed.' },
  CLIENT_CONFIG_INVALID: { status: 400, message: 'The CLI server configuration is invalid.', next: 'Set ARTIUM_AXI_URL to an HTTPS URL; optionally set ARTIUM_AXI_CA_FILE. Windows requires APPDATA.' },
  SESSION_STORAGE_UNAVAILABLE: { status: 500, message: 'Secure CLI session storage is unavailable.', next: 'Check your configuration folder permissions and capacity, then sign in again.' },
  SESSION_SERVER_MISMATCH: { status: 400, message: 'The stored session belongs to a different server.', next: 'Restore ARTIUM_AXI_URL or use artium-axi logout before signing in to the new server.' },
  SESSION_BUSY: { status: 503, message: 'Another CLI process holds the session lock.', next: 'Wait for the other CLI process. If all CLI processes exited, remove the session.lock directory in your artium-axi configuration folder.' },
  SESSION_CHANGED: { status: 409, message: 'The signed-in user changed during this operation.', next: 'Check the signed-in identity before starting a new operation.' },
  PASSWORD_CHANGE_REQUIRED: { status: 409, message: 'Change your temporary password before using tools.', next: 'Run artium-axi passwd --password-stdin.' },
  SERVER_UNAVAILABLE: { status: 503, message: 'The CLI could not receive a server response.', next: 'Check the server address and certificate trust; confirm the previous call outcome before retrying.' },
  INVALID_RESPONSE: { status: 500, message: 'The server returned an invalid response.', next: 'Check the server URL and API version.' },
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
  CREDENTIAL_INVALID: { status: 503, message: 'A stored credential could not be authenticated or contains malformed JSON.', next: 'Restore the matching master key and an intact credential store containing valid credential JSON.' },
  FLAG_BLOCKED: { status: 400, message: 'The arguments override the managed tool boundary.', next: 'Remove destination, tenant, credential or local configuration overrides.' },
  CREDENTIAL_UNAVAILABLE: { status: 503, message: 'The tool credential is unavailable.', next: 'Ask the administrator to check the tool configuration and stored credentials.' },
  INVALID_INPUT: { status: 400, message: 'The request input is invalid.', next: 'Check the request fields and content type.' },
  UNSUPPORTED_INPUT: { status: 400, message: 'The input file is not a matching upload.', next: 'Upload the file using a reviewed input-file flag.' },
  SECRET_IN_OUTPUT: { status: 500, message: 'A known secret was detected in tool output.', next: 'Check upstream output redaction before retrying.' },
  SPAWN_FAILED: { status: 500, message: 'The upstream tool could not be started.', next: 'Check the configured executable and environment.' },
  PROCESS_SIGNAL: { status: 500, message: 'The upstream tool ended on a signal.', next: 'Check the tool status before retrying.' },
  TIMEOUT: { status: 504, message: 'The upstream tool exceeded its timeout.', next: 'Check the tool status before retrying.' },
  CANCELLED: { status: 500, message: 'The call was cancelled.', next: 'Check the tool status before retrying.' },
  OUTPUT_LIMIT: { status: 500, message: 'The upstream tool exceeded the output limit.', next: 'Use a command that produces less output.' },
  TOO_MANY_CALLS: { status: 429, message: 'The concurrent call limit was reached.', next: 'Wait for an active call to finish.' },
  RUNNER_CLOSED: { status: 503, message: 'The runner is shutting down.', next: 'Wait for the server to become available.' },
  TEMP_UNAVAILABLE: { status: 503, message: 'The private call inputs could not be created.', next: 'Check temporary storage capacity and permissions.' },
  INTERNAL_ERROR: { status: 500, message: 'The server could not complete the request.', next: 'Contact the administrator with the request ID.' },
} as const

export type ErrorCode = keyof typeof errors

export class ArtiumError extends Error {
  readonly source = 'artium-axi'
  readonly next: string
  constructor(readonly code: ErrorCode, message: string = errors[code].message, next: string = errors[code].next, readonly requestId?: string) {
    super(message)
    this.next = next
  }
}

export function errorResponse(error: ArtiumError, requestId: string) {
  return { error: { code: error.code, source: error.source, message: error.message, next: error.next, requestId: error.requestId ?? requestId } }
}
