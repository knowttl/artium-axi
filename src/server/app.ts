import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import Fastify from 'fastify'
import type Database from 'better-sqlite3'
import type { FastifyError } from 'fastify'
import { inputLimits, passwordChangeSchema, toolSchema, toolsResponseSchema } from '../shared/api.js'
import { ArtiumError, errorResponse, errors } from '../shared/errors.js'
import type { Adapter } from './adapters/types.js'
import type { Audit } from './audit/audit.js'
import { checkAuthSettings } from './auth/settings.js'
import { LocalAuthProvider } from './auth/local.js'
import { issueLoginTokens, verifyAccessToken, verifyPasswordToken } from './auth/tokens.js'
import { loginSchema } from '../shared/api.js'
import type { IdentityResolver } from './policy/identity-resolver.js'
import { checkToolPolicy } from './policy/policy.js'
import { runTool } from './runner/run.js'
import type { Runner } from './runner/runner.js'

export function createApp(options: {
  db: Database.Database, audit: Audit, runner: Runner, resolver: IdentityResolver,
  adapters: readonly Adapter<unknown>[], environment?: NodeJS.ProcessEnv,
}) {
  const { db, audit, runner, resolver, adapters, environment = process.env } = options
  checkAuthSettings(environment)
  const proxies = (environment.ARTIUM_AXI_TRUSTED_PROXIES ?? '').split(',').map(value => value.trim()).filter(Boolean)
  if (proxies.some(address => !isIP(address))) throw new Error('Trusted proxies must be explicit IP addresses')
  const authenticate = verifyAccessToken
  const localAuth = new LocalAuthProvider(db)
  audit.recoverInterrupted()
  const app = Fastify({ bodyLimit: inputLimits.requestBytes, logger: false,
    genReqId: () => randomUUID(), requestIdHeader: false,
    trustProxy: address => proxies.includes(address) })
  const bearer = (authorization: string | undefined) => /^Bearer ([^\s]+)$/.exec(authorization ?? '')?.[1] ?? ''
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const failure = error instanceof ArtiumError ? error
      : new ArtiumError(error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? 'INVALID_INPUT' : 'INTERNAL_ERROR')
    reply.code(errors[failure.code].status).send(errorResponse(failure, request.id))
  })
  app.setNotFoundHandler(() => { throw new ArtiumError('NOT_FOUND') })
  app.addHook('onRequest', async request => {
    if (!proxies.includes(request.socket.remoteAddress ?? '') &&
      Object.keys(request.headers).some(name => name === 'forwarded' || name.startsWith('x-forwarded-'))) {
      throw new ArtiumError('PROXY_HEADERS_UNTRUSTED')
    }
  })
  app.get('/health/live', async () => ({ status: 'ok' }))
  app.get('/health/ready', async (_request, reply) => {
    try { db.prepare('SELECT version FROM migrations').all(); return { status: 'ok' } }
    catch { return reply.code(503).send({ status: 'unavailable' }) }
  })
  app.get('/v1/tools', async request => {
    const userId = authenticate(db, bearer(request.headers.authorization))
    const tools = adapters.flatMap(adapter => {
      try { checkToolPolicy(db, userId, adapter.name) }
      catch (error) {
        if (error instanceof ArtiumError && ['TOOL_DISABLED', 'TOOL_NOT_GRANTED'].includes(error.code)) return []
        throw error
      }
      const row = db.prepare(`SELECT pinned_version AS version,
        EXISTS(SELECT 1 FROM credentials WHERE tool = tools.name) AS configured FROM tools WHERE name = ?`)
        .get(adapter.name) as { version: string, configured: number }
      return [{ name: adapter.name, version: row.version, status: row.configured ? 'unknown' : 'unconfigured' }]
    })
    return toolsResponseSchema.parse({ tools })
  })
  app.post('/v1/auth/login', async request => {
    const input = loginSchema.safeParse(request.body)
    if (!input.success) throw new ArtiumError('INVALID_INPUT')
    let identity: Awaited<ReturnType<LocalAuthProvider['signIn']>>
    try { identity = await localAuth.signIn(input.data.username, input.data.password) }
    catch (error) {
      if (error instanceof ArtiumError && error.code === 'SIGN_IN_FAILED') {
        audit.record({ event: 'sign-in', userId: null, tool: null, outcome: 'SIGN_IN_FAILED',
          requestId: request.id, clientAddress: request.ip })
      }
      throw error
    }
    return audit.change({ event: 'sign-in', userId: identity.userId, tool: null, outcome: 'success',
      requestId: request.id, clientAddress: request.ip }, () => issueLoginTokens(db, identity.userId)).value
  })
  app.post('/v1/auth/password', async (request, reply) => {
    const token = bearer(request.headers.authorization)
    const { user_id: userId } = verifyPasswordToken(db, token)
    const input = passwordChangeSchema.safeParse(request.body)
    if (!input.success) throw new ArtiumError('INVALID_INPUT')
    await localAuth.changePassword(userId, input.data.currentPassword, input.data.newPassword, audit,
      { requestId: request.id, clientAddress: request.ip }, Date.now(), token)
    return reply.code(204).send()
  })
  app.post<{ Params: { tool: string } }>('/v1/tools/:tool/run', async (request, reply) => {
    const name = toolSchema.safeParse(request.params.tool)
    if (!name.success) throw new ArtiumError('INVALID_INPUT')
    const adapter = adapters.find(adapter => adapter.name === name.data)
    if (!adapter) {
      let userId: string | null = null
      try {
        userId = authenticate(db, bearer(request.headers.authorization))
        checkToolPolicy(db, userId, name.data)
        throw new ArtiumError('TOOL_DISABLED')
      } catch (error) {
        audit.record({ event: 'denial', userId, tool: name.data, requestId: request.id,
          clientAddress: request.ip, outcome: error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR' })
        throw error
      }
    }
    const controller = new AbortController()
    const disconnect = () => { if (!reply.raw.writableFinished) controller.abort() }
    reply.raw.once('close', disconnect)
    try {
      const result = await runTool(db, audit, runner, bearer(request.headers.authorization), request.body,
        adapter, resolver, { requestId: request.id, clientAddress: request.ip, signal: controller.signal }, authenticate)
      const { stdout, stderr, exitCode, durationMs, outputBytes, truncated } = result
      return { source: adapter.name, stdout, stderr, exitCode, durationMs, outputBytes, truncated }
    } finally { reply.raw.off('close', disconnect) }
  })
  app.addHook('preClose', async () => { await runner.shutdown() })
  return app
}
