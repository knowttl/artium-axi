import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import Fastify from 'fastify'
import { ZodError } from 'zod'
import type Database from 'better-sqlite3'
import type { FastifyError } from 'fastify'
import { certificateDetailsSchema, certificateInspectionSchema, inputLimits, passwordChangeSchema, toolSchema, toolsResponseSchema, toolAllowsWrites } from '../shared/api.js'
import { ArtiumError, errorResponse, errors } from '../shared/errors.js'
import type { Adapter } from './adapters/types.js'
import { loadCredentialProfile } from './adapters/credential-profile.js'
import type { CredentialProfile } from './adapters/credential-profile.js'
import type { ToolName } from './store/credential-store.js'
import type { Audit } from './audit/audit.js'
import { checkAuthSettings } from './auth/settings.js'
import { LocalAuthProvider, localAuthenticationMethod } from './auth/local.js'
import { hashToken, issueLoginTokens, issueRecentAuthTicket, logout, refreshTokens, verifyAccessToken, verifyPasswordToken } from './auth/tokens.js'
import { loginSchema, reauthSchema, refreshSchema } from '../shared/api.js'
import { AuthAttempts } from './auth/attempts.js'
import { browserCookie, browserPage, registerBrowser } from './auth/browser.js'
import { readBrowserSession, type BrowserSession } from './auth/sessions.js'
import { registerAdmin } from './admin/api.js'
import { registerUsersPage } from './admin/users.js'
import { registerRolesPages } from './admin/roles.js'
import { registerAdminPages } from './admin/pages.js'
import { registerAuditPage } from './admin/audit.js'
import { escape } from './admin/escape.js'
import type { IdentityResolver } from './policy/identity-resolver.js'
import { checkToolPolicy } from './policy/policy.js'
import { runTool } from './runner/run.js'
import type { Runner } from './runner/runner.js'
import type { MutableCredentialStore } from './store/credential-store.js'
import { isAwxOriginOnly } from './store/credential-store.js'
import { ToolHealth } from './health/health.js'
import { acceptsCliVersion, cliVersion } from '../shared/version.js'
import { toolManifests } from '../shared/tool-manifests.js'
import { registerCliDownload } from './cli-download.js'
import type { ProviderCredentials } from './store/provider-credentials.js'
import { registerSso, type SsoFetch } from './auth/sso.js'
import { registerDevice } from './auth/device.js'
import { loadToolSkill } from './tool-skills.js'

export function createApp(options: {
  db: Database.Database, audit: Audit, runner: Runner, resolver: IdentityResolver,
  adapters: readonly Adapter<unknown>[], environment?: NodeJS.ProcessEnv,
  credentialStore?: MutableCredentialStore,
  providerCredentials?: ProviderCredentials,
  ssoFetch?: SsoFetch,
}) {
  const { db, audit, runner, resolver, adapters, environment = process.env } = options
  const credentialProfiles: Partial<Record<ToolName, CredentialProfile>> = Object.fromEntries(toolSchema.options.flatMap(tool => {
    const adapter = adapters.find(adapter => adapter.name === tool)
    // The az broker edits its source identity separately from the tool's minted-token profile.
    const profile = adapter ? adapter.credentialProfile : tool === 'az-axi' ? undefined : loadCredentialProfile(tool)
    return profile ? [[tool, profile]] : []
  }))
  checkAuthSettings(environment)
  const proxies = (environment.ARTIUM_AXI_TRUSTED_PROXIES ?? '').split(',').map(value => value.trim()).filter(Boolean)
  if (proxies.some(address => !isIP(address))) throw new Error('Trusted proxies must be explicit IP addresses')
  const authenticate = verifyAccessToken
  const localAuth = new LocalAuthProvider(db)
  const authAttempts = new AuthAttempts(db, audit)
  audit.recoverInterrupted()
  const app = Fastify({ bodyLimit: inputLimits.requestBytes, logger: false,
    genReqId: () => randomUUID(), requestIdHeader: false,
    trustProxy: address => proxies.includes(address) })
  const bearer = (authorization: string | undefined) => /^Bearer ([^\s]+)$/.exec(authorization ?? '')?.[1] ?? ''
  const browser = registerBrowser(app, db, audit, authAttempts, (session, origin) => sso.endSession(session, origin))
  const device = registerDevice(app, db, audit)
  const sso = registerSso(app, db, audit, options.providerCredentials, options.ssoFetch, device)
  const health = new ToolHealth(db, audit, runner, adapters, options.credentialStore)
  app.addHook('onReady', async () => { health.start() })
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const failure = error instanceof ArtiumError ? error
      : error.code?.startsWith('FST_CSRF_') ? new ArtiumError('CSRF_INVALID')
      : new ArtiumError(error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? 'INVALID_INPUT' : 'INTERNAL_ERROR')
    if (failure.code === 'INTERNAL_ERROR') {
      // Only fixed class and schema names enter diagnostics, never error messages or dynamic keys.
      const errorClass = error instanceof ZodError ? 'ZodError' : error instanceof ArtiumError ? 'ArtiumError'
        : [TypeError, RangeError, SyntaxError, ReferenceError, URIError, EvalError, AggregateError]
          .find(type => error instanceof type)?.name ?? 'Error'
      const fields = new Set([...Object.keys(certificateDetailsSchema.shape), ...Object.keys(certificateInspectionSchema.shape)])
      const validationFields = error instanceof ZodError
        ? [...new Set(error.issues.flatMap(issue => {
          const field = issue.path.at(-1)
          return typeof field === 'string' && fields.has(field) ? [field] : []
        }))] : undefined
      process.stderr.write(JSON.stringify({ requestId: request.id, errorClass,
        route: request.routeOptions.url ?? '(unmatched)', ...(validationFields ? { validationFields } : {}) }) + '\n')
    }
    if (browser.isBrowser(request)) {
      if (failure.code === 'REAUTH_REQUIRED' && !(request.url.startsWith('/v1/') && request.headers.accept === 'application/json')) return reply.redirect('/reauth', 303)
      if (failure.code === 'PASSWORD_CHANGE_REQUIRED') return reply.redirect('/password', 303)
      if (['TOKEN_INVALID', 'TOKEN_EXPIRED', 'USER_DISABLED'].includes(failure.code) && !request.url.startsWith('/auth/sso/')) {
        return reply.clearCookie(browserCookie, { path: '/' }).redirect('/login', 303)
      }
      reply.code(errors[failure.code].status)
      if (request.url.startsWith('/v1/')) return reply.send(errorResponse(failure, request.id))
      let current: BrowserSession | undefined
      if (request.cookies[browserCookie]) {
        try { current = readBrowserSession(db, request.cookies[browserCookie]!) }
        catch (error) { if (!(error instanceof ArtiumError)) throw error }
      }
      return browserPage(reply, 'Request failed', `<p>${escape(errors[failure.code].message)}</p><p>${escape(errors[failure.code].next)}</p><p><small>${escape(failure.code)}</small></p><p><a href="/login">Sign in</a> | <a href="/account">Account</a></p>`, current)
    }
    reply.code(errors[failure.code].status).send(errorResponse(failure, request.id))
  })
  app.setNotFoundHandler(() => { throw new ArtiumError('NOT_FOUND') })
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0]
    const login = path === '/v1/auth/login' || path === '/v1/auth/device' || path === '/v1/auth/device/poll'
    if (login) reply.header('X-Artium-Cli-Version', cliVersion)
    const version = request.headers['x-artium-cli-version']
    if (path.startsWith('/v1/') && !login && version !== undefined &&
      !browser.isBrowser(request) && (typeof version !== 'string' || !acceptsCliVersion(version))) {
      throw new ArtiumError('CLI_OUTDATED')
    }
    if (!proxies.includes(request.socket.remoteAddress ?? '') &&
      Object.keys(request.headers).some(name => name === 'forwarded' || name.startsWith('x-forwarded-'))) {
      throw new ArtiumError('PROXY_HEADERS_UNTRUSTED')
    }
  })
  app.get('/health/live', async () => ({ status: 'ok' }))
  registerCliDownload(app)
  app.get('/health/ready', async (_request, reply) => {
    try { db.prepare('SELECT version FROM migrations').all(); return { status: 'ok' } }
    catch { return reply.code(503).send({ status: 'unavailable' }) }
  })
  const grantedAdapters = (authorization: string | undefined) => {
    const userId = authenticate(db, bearer(authorization))
    return adapters.filter(adapter => {
      try { checkToolPolicy(db, userId, adapter.name) }
      catch (error) {
        if (error instanceof ArtiumError && ['TOOL_DISABLED', 'TOOL_NOT_GRANTED'].includes(error.code)) return false
        throw error
      }
      return true
    })
  }
  app.get('/v1/tools', async request => {
    const tools = grantedAdapters(request.headers.authorization).map(adapter => {
      const row = db.prepare(`SELECT native_settings AS nativeSettings, EXISTS(SELECT 1 FROM credentials WHERE tool = tools.name) AS configured,
        (SELECT status FROM tool_health JOIN credentials ON credentials.tool = tool_health.tool
          AND credentials.revision = tool_health.credential_revision WHERE tool_health.tool = tools.name) AS health
        FROM tools WHERE name = ?`).get(adapter.name) as { nativeSettings: string, configured: number, health: 'ok' | 'error' | null }
      const reference = adapter.name === 'awx-axi' ? options.credentialStore?.findCredential(adapter.name) : undefined
      const configured = Boolean(row.configured) && !(reference && isAwxOriginOnly(adapter.name, options.credentialStore!.readCredential(reference)))
      return { name: adapter.name, version: toolManifests[adapter.name].version,
        readOnly: !toolAllowsWrites(adapter.name, JSON.parse(row.nativeSettings)), status: configured ? row.health ?? 'unknown' : 'unconfigured' }
    })
    return toolsResponseSchema.parse({ tools })
  })
  app.get('/v1/skills', async (request, reply) => {
    const userId = authenticate(db, bearer(request.headers.authorization))
    const granted = db.prepare(`SELECT DISTINCT role_tools.tool AS name FROM user_roles
      JOIN role_tools ON role_tools.role_id = user_roles.role_id
      WHERE user_roles.user_id = ? ORDER BY role_tools.tool`).all(userId) as { name: ToolName }[]
    reply.header('cache-control', 'no-store')
    return { skills: granted.map(tool => ({ name: tool.name, content: loadToolSkill(tool.name) })) }
  })
  app.get('/v1/me', async request => {
    const token = bearer(request.headers.authorization)
    const userId = authenticate(db, token)
    const user = db.prepare('SELECT username, display_name, administrator FROM users WHERE id = ?').get(userId) as
      { username: string, display_name: string, administrator: number }
    const roles = db.prepare('SELECT DISTINCT name FROM roles JOIN user_roles ON roles.id = user_roles.role_id WHERE user_roles.user_id = ? ORDER BY name')
      .all(userId) as { name: string }[]
    const expiry = db.prepare('SELECT expires_at FROM tokens WHERE hash = ?').get(hashToken(token)) as { expires_at: number }
    return { username: user.username, displayName: user.display_name, administrator: Boolean(user.administrator),
      roles: roles.map(role => role.name), accessExpiresAt: expiry.expires_at }
  })
  app.post('/v1/auth/login', async request => {
    const input = loginSchema.safeParse(request.body)
    if (!input.success) throw new ArtiumError('INVALID_INPUT')
    let identity: Awaited<ReturnType<LocalAuthProvider['signIn']>>
    try { identity = await authAttempts.signIn(input.data.username, input.data.password,
      { requestId: request.id, clientAddress: request.ip }) }
    catch (error) {
      if (error instanceof ArtiumError && error.code === 'SIGN_IN_FAILED') {
        audit.record({ event: 'sign-in', userId: null, tool: null, outcome: 'SIGN_IN_FAILED',
          requestId: request.id, clientAddress: request.ip })
      }
      throw error
    }
    return audit.change({ event: 'sign-in', userId: identity.userId, tool: null, outcome: 'success',
      authenticationMethod: localAuthenticationMethod(db, identity.userId),
      requestId: request.id, clientAddress: request.ip }, () => issueLoginTokens(db, identity.userId)).value
  })
  app.post('/v1/auth/reauth', async (request, reply) => {
    if (!request.headers.authorization && request.cookies[browserCookie]) {
      const until = await browser.reauthenticate(request)
      return reply.header('x-artium-reauth-until', until).code(204).send()
    }
    const token = bearer(request.headers.authorization)
    const userId = authenticate(db, token)
    const user = db.prepare('SELECT username, source FROM users WHERE id = ?').get(userId) as { username: string, source: string }
    if (user.source === 'sso') {
      reply.header('cache-control', 'no-store')
      return device.reauthenticate(request, token, userId)
    }
    const input = reauthSchema.safeParse(request.body)
    if (!input.success) throw new ArtiumError('INVALID_INPUT')
    await authAttempts.signIn(user.username, input.data.password, { requestId: request.id, clientAddress: request.ip })
    return audit.change({ event: 'reauth', userId, tool: null, outcome: 'success',
      authenticationMethod: localAuthenticationMethod(db, userId),
      requestId: request.id, clientAddress: request.ip }, () => issueRecentAuthTicket(db, token)).value
  })
  app.post('/v1/auth/refresh', async request => {
    const input = refreshSchema.safeParse(request.body)
    if (!input.success) throw new ArtiumError('INVALID_INPUT')
    return refreshTokens(db, input.data.refreshToken, audit, { requestId: request.id, clientAddress: request.ip })
  })
  app.post('/v1/auth/logout', async (request, reply) => {
    logout(db, bearer(request.headers.authorization), audit, { requestId: request.id, clientAddress: request.ip })
    return reply.code(204).send()
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
  registerAdmin(app, db, audit, authAttempts, { adapters, runner, store: options.credentialStore, health, credentialProfiles }, options.providerCredentials)
  registerUsersPage(app, db)
  registerRolesPages(app, db)
  registerAdminPages(app, db, credentialProfiles, runner.trustedCertificates)
  registerAuditPage(app, db)
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
  app.addHook('preClose', async () => { await runner.shutdown(); await health.stop() })
  return app
}
