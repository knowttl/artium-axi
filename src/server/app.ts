import { createHash, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import Fastify from 'fastify'
import { z, ZodError } from 'zod'
import type Database from 'better-sqlite3'
import type { FastifyError } from 'fastify'
import { certificateDetailsSchema, certificateInspectionSchema, createDelegationSchema, delegatedExchangeSchema, inputLimits, passwordChangeSchema, runRequestSchema, toolSchema, toolsResponseSchema, toolAllowsWrites } from '../shared/api.js'
import { ArtiumError, cliOutdatedUpdateNext, errorResponse, errors } from '../shared/errors.js'
import type { Adapter } from './adapters/types.js'
import { loadCredentialProfile } from './adapters/credential-profile.js'
import type { CredentialProfile } from './adapters/credential-profile.js'
import type { ToolName } from './store/credential-store.js'
import type { Audit } from './audit/audit.js'
import { checkAuthSettings } from './auth/settings.js'
import { LocalAuthProvider, localAuthenticationMethod } from './auth/local.js'
import { exchangeDelegation, hashToken, issueLoginTokens, issueRecentAuthTicket, logout, refreshTokens, requireRecentAuth, verifyAccessToken, verifyPasswordToken, verifyPrincipal } from './auth/tokens.js'
import { createDelegation, delegatedDiscovery, delegationIncludesTool, revokeDelegation } from './auth/delegations.js'
import { kubernetesBinding } from './policy/kubernetes.js'
import { ProxmoxAccess, proxmoxTrust } from './runner/proxmox.js'
import { registerProxmoxStreams } from './proxmox-streams.js'
import type { ProxmoxAdapter } from './adapters/proxmox.js'
import { loginSchema, reauthSchema, refreshSchema } from '../shared/api.js'
import { AuthAttempts, AuthRateLimits } from './auth/attempts.js'
import { browserCookie, browserPage, registerBrowser } from './auth/browser.js'
import { readBrowserSession, recentBrowserAuth, type BrowserSession } from './auth/sessions.js'
import { registerAdmin } from './admin/api.js'
import { registerOverviewPage } from './admin/overview.js'
import { registerUsersPage } from './admin/users.js'
import { registerRolesPages } from './admin/roles.js'
import { registerAdminPages } from './admin/pages.js'
import { registerAuditPage } from './admin/audit.js'
import { registerTokenPage } from './admin/delegated-tokens.js'
import { escape } from './admin/escape.js'
import { copyValue } from './admin/design/ui.js'
import type { IdentityResolver } from './policy/identity-resolver.js'
import { checkToolPolicy } from './policy/policy.js'
import { runTool } from './runner/run.js'
import type { Runner } from './runner/runner.js'
import type { MutableCredentialStore } from './store/credential-store.js'
import { isAwxOriginOnly } from './store/credential-store.js'
import { ToolHealth } from './health/health.js'
import { acceptsCliVersion, cliVersion, hasCliUpdateCommand } from '../shared/version.js'
import { log } from './log.js'
import { toolManifests } from '../shared/tool-manifests.js'
import { registerCliDownload } from './cli-download.js'
import type { ProviderCredentials } from './store/provider-credentials.js'
import { registerSso, type SsoFetch } from './auth/sso.js'
import { registerDevice } from './auth/device.js'
import { loadToolSkill } from './tool-skills.js'
import { registerTransfers } from './transfer-routes.js'
import type { ArtifactStore } from './artifacts.js'
import { errorDiagnostic } from './error-diagnostic.js'
import { RunnerError } from './runner/runner.js'
import { ProtectedResults } from './protected-results.js'
import { hasSshConfiguration, type SshHosts } from './store/ssh-hosts.js'
import { registerSshExecutions, type SshExecutionOptions } from './ssh-executions.js'
import { registerKubernetesWorkspaces } from './kubernetes-workspaces.js'
import { registerKubernetesSessions } from './kubernetes-sessions.js'

export function createApp(options: {
  db: Database.Database, audit: Audit, runner: Runner, resolver: IdentityResolver,
  adapters: readonly Adapter<unknown>[], environment?: NodeJS.ProcessEnv,
  credentialStore?: MutableCredentialStore,
  providerCredentials?: ProviderCredentials,
  sshHosts?: SshHosts,
  sshExecution?: SshExecutionOptions,
  ssoFetch?: SsoFetch,
  artifactStore?: ArtifactStore,
  onRoute?: (method: string | string[], url: string) => void,
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
  const protectedResults = new ProtectedResults()
  const delegatedReads = new Map<AbortController, string>()
  const proxmox = new ProxmoxAccess(db, resolver, runner, protectedResults)
  const localAuth = new LocalAuthProvider(db)
  const authAttempts = new AuthAttempts(db, audit)
  const delegatedAttempts = new AuthRateLimits()
  audit.recoverInterrupted()
  const app = Fastify({ bodyLimit: inputLimits.requestBytes, logger: false,
    genReqId: () => randomUUID(), requestIdHeader: false,
    trustProxy: address => proxies.includes(address) })
  if (options.onRoute) app.addHook('onRoute', route => options.onRoute!(route.method, route.url))
  const bearer = (authorization: string | undefined) => /^Bearer ([^\s]+)$/.exec(authorization ?? '')?.[1] ?? ''
  app.addHook('onRequest', async request => {
    const token = bearer(request.headers.authorization)
    if (!token) return
    let outcome: 'success' | import('../shared/errors.js').ErrorCode = 'success'
    try { verifyPrincipal(db, token) } catch (error) { outcome = error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR' }
    const delegation = db.prepare(`SELECT delegations.id, delegations.creator_id FROM tokens
      JOIN session_families ON session_families.id = tokens.family_id
      JOIN delegations ON delegations.id = session_families.delegation_id
      WHERE tokens.hash = ? AND tokens.type = 'access'`).get(hashToken(token)) as { id: string, creator_id: string } | undefined
    if (delegation) audit.record({ event: 'delegation-access', userId: delegation.creator_id,
      delegationId: delegation.id, tool: null, requestId: request.id, clientAddress: request.ip, outcome })
  })
  const browser = registerBrowser(app, db, audit, authAttempts, (session, origin) => sso.endSession(session, origin), adapters)
  const device = registerDevice(app, db, audit)
  const sso = registerSso(app, db, audit, options.providerCredentials, options.ssoFetch, device)
  const health = new ToolHealth(db, audit, runner, adapters, options.credentialStore, proxmox)
  const reconcileProxmox = async () => { await proxmox.reconcile() }
  const proxmoxMonitor = setInterval(() => { void reconcileProxmox().catch(() => {}) }, 1000)
  proxmoxMonitor.unref()
  app.addHook('onSend', reconcileProxmox)
  app.addHook('onSend', async () => {
    for (const [controller, token] of delegatedReads) {
      try { verifyPrincipal(db, token) } catch { controller.abort() }
    }
  })
  const proxmoxAdapter = adapters.find(adapter => adapter.name === 'proxmox-axi')
  if (proxmoxAdapter && 'prepareStream' in proxmoxAdapter && 'inspectStream' in proxmoxAdapter) {
    registerProxmoxStreams(app, db, resolver, proxmoxAdapter as ProxmoxAdapter, runner, proxmox, protectedResults, audit, environment, proxies)
  }
  const kubernetes = adapters.find(adapter => adapter.name === 'kubernetes-axi')
  if (kubernetes) {
    const workspaces = registerKubernetesWorkspaces(app, db, resolver, kubernetes, audit)
    registerKubernetesSessions(app, db, resolver, kubernetes, runner, audit, workspaces, proxies)
  }
  if (kubernetes || proxmoxAdapter && 'prepareStream' in proxmoxAdapter) app.server.on('upgrade', (request, socket) => {
    const path = request.url ?? ''
    if (kubernetes && path.startsWith('/v1/tools/kubernetes-axi/sessions/')
      || proxmoxAdapter && 'prepareStream' in proxmoxAdapter && path.startsWith('/v1/tools/proxmox-axi/streams/')) return
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  })
  app.addHook('onReady', async () => { health.start() })
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const failure = error instanceof ArtiumError ? error
      : error.code?.startsWith('FST_CSRF_') ? new ArtiumError('CSRF_INVALID')
      : new ArtiumError(error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? 'INVALID_INPUT' : 'INTERNAL_ERROR')
    if (failure.code === 'INTERNAL_ERROR' || failure.code === 'SPAWN_FAILED') {
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
      log('error', 'error', { requestId: request.id, code: failure.code, errorClass,
        route: request.routeOptions.url ?? '(unmatched)', ...(validationFields ? { validationFields } : {}),
        ...errorDiagnostic(error instanceof RunnerError && error.spawnError ? error.spawnError : error) })
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
      const [href, label] = !current ? ['/login', 'Sign in'] : current.must_change ? ['/password', 'Change password'] : current.administrator ? ['/admin', 'Overview'] : ['/account', 'Your account']
      return browserPage(reply, 'Request failed', `<p>${escape(errors[failure.code].message)} ${escape(errors[failure.code].next)}</p>
        <dl class="kv"><dt>Code</dt><dd class="mono">${escape(failure.code)}</dd><dt>Request ID</dt><dd class="mono">${copyValue('request ID', request.id)}</dd></dl>
        <div class="auth-actions"><button type="button" class="btn btn-secondary" data-history-back hidden>Go back</button><a class="btn btn-primary" href="${href}">${label}</a></div>`,
      current, undefined, { layout: 'auth', mark: { icon: 'alert', tone: 'warn' } })
    }
    reply.code(errors[failure.code].status).send(errorResponse(failure, request.id))
  })
  app.setNotFoundHandler(() => { throw new ArtiumError('NOT_FOUND') })
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-artium-request-id', request.id)
    const path = request.url.split('?')[0]
    const login = path === '/v1/auth/login' || path === '/v1/auth/delegated' || path === '/v1/auth/device' || path === '/v1/auth/device/poll'
    if (login) reply.header('X-Artium-Cli-Version', cliVersion)
    const version = request.headers['x-artium-cli-version']
    if (path.startsWith('/v1/') && !login && version !== undefined &&
      !browser.isBrowser(request) && (typeof version !== 'string' || !acceptsCliVersion(version))) {
      throw hasCliUpdateCommand(version)
        ? new ArtiumError('CLI_OUTDATED', undefined, cliOutdatedUpdateNext)
        : new ArtiumError('CLI_OUTDATED')
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
  const grantedAdapters = (userId: string) => {
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
    const principal = verifyPrincipal(db, bearer(request.headers.authorization))
    const { userId, delegation } = principal
    const discovery = delegation ? delegatedDiscovery(db, userId, delegation, adapters)
      : grantedAdapters(userId).map(adapter => ({ adapter, commands: undefined, readOnly: undefined }))
    const tools = discovery.map(({ adapter, commands, readOnly }) => {
      const row = db.prepare(`SELECT native_settings AS nativeSettings, credentials.revision AS configured,
        tool_health.status AS health, tool_health.error_code AS errorCode
        FROM tools LEFT JOIN credentials ON credentials.tool = tools.name
        LEFT JOIN tool_health ON tool_health.tool = tools.name AND tool_health.credential_revision = credentials.revision
        WHERE tools.name = ?`).get(adapter.name) as { nativeSettings: string, configured: number | null, health: 'ok' | 'error' | null, errorCode: string | null }
      const reference = adapter.name === 'awx-axi' ? options.credentialStore?.findCredential(adapter.name) : undefined
      const configured = adapter.name === 'ssh-axi' ? hasSshConfiguration(db, userId)
        : Boolean(row.configured) && !(reference && isAwxOriginOnly(adapter.name, options.credentialStore!.readCredential(reference)))
      return { name: adapter.name, version: toolManifests[adapter.name].version, ...(commands ? { commands } : {}),
        readOnly: readOnly ?? !toolAllowsWrites(adapter.name, JSON.parse(row.nativeSettings)), status: configured ? adapter.name === 'ssh-axi' ? 'unknown' : row.health ?? (health.checking(adapter.name) ? 'checking' : 'unknown') : 'unconfigured',
        ...(adapter.name !== 'ssh-axi' && configured && row.health === 'error' && row.errorCode ? { errorCode: row.errorCode } : {}) }
    })
    return toolsResponseSchema.parse({ tools })
  })
  app.get('/v1/skills', async (request, reply) => {
    const { userId, delegation } = verifyPrincipal(db, bearer(request.headers.authorization))
    reply.header('cache-control', 'no-store')
    if (!delegation) {
      const granted = db.prepare(`SELECT DISTINCT role_tools.tool AS name FROM user_roles
        JOIN role_tools ON role_tools.role_id = user_roles.role_id
        WHERE user_roles.user_id = ? ORDER BY role_tools.tool`).all(userId) as { name: ToolName }[]
      return { skills: granted.map(tool => ({ name: tool.name, content: loadToolSkill(tool.name) })) }
    }
    return { skills: delegatedDiscovery(db, userId, delegation, adapters).map(({ adapter, commands }) => {
      return { name: adapter.name, content: `---\nname: ${adapter.name}\ndescription: Use permitted ${adapter.name} commands through Artium.\n---\n\n# ${adapter.name}\n\nRun each command with --help for required arguments.\n\nPermitted commands:\n${commands.map(command => `- \`artium-axi ${adapter.name} ${command}\``).join('\n')}\n` }
    }) }
  })
  app.get('/v1/me', async request => {
    const token = bearer(request.headers.authorization)
    const { userId, delegation } = verifyPrincipal(db, token)
    const user = db.prepare('SELECT username, display_name, administrator FROM users WHERE id = ?').get(userId) as
      { username: string, display_name: string, administrator: number }
    const roles = db.prepare('SELECT DISTINCT name FROM roles JOIN user_roles ON roles.id = user_roles.role_id WHERE user_roles.user_id = ? ORDER BY name')
      .all(userId) as { name: string }[]
    const expiry = db.prepare(`SELECT tokens.expires_at, session_families.expires_at AS session_expires_at FROM tokens
      JOIN session_families ON session_families.id = tokens.family_id WHERE hash = ?`).get(hashToken(token)) as
      { expires_at: number, session_expires_at: number }
    if (delegation) {
      const row = db.prepare('SELECT label FROM delegations WHERE id = ?').get(delegation.id) as { label: string }
      const discovery = delegatedDiscovery(db, userId, delegation, adapters)
      return { username: user.username, displayName: user.display_name, delegation: { label: row.label, expiresAt: delegation.expiresAt,
        scope: { tools: discovery.map(({ adapter, commands }) => ({ tool: adapter.name, commands })) } },
      accessExpiresAt: expiry.expires_at, sessionExpiresAt: expiry.session_expires_at }
    }
    return { username: user.username, displayName: user.display_name, administrator: Boolean(user.administrator),
      roles: roles.map(role => role.name), accessExpiresAt: expiry.expires_at, sessionExpiresAt: expiry.session_expires_at }
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
  app.post('/v1/auth/delegated', async (request, reply) => {
    let row: { id: string, creator_id: string } | undefined
    try {
      delegatedAttempts.admitAddress(request.ip)
      const body = delegatedExchangeSchema.safeParse(request.body)
      if (!body.success) throw new ArtiumError('INVALID_INPUT')
      row = db.prepare('SELECT id, creator_id FROM delegations WHERE token_hash = ?').get(hashToken(body.data.token)) as typeof row
      const event = { event: 'token-exchange' as const, userId: row?.creator_id ?? null, delegationId: row?.id ?? null,
        tool: null, requestId: request.id, clientAddress: request.ip }
      const result = audit.change({ ...event, outcome: 'success' }, () => exchangeDelegation(db, body.data.token)).value
      return reply.header('cache-control', 'no-store').send(result)
    } catch (error) {
      audit.record({ event: 'token-exchange', userId: row?.creator_id ?? null, delegationId: row?.id ?? null,
        tool: null, requestId: request.id, clientAddress: request.ip, outcome: error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR' })
      throw error
    }
  })
  app.post('/v1/account/tokens', async (request, reply) => {
    const token = bearer(request.headers.authorization)
    let userId: string | null = null
    try {
      if (!request.headers.authorization && request.cookies[browserCookie]) {
        const current = readBrowserSession(db, request.cookies[browserCookie]!)
        if (current.must_change) throw new ArtiumError('PASSWORD_CHANGE_REQUIRED')
        if (!recentBrowserAuth(current)) throw new ArtiumError('REAUTH_REQUIRED')
        userId = current.user_id
      } else {
        userId = authenticate(db, token)
        const ticket = request.headers['x-artium-reauth-ticket']
        requireRecentAuth(db, token, typeof ticket === 'string' ? ticket : '')
      }
      const input = createDelegationSchema.safeParse(request.body)
      if (!input.success) throw new ArtiumError('INVALID_INPUT')
      const id = randomUUID()
      const creator = userId
      const result = audit.change({ event: 'token-create', userId, delegationId: id, tool: null, targetId: id,
        requestId: request.id, clientAddress: request.ip, outcome: 'success' }, () => createDelegation(db, creator, input.data, adapters, id)).value
      return reply.header('cache-control', 'no-store').send(result)
    } catch (error) {
      audit.record({ event: 'token-create', userId, tool: null, requestId: request.id, clientAddress: request.ip,
        outcome: error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR' })
      throw error
    }
  })
  app.get('/v1/account/tokens', async request => {
    const userId = accountTokenUser(request)
    return { tokens: db.prepare(`SELECT id, label, scope_json AS scopeJson, read_only AS readOnly, single_use AS singleUse,
      created_at AS createdAt, expires_at AS expiresAt, revoked_at AS revokedAt, consumed_at AS consumedAt
      FROM delegations WHERE creator_id = ? ORDER BY created_at DESC, id`).all(userId) }
  })
  app.post<{ Params: { id: string } }>('/v1/account/tokens/:id/revoke', async (request, reply) => {
    const userId = accountTokenUser(request)
    audit.change({ event: 'token-revoke', userId, delegationId: request.params.id, tool: null, targetId: request.params.id,
      requestId: request.id, clientAddress: request.ip, outcome: 'success' },
    () => revokeDelegation(db, request.params.id, userId, false))
    return reply.code(204).send()
  })
  function accountTokenUser(request: import('fastify').FastifyRequest): string {
    if (request.headers.authorization || !request.cookies[browserCookie]) return authenticate(db, bearer(request.headers.authorization))
    const current = readBrowserSession(db, request.cookies[browserCookie]!)
    if (current.must_change) throw new ArtiumError('PASSWORD_CHANGE_REQUIRED')
    return current.user_id
  }
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
  const authorizeAdmin = registerAdmin(app, db, audit, authAttempts, { adapters, runner, store: options.credentialStore, health, credentialProfiles, sshHosts: options.sshHosts }, options.providerCredentials)
  app.patch('/v1/admin/token-settings', async request => {
    const userId = authorizeAdmin(request)
    const input = z.strictObject({ mintingEnabled: z.boolean(), maxLifetimeMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      ssoWindowMs: z.number().int().min(86400000).max(2592000000).optional() }).safeParse(request.body)
    if (!input.success) throw new ArtiumError('INVALID_INPUT')
    if (input.data.mintingEnabled) throw new ArtiumError('DELEGATED_SCOPE_DENIED', 'Token creation is not available yet in this build.', 'Minting becomes available in slice 8.')
    audit.change({ event: 'admin-change', action: 'token-settings', targetId: 'delegation-settings', userId, tool: null,
      requestId: request.id, clientAddress: request.ip, outcome: 'success' }, () => {
      db.prepare('UPDATE delegation_settings SET minting_enabled = 0, max_lifetime_ms = ?, sso_window_ms = coalesce(?, sso_window_ms) WHERE id = 1')
        .run(input.data.maxLifetimeMs, input.data.ssoWindowMs ?? null)
    })
    return { saved: true }
  })
  app.get('/v1/admin/tokens', async request => {
    authorizeAdmin(request)
    return { tokens: db.prepare(`SELECT id, creator_id AS creatorId, label, scope_json AS scopeJson, read_only AS readOnly,
      single_use AS singleUse, created_at AS createdAt, expires_at AS expiresAt, revoked_at AS revokedAt, consumed_at AS consumedAt
      FROM delegations ORDER BY created_at DESC, id`).all() }
  })
  app.post<{ Params: { id: string } }>('/v1/admin/tokens/:id/revoke', async (request, reply) => {
    const userId = authorizeAdmin(request)
    audit.change({ event: 'token-revoke', userId, delegationId: request.params.id, tool: null, targetId: request.params.id,
      requestId: request.id, clientAddress: request.ip, outcome: 'success' },
    () => revokeDelegation(db, request.params.id, userId, true))
    return reply.code(204).send()
  })
  app.post('/v1/admin/tokens/revoke-all', async (request, reply) => {
    const userId = authorizeAdmin(request)
    const rows = db.prepare('SELECT id FROM delegations WHERE revoked_at IS NULL').all() as { id: string }[]
    if (rows.length) audit.change(rows.map(({ id }) => ({ event: 'token-revoke' as const, userId, delegationId: id,
      tool: null, targetId: id, requestId: request.id, clientAddress: request.ip, outcome: 'success' as const })),
    () => { for (const row of rows) revokeDelegation(db, row.id, userId, true) })
    return reply.code(204).send()
  })
  if (options.sshHosts && options.sshExecution) registerSshExecutions(app, { ...options.sshExecution,
    db, hosts: options.sshHosts, runner, audit, environment, authorizeAdmin })
  registerOverviewPage(app, db)
  registerUsersPage(app, db)
  registerRolesPages(app, db)
  registerAdminPages(app, db, credentialProfiles, runner.trustedCertificates)
  registerAuditPage(app, db, audit)
  registerTokenPage(app, db)
  registerTransfers(app, db, audit, runner, resolver, adapters, options.artifactStore)
  for (const tool of ['technitium-axi', 'awx-axi', 'kubernetes-axi', 'proxmox-axi'] as const) app.get<{ Params: { operation: string, id: string } }>(`/v1/results/${tool}/:operation/:id`, async (request, reply) => {
    if (tool === 'awx-axi' && !['token-create', 'stdout-download'].includes(request.params.operation)) throw new ArtiumError('NOT_FOUND')
    if (tool === 'kubernetes-axi' && request.params.operation !== 'token-create') throw new ArtiumError('NOT_FOUND')
    const token = bearer(request.headers.authorization)
    const principal = verifyPrincipal(db, token)
    const { userId, delegation, familyId } = principal
    if (delegation && !delegationIncludesTool(delegation.scopeJson, tool)) throw new ArtiumError('DELEGATED_SCOPE_DENIED')
    checkToolPolicy(db, userId, tool)
    const credential = await resolver.resolve(userId, tool)
    verifyPrincipal(db, token)
    checkToolPolicy(db, userId, tool)
    if (tool === 'kubernetes-axi') {
      const { settings } = kubernetesBinding(db, { user: userId, family: familyId })
      if (settings.allowWrites !== true || settings.acquireCredential !== true) throw new ArtiumError('FLAG_BLOCKED')
    }
    const bytes = protectedResults.take(request.params.id, { userId, credential, operation: request.params.operation,
      ...(delegation || ['kubernetes-axi', 'proxmox-axi'].includes(tool) ? { familyId, familyOnly: !!delegation } : {}),
      ...(tool === 'proxmox-axi' ? { trustRevision: proxmoxTrust(db, credential) } : {}) })
    return reply.header('cache-control', 'no-store').header('content-disposition', 'attachment; filename="result.bin"')
      .header('x-content-type-options', 'nosniff').header('x-artium-content-sha256', createHash('sha256').update(bytes).digest('hex'))
      .type('application/octet-stream').send(bytes)
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
    let expiry: NodeJS.Timeout | undefined
    try {
      const token = bearer(request.headers.authorization)
      const principal = verifyPrincipal(db, token)
      const input = runRequestSchema.safeParse(request.body)
      if (principal.delegation && input.success && adapter.classify(input.data.args, input.data).effect === 'read') {
        delegatedReads.set(controller, token)
        expiry = setTimeout(() => controller.abort(), Math.min(2_147_483_647, Math.max(0, principal.delegation.expiresAt - Date.now())))
        expiry.unref()
      }
    } catch { /* The run path records authentication and validation failures. */ }
    try {
      const result = await runTool(db, audit, runner, bearer(request.headers.authorization), request.body,
        adapter, resolver, { requestId: request.id, clientAddress: request.ip, signal: controller.signal, protectedResults, proxmox }, authenticate)
      const { stdout, stderr, exitCode, durationMs, outputBytes, truncated } = result
      return { source: adapter.name, stdout, stderr, exitCode, durationMs, outputBytes, truncated }
    } finally { reply.raw.off('close', disconnect); delegatedReads.delete(controller); clearTimeout(expiry) }
  })
  app.addHook('preClose', async () => {
    clearInterval(proxmoxMonitor)
    await proxmox.close(); await runner.shutdown(); await health.stop(); protectedResults.clear()
  })
  return app
}
