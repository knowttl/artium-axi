import { errors, type Diagnostic } from './errors.js'
import { constants } from 'node:os'

export const diagnosticStages = ['configuration', 'token acquisition', 'DNS', 'TCP', 'TLS', 'authentication', 'response', 'tool run'] as const
export const transportCodes = Object.keys(constants.errno)
export const retestCodes = ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNABORTED', 'ENETUNREACH', 'EHOSTUNREACH',
  'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION', 'SERVICE_UNAVAILABLE',
  'CONNECTION_FAILED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_NOT_YET_VALID', 'CERT_HAS_EXPIRED', 'CERT_REVOKED',
  'CERT_CHAIN_TOO_LONG', 'CERT_UNTRUSTED', 'CERT_REJECTED', 'CERT_SIGNATURE_FAILURE', 'CERTIFICATE_VERIFY_FAILED',
  'CERTIFICATE_PIN_MISMATCH', 'CRL_NOT_YET_VALID', 'CRL_HAS_EXPIRED', 'CRL_SIGNATURE_FAILURE',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_CRL',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_DECRYPT_CERT_SIGNATURE', 'UNABLE_TO_DECRYPT_CRL_SIGNATURE',
  'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'INVALID_CA', 'PATH_LENGTH_EXCEEDED', 'HOSTNAME_MISMATCH', 'INVALID_PURPOSE',
  'ERROR_IN_CERT_NOT_BEFORE_FIELD', 'ERROR_IN_CERT_NOT_AFTER_FIELD', 'ERROR_IN_CRL_LAST_UPDATE_FIELD',
  'ERROR_IN_CRL_NEXT_UPDATE_FIELD'] as const
export const diagnosticCodes = [...retestCodes, 'API_RESPONSE_INVALID', 'AUTH_RESPONSE_INVALID', 'RESPONSE_INVALID',
  'MALFORMED_RESPONSE', 'INVALID_RESPONSE', 'PROTOCOL_ERROR', 'AUTH_ENDPOINT_NOT_FOUND', 'AUTH_EXCHANGE_FAILED',
  'TLS_UNTRUSTED', 'TLS_FAILED', 'TLS_TRUST_ERROR', 'SERVER_UNREACHABLE', 'CONTROLLER_UNREACHABLE', 'SERVER_BUSY', 'OPERATION_TIMEOUT',
  'TRANSPORT_FAILED', 'AUTH_FAILED', 'AUTH_REQUIRED', 'AUTH_EXPIRED', 'ACCESS_DENIED', 'PERMISSION_DENIED',
  'PASSWORD_EXPIRED', 'ACCOUNT_DISABLED', 'ACCOUNT_EXPIRED', 'ACCOUNT_LOCKED', 'INSUFFICIENT_ACCESS',
  'STRONGER_AUTH_REQUIRED', 'GSSAPI_CREDENTIAL_UNAVAILABLE', 'GSSAPI_NEGOTIATION_FAILED', 'INVALID_CONFIG',
  'API_ERROR', 'UPSTREAM_ERROR', 'RATE_LIMITED', 'FORBIDDEN', 'VALIDATION_ERROR', 'DELETE_CONFIRM_REQUIRED',
  'ENOENT', 'EACCES', 'EPERM', 'EIO', 'ENOSPC', 'EMFILE', 'ENFILE', 'EPIPE', 'EADDRINUSE', 'EADDRNOTAVAIL',
  'EISDIR', 'ENOTDIR', 'ENOTEMPTY', 'EROFS', 'ENOSYS', 'EINVAL', 'ENOMEM', 'ENOBUFS',
  'OUTCOME_UNKNOWN', 'PARTIAL_OUTCOME', 'WRITE_UNCERTAIN', 'DELIVERY_UNCERTAIN',
  'AADSTS7000215', 'AADSTS7000222', 'AADSTS700016', 'AADSTS90002', 'AADSTS700027'] as const

export type ValidatedDiagnosticCode = typeof diagnosticCodes[number] | `E${string}`

export function validDiagnosticCode(value: unknown): value is ValidatedDiagnosticCode {
  return typeof value === 'string' && ((diagnosticCodes as readonly string[]).includes(value) || transportCodes.includes(value))
}

export interface StructuredDiagnostic {
  stage: Diagnostic['stage']
  message: 'Details unavailable.'
  toolCode?: ValidatedDiagnosticCode
  providerCode?: `AADSTS${number}`
  transportCode?: ValidatedDiagnosticCode
  upstreamStatus?: number
  trust?: 'self-signed' | 'untrusted'
  checkedAt?: number
  credentialRevision?: number | null
}

export function diagnosticCode(value: unknown): string | null {
  return validDiagnosticCode(value) || typeof value === 'string' && Object.hasOwn(errors, value) ? value : null
}

export function structuredDiagnostic(input: unknown): StructuredDiagnostic | undefined {
  if (!input || typeof input !== 'object') return
  const detail = input as Record<string, unknown>
  if (!diagnosticStages.includes(detail.stage as Diagnostic['stage'])) return
  return {
    stage: detail.stage as Diagnostic['stage'], message: 'Details unavailable.',
    ...(validDiagnosticCode(detail.toolCode) ? { toolCode: detail.toolCode } : {}),
    ...(typeof detail.providerCode === 'string' && /^AADSTS\d{4,8}$/.test(detail.providerCode)
      ? { providerCode: detail.providerCode as `AADSTS${number}` } : {}),
    ...(validDiagnosticCode(detail.transportCode) ? { transportCode: detail.transportCode } : {}),
    ...(typeof detail.upstreamStatus === 'number' && Number.isInteger(detail.upstreamStatus) && detail.upstreamStatus >= 100 && detail.upstreamStatus <= 599
      ? { upstreamStatus: detail.upstreamStatus } : {}),
    ...(detail.trust === 'self-signed' || detail.trust === 'untrusted' ? { trust: detail.trust } : {}),
    ...(Number.isSafeInteger(detail.checkedAt) ? { checkedAt: detail.checkedAt as number } : {}),
    ...(detail.credentialRevision === null || Number.isSafeInteger(detail.credentialRevision)
      ? { credentialRevision: detail.credentialRevision as number | null } : {}),
  }
}
