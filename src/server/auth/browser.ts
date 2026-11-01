import cookie from '@fastify/cookie'
import csrf from '@fastify/csrf-protection'
import formbody from '@fastify/formbody'
import { z } from 'zod'
import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { accountSessionRoutes, loginSchema, passwordChangeSchema, reauthSchema, sessionParamsSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import type { Audit } from '../audit/audit.js'
import type { AuthAttempts } from './attempts.js'
import { LocalAuthProvider, localAuthenticationMethod } from './local.js'
import { browserIdentity, createBrowserSession, readBrowserSession, recentBrowserAuth, type BrowserSession } from './sessions.js'
import { escape } from '../admin/escape.js'
import { pageHelp } from '../admin/forms.js'
import { appShell, callout, icon, type PageOptions } from '../admin/design/ui.js'
import { authDefaults } from '../config.js'
import { listUserSessions, revokeUserSession } from './user-sessions.js'
import { revokeUserSessions } from './tokens.js'
import { accountContent, accountRoles } from '../admin/account.js'

export const browserCookie = 'artium-session'
export const cookieOptions = { path: '/', secure: true, httpOnly: true, sameSite: 'strict' } as const
const pages = ['/login', '/logout', '/password', '/reauth', '/device', '/admin', '/account']

export function browserPage(reply: FastifyReply, title: string, content: string, current?: BrowserSession, description?: string,
  options: PageOptions & { helpTopic?: string } = {}) {
  const viewer = current && {
    name: current.display_name,
    method: current.source === 'sso' ? 'SSO' : current.break_glass ? 'Break-glass' : 'Password',
    administrator: Boolean(current.administrator),
    mustChange: Boolean(current.must_change),
    sso: current.source === 'sso',
    local: current.source === 'local',
    csrf: reply.generateCsrf(),
    reauthUntil: current.reauthenticated_at === null ? 0 : current.reauthenticated_at + authDefaults.recentAuthMs,
  }
  const { helpTopic, ...page } = options
  const body = appShell({ ...page, title, description, content, help: pageHelp(helpTopic ?? title, current?.source), path: reply.request.url.split('?')[0]!, viewer })
  return reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} - artium-axi</title><link rel="stylesheet" href="/admin/assets/style.css"><script defer src="/admin/assets/confirm.js"></script></head><body${current ? ` class="signed-in" data-session-id="${escape(current.id)}"` : ''}>${body}</body></html>`)
}

export function registerBrowser(app: FastifyInstance, db: Database.Database, audit: Audit, attempts: AuthAttempts,
  providerSignOut: (session: BrowserSession, origin: string) => Promise<string | undefined>) {
  app.register(cookie)
  app.register(formbody)
  app.register(csrf, { cookieOpts: cookieOptions })
  const provider = new LocalAuthProvider(db)
  const context = (request: FastifyRequest) => ({ requestId: request.id, clientAddress: request.ip })
  const session = (request: FastifyRequest) => readBrowserSession(db, request.cookies[browserCookie] ?? '')
  const isBrowser = (request: FastifyRequest) => request.url.startsWith('/auth/sso/') || request.url.startsWith('/admin/') || request.url.startsWith('/v1/account/') || pages.includes(request.url.split('?')[0]!) ||
    Boolean(request.cookies?.[browserCookie] && !request.headers.authorization && request.url.startsWith('/v1/'))

  app.addHook('onRequest', async (request, reply) => {
    if (isBrowser(request)) {
      reply.header('cache-control', 'no-store')
      reply.header('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
    }
  })
  app.addHook('preValidation', (request, reply, done) => {
    if (!isBrowser(request) || ['GET', 'HEAD'].includes(request.method)) return done()
    if (request.headers.origin !== `${request.protocol}://${request.host}`) return done(new ArtiumError('CSRF_INVALID'))
    if (request.cookies[browserCookie]) {
      try {
        if (session(request).csrf_token !== request.cookies._csrf) return done(new ArtiumError('CSRF_INVALID'))
      } catch (error) { return done(error as Error) }
    }
    app.csrfProtection(request, reply, () => {
      if (request.body && typeof request.body === 'object') {
        const { _csrf: _token, ...input } = request.body as Record<string, unknown>
        request.body = input
      }
      done()
    })
  })
  app.addHook('onResponse', async (request, reply) => {
    if (!isBrowser(request) || !request.cookies[browserCookie] || reply.statusCode >= 400) return
    try {
      const current = session(request)
      db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(Date.now(), current.id)
    } catch (error) {
      if (!(error instanceof ArtiumError)) throw error
    }
  })

  function form(reply: FastifyReply, action: string, label: string, fields = '', tone = 'btn-primary', after = '') {
    return `<form method="post" action="${action}"><input type="hidden" name="_csrf" value="${escape(reply.generateCsrf())}">${fields}${after ? `<div class="auth-actions">${after}<button class="btn ${tone}" type="submit">${label}</button></div>` : `<button class="btn ${tone}" type="submit">${label}</button>`}</form>`
  }
  const passwordField = (name: string, label: string, autocomplete: string, hint = '') =>
    `<div class="field"><label for="${name}">${label}</label><input id="${name}" type="password" name="${name}" autocomplete="${autocomplete}"${hint ? ` aria-describedby="${name}-hint"` : ''} required>${hint ? `<p class="hint" id="${name}-hint">${hint}</p>` : ''}</div>`
  const signedOut: PageOptions = { mark: { icon: 'check', tone: 'ok' } }
  const home = (current: BrowserSession) => current.must_change ? '/password' : current.administrator ? '/admin' : '/account'

  app.get('/', async (_request, reply) => reply.redirect('/admin'))
  app.get('/login', async (request, reply) => {
    if (request.cookies[browserCookie]) {
      try {
        const current = session(request)
        return reply.redirect(current.must_change ? '/password' : current.administrator ? '/admin' : '/account')
      } catch (error) {
        if (!(error instanceof ArtiumError)) throw error
        reply.clearCookie(browserCookie, cookieOptions)
      }
    }
    const providers = db.prepare('SELECT id, name, kind FROM sso_providers WHERE enabled = 1 ORDER BY name, id').all() as { id: string, name: string, kind: string }[]
    const password = form(reply, '/login', providers.length ? 'Sign in with password' : 'Sign in',
      '<div class="field"><label for="username">Username</label><input id="username" name="username" autocomplete="username" required></div>' + passwordField('password', 'Password', 'current-password'),
      providers.length ? 'btn-secondary' : 'btn-primary')
    const content = providers.length
      ? providers.map((provider, index) => `<a class="btn ${index ? 'btn-secondary' : 'btn-primary'}" href="/auth/sso/${escape(encodeURIComponent(provider.id))}/start">Continue with ${provider.kind === 'entra' ? `Microsoft (${escape(provider.name)})` : escape(provider.name)}</a>`).join('') +
        `<p class="divider">Break-glass admins only</p>${password}<p class="hint">Local password sign-in is limited to designated break-glass administrators. Every break-glass sign-in and password confirmation is flagged in the audit log.</p>`
      : password
    return browserPage(reply, 'Sign in', content, undefined, providers.length ? 'Use your organisation account.' : 'Use the username and password from your administrator.',
      { footnote: 'Locked out? Wait 15 minutes or ask an administrator to unlock your account.' })
  })
  app.post('/login', async (request, reply) => {
    const input = loginSchema.safeParse(request.body)
    if (!input.success) throw new ArtiumError('INVALID_INPUT')
    let identity
    try { identity = await attempts.signIn(input.data.username, input.data.password, context(request)) }
    catch (error) {
      if (error instanceof ArtiumError && error.code === 'SIGN_IN_FAILED') audit.record({ ...context(request),
        event: 'sign-in', userId: null, tool: null, outcome: 'SIGN_IN_FAILED' })
      throw error
    }
    const result = audit.change({ ...context(request), event: 'sign-in', userId: identity.userId, tool: null, outcome: 'success',
      authenticationMethod: localAuthenticationMethod(db, identity.userId) }, () => {
      if (request.cookies[browserCookie]) {
        const previous = session(request)
        db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(Date.now(), previous.id)
      }
      return createBrowserSession(db, identity.userId, request.cookies._csrf!)
    }).value
    return reply.setCookie(browserCookie, result.id, cookieOptions).redirect(result.mustChange ? '/password' : result.administrator ? '/admin' : '/account', 303)
  })
  app.post('/logout', async (request, reply) => {
    const current = session(request)
    const input = z.object({ providerLogout: z.literal('true').optional() }).strict().safeParse(request.body ?? {})
    if (!input.success) throw new ArtiumError('INVALID_INPUT')
    audit.change({ ...context(request), event: 'sign-out', userId: current.user_id, tool: null, outcome: 'success' }, () => {
      db.prepare('UPDATE session_families SET revoked_at = ? WHERE id = ?').run(Date.now(), current.family_id)
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(Date.now(), current.id)
    })
    reply.clearCookie(browserCookie, cookieOptions).clearCookie('_csrf', cookieOptions)
    if (input.data.providerLogout && current.source === 'sso') {
      try {
        const destination = await providerSignOut(current, `${request.protocol}://${request.host}`)
        if (destination) return browserPage(reply, 'You’re signed out', `<a class="btn btn-secondary" data-provider-signout href="${escape(destination)}">Continue to provider sign-out</a><a class="btn btn-primary" href="/login">Sign in again</a>`,
          undefined, 'Your Artium session has ended. Your identity provider session may still be active until you sign out there too.', signedOut)
      } catch { /* Local revocation succeeds even when discovery is unavailable. */ }
      return browserPage(reply, 'You’re signed out', callout('warn', 'alert', '', '<p>Provider sign-out could not be started; your provider session may still be active.</p>', 'status') + '<a class="btn btn-primary" href="/login">Sign in again</a>',
        undefined, 'Your Artium session has ended.', signedOut)
    }
    return reply.redirect('/login', 303)
  })
  app.get('/account', async (request, reply) => {
    const current = session(request)
    if (current.must_change) return reply.redirect('/password')
    const roles = accountRoles(db, current)
    return browserPage(reply, 'Your account', accountContent(db, current, reply.generateCsrf(), `${request.protocol}://${request.host}`), current,
      `${current.display_name} (${current.username}) · ${current.source === 'sso' ? 'SSO sign-in' : 'Local password sign-in'} · ${roles.length === 1 ? 'Role' : 'Roles'}: ${roles.join(', ') || 'None'}`,
      { helpTopic: 'Account', actions: current.source === 'local' ? `<a class="btn btn-secondary" href="/password">${icon('key')}Change password</a>` : '' })
  })
  app.route({ method: accountSessionRoutes.list.method, url: accountSessionRoutes.list.path, handler: async request => {
    const current = session(request)
    if (current.must_change) throw new ArtiumError('PASSWORD_CHANGE_REQUIRED')
    if (!accountSessionRoutes.list.input.safeParse(request.query).success) throw new ArtiumError('INVALID_INPUT')
    return listUserSessions(db, current.user_id, current.family_id)
  } })
  for (const route of [accountSessionRoutes.revoke, accountSessionRoutes.revokeAll]) {
    app.route({ method: route.method, url: route.path, handler: async request => {
      const current = session(request)
      if (current.must_change) throw new ArtiumError('PASSWORD_CHANGE_REQUIRED')
      if (!route.input.safeParse(request.body ?? {}).success) throw new ArtiumError('INVALID_INPUT')
      const params = sessionParamsSchema.omit({ id: true }).safeParse(request.params)
      if (route === accountSessionRoutes.revoke && !params.success) throw new ArtiumError('INVALID_INPUT')
      const familyId = params.success ? params.data.sessionId : null
      audit.change({ ...context(request), event: 'sign-out', action: familyId ? 'revoke-session' : 'revoke-sessions',
        targetId: familyId ?? current.user_id, userId: current.user_id, tool: null, outcome: 'success' }, () => {
        if (familyId) revokeUserSession(db, current.user_id, familyId, Date.now())
        else revokeUserSessions(db, current.user_id, Date.now())
      })
      return { revoked: true }
    } })
  }
  app.get('/password', async (request, reply) => {
    const current = session(request)
    const hint = 'Up to 512 bytes. Changing it signs out all your browser and CLI sessions; then sign in again with the new password.'
    const fields = (current.must_change ? '' : passwordField('currentPassword', 'Current password', 'current-password')) + passwordField('newPassword', 'New password', 'new-password', hint)
    return browserPage(reply, current.must_change ? 'Choose a new password' : 'Change password',
      form(reply, '/password', current.must_change ? 'Set password and sign in again' : 'Change password', fields, 'btn-primary', current.must_change ? '' : `<a class="btn btn-ghost" href="${home(current)}">Cancel</a>`),
      current, current.must_change ? 'Your temporary password must be replaced before you continue.' : 'Replace your local password.', { layout: 'auth', helpTopic: 'Change password' })
  })
  app.post('/password', async (request, reply) => {
    const current = session(request)
    const input = passwordChangeSchema.safeParse(request.body)
    if (!input.success) throw new ArtiumError('INVALID_INPUT')
    await provider.changePassword(current.user_id, input.data.currentPassword, input.data.newPassword, audit,
      context(request), Date.now(), { sessionId: request.cookies[browserCookie]! })
    return reply.clearCookie(browserCookie, cookieOptions).clearCookie('_csrf', cookieOptions).redirect('/login', 303)
  })
  app.get('/reauth', async (request, reply) => {
    const current = session(request)
    if (current.must_change) return reply.redirect('/password')
    const query = z.object({ complete: z.literal('1').optional(), status: z.literal('1').optional() }).strict().safeParse(request.query)
    if (!query.success) throw new ArtiumError('INVALID_INPUT')
    if (query.data.status) return { sessionId: current.id, until: recentBrowserAuth(current) ? current.reauthenticated_at! + authDefaults.recentAuthMs : 0 }
    if (current.source === 'sso') {
      const identity = browserIdentity(db, current)
      if (query.data.complete) {
        if (!recentBrowserAuth(current)) throw new ArtiumError('REAUTH_REQUIRED')
        return browserPage(reply, 'Identity confirmed', `<p data-sso-reauth-complete>Confirmation complete. You can close this window and return to your pending action.</p><a class="btn btn-secondary" href="${home(current)}">Continue to Artium</a>`,
          current, undefined, { layout: 'auth', mark: { icon: 'check', tone: 'ok' } })
      }
      return browserPage(reply, 'Confirm identity', `<div class="auth-actions"><a class="btn btn-ghost" href="${home(current)}">Cancel</a><a class="btn btn-primary" data-sso-reauth-start href="/auth/sso/${escape(encodeURIComponent(identity.provider_id))}/start?reauth=1">Confirm with your provider</a></div>`,
        current, 'Admin changes need a confirmation every 15 minutes. Confirm your identity with your provider, then submit your change again.', { layout: 'auth', mark: { icon: 'lock', tone: 'neutral' } })
    }
    return browserPage(reply, 'Confirm password', form(reply, '/reauth', 'Confirm password', passwordField('password', 'Password', 'current-password'), 'btn-primary', `<a class="btn btn-ghost" href="${home(current)}">Cancel</a>`),
      current, 'Admin changes need a confirmation every 15 minutes. Confirm your password, then submit your change again.', { layout: 'auth', mark: { icon: 'lock', tone: 'neutral' } })
  })
  async function reauthenticate(request: FastifyRequest) {
    const current = session(request)
    if (current.must_change) throw new ArtiumError('PASSWORD_CHANGE_REQUIRED')
    if (current.source === 'sso') throw new ArtiumError('REAUTH_REQUIRED')
    const input = reauthSchema.safeParse(request.body)
    if (!input.success) throw new ArtiumError('INVALID_INPUT')
    await attempts.signIn(current.username, input.data.password, context(request))
    const latest = session(request)
    const now = Date.now()
    audit.change({ ...context(request), event: 'reauth', userId: latest.user_id, tool: null, outcome: 'success',
      authenticationMethod: localAuthenticationMethod(db, latest.user_id) }, () => {
      db.prepare('UPDATE sessions SET reauthenticated_at = ? WHERE id = ?').run(now, latest.id)
    })
    return now + authDefaults.recentAuthMs
  }
  app.post('/reauth', async (request, reply) => {
    await reauthenticate(request)
    return reply.redirect(session(request).administrator ? '/admin' : '/account', 303)
  })
  return { reauthenticate, isBrowser }
}
