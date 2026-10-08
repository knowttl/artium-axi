export const errors = {
  TOKEN_INVALID: { status: 401, message: 'The access token is invalid, expired or revoked.', next: 'Sign in again to obtain a valid access token.' },
  USER_DISABLED: { status: 403, message: 'The user is disabled.', next: 'Ask the administrator to enable the user.' },
  TOOL_DISABLED: { status: 403, message: 'The tool is disabled.', next: 'Ask the administrator to enable the tool.' },
  TOOL_NOT_GRANTED: { status: 403, message: 'The user has no role granting this tool.', next: 'Ask the administrator to assign a role granting the tool.' },
  MASTER_KEY_INVALID: { status: 503, message: 'The master key is missing or invalid.', next: 'Supply a 32-byte master key file or a base64 master key.' },
  CREDENTIAL_INVALID: { status: 503, message: 'A stored credential could not be authenticated or contains malformed JSON.', next: 'Restore the matching master key and an intact credential store containing valid credential JSON.' },
  FLAG_BLOCKED: { status: 400, message: 'The arguments override the managed tool boundary.', next: 'Remove destination, tenant, credential or local configuration overrides.' },
  CREDENTIAL_UNAVAILABLE: { status: 503, message: 'The tool credential is unavailable.', next: 'Ask the administrator to check the tool configuration and stored credentials.' },
  INVALID_INPUT: { status: 400, message: 'The run input is invalid.', next: 'Check the arguments, stdin and uploaded files.' },
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
  constructor(readonly code: ErrorCode, message: string = errors[code].message, next: string = errors[code].next) {
    super(message)
    this.next = next
  }
}

export function errorResponse(error: ArtiumError, requestId: string) {
  return { error: { code: error.code, source: error.source, message: error.message, next: error.next, requestId } }
}
