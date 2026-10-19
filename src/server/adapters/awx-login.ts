import { ArtiumError, type Diagnostic, type ErrorCode } from '../../shared/errors.js'
import { runnerLimits } from '../config.js'
import { credentialFetch } from '../credential-tls.js'
import { certificateErrorCodePattern, safeDiagnostic } from '../health/diagnostic.js'
import { SecretScanner } from '../runner/scan.js'
import type { CredentialTrust } from '../store/trusted-certificates.js'
import { isCanonicalHttpsOrigin } from './credential-input.js'

// Same token request as awx-axi auth login. The password exists only for this call.
const tokenRequest = { description: 'awx-axi', scope: 'write' }

function entered(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0
  return value !== undefined && value !== null
}

export function awxPasswordRequested(value: Record<string, unknown>): boolean {
  return value.signIn === 'password' || entered(value.username) || entered(value.password)
}

function withoutSignIn(value: Record<string, unknown>): Record<string, unknown> {
  const next = { ...value }
  delete next.signIn
  delete next.username
  delete next.password
  return next
}

function failure(code: ErrorCode, message: string, next: string, secrets: readonly string[], diagnostic?: Diagnostic): ArtiumError {
  const known = secrets.filter(secret => secret.length > 0)
  const detail = diagnostic ? safeDiagnostic(diagnostic, known) : undefined
  const rendered = Buffer.from(`${message}\n${next}\n${detail ? JSON.stringify(detail) : ''}`)
  if (known.length > 0 && new SecretScanner(known).scan('stderr', rendered)) return new ArtiumError(code)
  const error = new ArtiumError(code, message, next)
  if (detail) error.diagnostic = detail
  return error
}

function offersBasic(header: string | null): boolean {
  return header !== null && /(^|,)\s*basic(?:\s|=|$)/i.test(header)
}

function statusFailure(status: number, authenticate: string | null, secrets: readonly string[], host: string): ArtiumError {
  const diagnostic = { stage: 'token acquisition' as const, ...(host ? { host } : {}) }
  if (status === 401 && !offersBasic(authenticate)) return failure('UPSTREAM_AUTH_FAILED',
    'This controller has basic authentication disabled, so a username and password cannot mint a token.',
    'Paste an existing personal access token instead.', secrets,
    { ...diagnostic, message: 'The controller did not offer basic authentication.' })
  if (status === 401) return failure('UPSTREAM_AUTH_FAILED',
    'The controller rejected the username or password.',
    'Check the username and password, or paste an existing personal access token.', secrets,
    { ...diagnostic, message: 'The controller rejected the username or password.' })
  if (status === 403) return failure('UPSTREAM_AUTH_FAILED',
    'The controller refused to mint a personal access token.',
    'Check that this account may create tokens, or paste an existing personal access token.', secrets,
    { ...diagnostic, message: 'The controller refused to mint a personal access token.' })
  if (status === 400) return failure('INVALID_INPUT',
    'The controller rejected the token request.',
    'Check the controller token settings, or paste an existing personal access token.', secrets,
    { ...diagnostic, message: 'The controller rejected the token request.' })
  if (status === 502 || status === 503 || status === 504) return failure('UPSTREAM_NETWORK_FAILED',
    'The controller is not accepting token requests right now.',
    'Try again later.', secrets,
    { ...diagnostic, message: 'The controller is not accepting token requests right now.' })
  return failure('TOOL_FAILED', 'The controller failed to mint a token.', 'Try again later.', secrets,
    { ...diagnostic, message: 'The controller failed to mint a token.' })
}

function transportFailure(error: unknown, secrets: readonly string[], host: string): ArtiumError {
  const fields = error as { code?: unknown, cause?: { code?: unknown }, name?: unknown }
  const code = typeof fields.code === 'string' ? fields.code : typeof fields.cause?.code === 'string' ? fields.cause.code : ''
  const name = typeof fields.name === 'string' ? fields.name : ''
  const where = host ? { host } : {}
  if (certificateErrorCodePattern.test(code) || code.startsWith('ERR_TLS_')) return failure('UPSTREAM_TLS_FAILED',
    'The controller certificate could not be verified.',
    'Inspect and trust the controller certificate, or paste an existing personal access token.', secrets,
    { stage: 'TLS', ...where, message: 'TLS certificate verification failed contacting the controller.',
      ...(code ? { toolCode: code.slice(0, 80) } : {}) })
  if (name === 'AbortError' || name === 'TimeoutError' || code === 'ABORT_ERR'
    || /^(?:ECONN|ENOTFOUND|EAI_|ETIMEDOUT|EHOST|ENETUNREACH|EPIPE)/.test(code)) return failure('UPSTREAM_NETWORK_FAILED',
    'The controller could not be reached.',
    'Check DNS, routing and firewall rules, then try again.', secrets,
    { stage: 'TCP', ...where, message: 'Token acquisition could not reach the controller.' })
  return failure('TOOL_FAILED', 'The controller failed to mint a token.', 'Try again later.', secrets,
    { stage: 'token acquisition', ...where, message: 'The controller failed to mint a token.' })
}

export async function exchangeAwxPassword(value: Record<string, unknown>, trust: readonly CredentialTrust[]): Promise<Record<string, unknown>> {
  const username = value.username
  const password = value.password
  const secrets: string[] = []
  if (typeof password === 'string' && password.length > 0) {
    secrets.push(password)
    if (typeof username === 'string') secrets.push(Buffer.from(`${username}:${password}`).toString('base64'))
  }
  const requested = awxPasswordRequested(value)
  if ((value.signIn === 'token' && (entered(username) || entered(password))) || (requested && entered(value.token))) {
    throw failure('INVALID_INPUT', 'Choose either a personal access token or a username and password.',
      'Clear one sign-in method and save again.', secrets)
  }
  if (!requested) return withoutSignIn(value)
  if (typeof username !== 'string' || username.length === 0 || typeof password !== 'string' || !/\S/.test(password)) {
    throw failure('INVALID_INPUT', 'Username and password are both required to mint a token.',
      'Enter both, or clear them and paste a token.', secrets)
  }
  if (typeof value.origin !== 'string' || !isCanonicalHttpsOrigin(value.origin)) {
    throw failure('INVALID_INPUT', 'origin must be an HTTPS origin without a path, query, fragment or embedded credentials.',
      'Enter the controller HTTPS origin, for example https://controller.example.', secrets)
  }
  const origin = value.origin
  const host = new URL(origin).hostname
  const basic = Buffer.from(`${username}:${password}`).toString('base64')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), runnerLimits.timeoutMs)
  try {
    const response = await credentialFetch(new URL('/api/v2/tokens/', origin).href, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Basic ${basic}` },
      body: JSON.stringify(tokenRequest),
      signal: controller.signal,
    }, trust)
    const text = await response.text()
    if (response.status !== 201) throw statusFailure(response.status, response.headers.get('www-authenticate'), secrets, host)
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { parsed = undefined }
    const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    const token = record.token
    if (typeof token !== 'string' || token.length === 0) throw failure('UPSTREAM_AUTH_FAILED',
      'The controller returned no token.', 'Paste an existing personal access token instead.', secrets,
      { stage: 'token acquisition', host, message: 'The controller returned no token.' })
    secrets.push(token)
    const id = record.id
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw failure('UPSTREAM_AUTH_FAILED',
      'The controller returned no personal access token id, so the token was not stored.',
      'Paste an existing personal access token instead.', secrets,
      { stage: 'token acquisition', host, message: 'The controller returned no personal access token id.' })
    return { ...withoutSignIn(value), token }
  } catch (error) {
    if (error instanceof ArtiumError) throw error
    throw transportFailure(error, secrets, host)
  } finally { clearTimeout(timer) }
}
