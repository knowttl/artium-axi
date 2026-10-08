import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { rootCertificates } from 'node:tls'
import { errorResponseSchema, loginResponseSchema } from '../shared/api.js'
import { ArtiumError } from '../shared/errors.js'
import { cliVersion } from '../shared/version.js'
import { SessionStore, sessionPath } from './session.js'
import type { StoredSession } from './session.js'

export const DEFAULT_REQUEST_DEADLINE_MS = 90_000

export class Client {
  readonly serverUrl: string
  readonly sessions: SessionStore
  constructor(private readonly environment = process.env) {
    try {
      const url = new URL(environment.ARTIUM_AXI_URL!)
      if (url.username || url.password || url.href.includes('?') || url.href.includes('#') ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && environment.ARTIUM_AXI_TEST_HTTP === '1' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error()
      this.serverUrl = url.href.replace(/\/$/, '')
      this.sessions = new SessionStore(this.serverUrl, sessionPath(process.platform, environment))
    } catch { throw new ArtiumError('CLIENT_CONFIG_INVALID') }
  }

  async request(path: string, method: 'GET' | 'POST', input?: unknown, token?: string): Promise<unknown> {
    let ca: string[] | undefined
    try { if (this.environment.ARTIUM_AXI_CA_FILE) ca = [...rootCertificates, readFileSync(this.environment.ARTIUM_AXI_CA_FILE, 'utf8')] }
    catch { throw new ArtiumError('CLIENT_CONFIG_INVALID') }
    const body = input === undefined ? undefined : JSON.stringify(input)
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), DEFAULT_REQUEST_DEADLINE_MS)
    const url = new URL(`${this.serverUrl}${path}`)
    const result = await new Promise<{ status: number, body: unknown }>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method, ca, rejectUnauthorized: true, signal: controller.signal,
        headers: { 'x-artium-cli-version': cliVersion, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      }, response => {
        if (response.statusCode! >= 300 && response.statusCode! < 400) {
          response.destroy()
          reject(new ArtiumError('INVALID_RESPONSE', 'Authenticated redirects are refused.'))
          return
        }
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('error', () => reject(new ArtiumError('SERVER_UNAVAILABLE')))
        response.on('end', () => {
          try { resolve({ status: response.statusCode!, body: response.statusCode === 204 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8')) }) }
          catch { reject(new ArtiumError('INVALID_RESPONSE')) }
        })
      })
      request.on('error', error => reject(new ArtiumError(
        ['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
          'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID']
          .includes((error as NodeJS.ErrnoException).code ?? '') ? 'CERTIFICATE_INVALID' : 'SERVER_UNAVAILABLE')))
      request.end(body)
    }).finally(() => clearTimeout(deadline))
    const failure = errorResponseSchema.safeParse(result.body)
    if (failure.success) {
      const { code, message, next } = failure.data.error
      throw new ArtiumError(code, message, next, failure.data.error.requestId)
    }
    if (result.status !== 200 && result.status !== 204) throw new ArtiumError('INVALID_RESPONSE')
    return result.body
  }

  async authenticated(path: string, method: 'GET' | 'POST', input?: unknown): Promise<unknown> {
    const session = this.sessions.read()
    if (!session) throw new ArtiumError('TOKEN_INVALID', undefined, 'Run artium-axi login --username <username> --password-stdin.')
    if (session.status === 'password-change-required') throw new ArtiumError('PASSWORD_CHANGE_REQUIRED')
    try { return await this.request(path, method, input, session.accessToken) }
    catch (error) {
      if (!(error instanceof ArtiumError) || error.code !== 'TOKEN_EXPIRED') throw error
    }
    const fresh = await this.sessions.locked(() => this.refresh(session))
    return this.request(path, method, input, fresh.accessToken)
  }

  // The caller holds the session lock, including the reload after acquisition.
  private async refresh(previous: Extract<StoredSession, { status: 'authenticated' }>) {
    const current = this.reload(previous)
    if (current.status !== 'authenticated') throw new ArtiumError('TOKEN_INVALID')
    if (current.accessToken !== previous.accessToken) return current
    const result = loginResponseSchema.safeParse(await this.request('/v1/auth/refresh', 'POST', { refreshToken: current.refreshToken }))
    if (!result.success || result.data.status !== 'authenticated') throw new ArtiumError('INVALID_RESPONSE')
    return this.sessions.write(result.data, previous.loginGeneration) as Extract<StoredSession, { status: 'authenticated' }>
  }

  private reload(previous: StoredSession) {
    const current = this.sessions.read()
    if (!current || current.loginGeneration !== previous.loginGeneration) throw new ArtiumError('SESSION_CHANGED')
    return current
  }

  async changePassword(readPasswords: (session: StoredSession) => Promise<{ newPassword: string, currentPassword?: string }>) {
    const previous = this.sessions.read()
    if (!previous) throw new ArtiumError('TOKEN_INVALID')
    const input = await readPasswords(previous)
    await this.sessions.locked(async () => {
      const session = this.reload(previous)
      const token = session.status === 'authenticated' ? session.accessToken : session.passwordChangeToken
      try { await this.request('/v1/auth/password', 'POST', input, token) }
      catch (error) {
        if (session.status !== 'authenticated' || !(error instanceof ArtiumError) || error.code !== 'TOKEN_EXPIRED') throw error
        const fresh = await this.refresh(session)
        await this.request('/v1/auth/password', 'POST', input, fresh.accessToken)
      }
      this.sessions.remove()
    })
  }
}
