import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { rootCertificates } from 'node:tls'
import { resolve } from 'node:path'
import type { TLSSocket } from 'node:tls'
import type { IncomingMessage } from 'node:http'
import { errorResponseSchema, loginResponseSchema } from '../shared/api.js'
import { ArtiumError } from '../shared/errors.js'
import { cliVersion } from '../shared/version.js'
import { SessionStore, sessionPath, readClientConfig } from './session.js'
import type { StoredSession } from './session.js'
import type { ManagedSession } from './managed-session.js'

export const DEFAULT_REQUEST_DEADLINE_MS = 90_000

export class Client {
  private readonly cancellation = new AbortController()
  cancel() { this.cancellation.abort() }
  readonly serverUrl: string
  readonly serverUrlSource: 'ARTIUM_AXI_URL' | 'config.json'
  readonly caFile?: string
  private readonly storedSessions?: SessionStore
  get sessions(): SessionStore {
    if (!this.storedSessions) throw new ArtiumError('INVALID_INPUT', 'Session-file operations are unavailable in managed mode.')
    return this.storedSessions
  }
  certificateVerified = false
  constructor(environment = process.env, private readonly managed?: ManagedSession,
    private readonly requestDeadlineMs = DEFAULT_REQUEST_DEADLINE_MS) {
    try {
      const config = !managed && (environment.ARTIUM_AXI_URL === undefined || environment.ARTIUM_AXI_CA_FILE === undefined)
        ? readClientConfig(environment) : undefined
      this.serverUrlSource = environment.ARTIUM_AXI_URL === undefined ? 'config.json' : 'ARTIUM_AXI_URL'
      const caFile = environment.ARTIUM_AXI_CA_FILE ?? config?.caFile
      this.caFile = caFile ? resolve(caFile) : undefined
      const url = new URL(environment.ARTIUM_AXI_URL ?? config?.serverUrl ?? '')
      if (url.username || url.password || url.href.includes('?') || url.href.includes('#') ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && environment.ARTIUM_AXI_TEST_HTTP === '1' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error()
      this.serverUrl = url.href.replace(/\/$/, '')
      if (!managed) this.storedSessions = new SessionStore(this.serverUrl, sessionPath(process.platform, environment))
    } catch (error) {
      if (error instanceof ArtiumError) throw error
      throw new ArtiumError('CLIENT_CONFIG_INVALID')
    }
    managed?.checkServer(this.serverUrl)
  }

  async request(path: string, method: 'GET' | 'POST', input: undefined, token: undefined, bytes: true): Promise<Buffer>
  async request(path: string, method: 'GET' | 'POST', input?: unknown, token?: string, bytes?: false, headers?: Record<string, string>): Promise<unknown>
  async request(path: string, method: 'GET' | 'POST', input?: unknown, token?: string, bytes = false, headers: Record<string, string> = {}): Promise<unknown> {
    this.certificateVerified = false
    let ca: string[] | undefined
    try { if (this.caFile) ca = [...rootCertificates, readFileSync(this.caFile, 'utf8')] }
    catch { throw new ArtiumError('CLIENT_CONFIG_INVALID') }
    const body = input === undefined ? undefined : JSON.stringify(input)
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), this.requestDeadlineMs)
    const url = new URL(`${this.serverUrl}${path}`)
    const result = await new Promise<{ status: number, body: unknown, serverVersion?: string }>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method, ca, rejectUnauthorized: true, signal: AbortSignal.any([controller.signal, this.cancellation.signal]),
        headers: { ...headers, 'x-artium-cli-version': cliVersion, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
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
          try { resolve({ status: response.statusCode!, body: bytes ? Buffer.concat(chunks) : response.statusCode === 204 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8')),
            serverVersion: typeof response.headers['x-artium-cli-version'] === 'string' ? response.headers['x-artium-cli-version'] : undefined }) }
          catch { reject(new ArtiumError('INVALID_RESPONSE')) }
        })
      })
      if (url.protocol === 'https:') request.on('socket', socket => {
        const tlsSocket = socket as TLSSocket
        this.certificateVerified = tlsSocket.authorized
        if (!tlsSocket.authorized) tlsSocket.once('secureConnect', () => { this.certificateVerified = tlsSocket.authorized })
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
    if ((path === '/v1/auth/login' || path === '/v1/auth/device') && result.serverVersion && result.serverVersion !== cliVersion) {
      const version = result.serverVersion.replace(/[\x00-\x1f\x7f]/g, '')
      const warning = `warning: CLI ${cliVersion} differs from server ${version}; run artium-axi update, or run npm install -g @knowttl/artium-axi@${version}.\n`
      if (this.managed) this.managed.write('stderr', warning)
      else process.stderr.write(warning)
    }
    return result.body
  }

  async authenticated(path: string, method: 'GET' | 'POST', input?: unknown, previous?: StoredSession): Promise<unknown> {
    if (this.managed) return this.managed.authenticated(
      token => this.request(path, method, input, token),
      refreshToken => this.request('/v1/auth/refresh', 'POST', { refreshToken }),
    )
    const session = previous ? this.reload(previous) : this.sessions.read()
    if (!session) throw new ArtiumError('TOKEN_INVALID', undefined, 'Run artium-axi login --username <username> --password-stdin.')
    if (session.status === 'password-change-required') throw new ArtiumError('PASSWORD_CHANGE_REQUIRED')
    let result: unknown
    try { result = await this.request(path, method, input, session.accessToken) }
    catch (error) {
      if (!(error instanceof ArtiumError) || error.code !== 'TOKEN_EXPIRED') throw error
      const fresh = await this.sessions.locked(() => this.refresh(session))
      result = await this.request(path, method, input, fresh.accessToken)
    }
    if (previous) this.reload(previous)
    return result
  }

  // Transfers never refresh/replay a request, including an ambiguous execute or
  // a retrieval whose response was interrupted before headers arrived.
  async transferSession<T>(work: (token: string) => Promise<T>): Promise<T> {
    if (this.managed) return this.managed.once(work)
    const session = this.sessions.read()
    if (!session) throw new ArtiumError('TOKEN_INVALID')
    if (session.status !== 'authenticated') throw new ArtiumError('PASSWORD_CHANGE_REQUIRED')
    return work(session.accessToken)
  }

  async artifact(path: string, input: unknown, token: string, ticket: string, expiresAt: number,
    consume: (response: IncomingMessage, signal: AbortSignal) => Promise<void>): Promise<void> {
    let ca: string[] | undefined
    try { if (this.caFile) ca = [...rootCertificates, readFileSync(this.caFile, 'utf8')] }
    catch { throw new ArtiumError('CLIENT_CONFIG_INVALID') }
    const url = new URL(`${this.serverUrl}${path}`)
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, this.cancellation.signal])
    const deadline = setTimeout(() => controller.abort(), Math.max(0, expiresAt - Date.now()))
    try {
      await new Promise<void>((resolve, reject) => {
        let incoming: IncomingMessage | undefined
        const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
          method: 'POST', ca, rejectUnauthorized: true, signal,
          headers: { authorization: `Bearer ${token}`, 'x-artium-cli-version': cliVersion,
            'x-artium-reauth-ticket': ticket, 'accept-encoding': 'identity', 'content-type': 'application/json' },
        }, response => {
          incoming = response
          void (async () => {
            if (response.statusCode !== 200) {
              const chunks: Buffer[] = []
              let size = 0
              for await (const chunk of response) {
                size += chunk.length
                if (size > 64 * 1024) throw new ArtiumError('INVALID_RESPONSE')
                chunks.push(chunk)
              }
              const failure = errorResponseSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
              if (failure.success) throw new ArtiumError(failure.data.error.code, failure.data.error.message, failure.data.error.next)
              throw new ArtiumError('INVALID_RESPONSE')
            }
            await consume(response, signal)
          })().then(resolve, reject).finally(() => response.destroy())
        })
        request.on('error', () => {
          const error = new ArtiumError('SERVER_UNAVAILABLE')
          // Once saving has started, wait for its own rejection and cleanup
          // boundary rather than racing an in-flight file operation.
          if (incoming) incoming.destroy(error)
          else reject(error)
        })
        request.end(JSON.stringify(input))
      })
    } finally { clearTimeout(deadline) }
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
