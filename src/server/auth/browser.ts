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
import { adminNav, pageHelp } from '../admin/forms.js'
import { authDefaults } from '../config.js'
import { listUserSessions, revokeUserSession } from './user-sessions.js'
import { revokeUserSessions } from './tokens.js'
import { accountContent } from '../admin/account.js'

export const browserCookie = 'artium-session'
export const cookieOptions = { path: '/', secure: true, httpOnly: true, sameSite: 'strict' } as const
const pages = ['/login', '/logout', '/password', '/reauth', '/device', '/admin', '/account']

export function browserPage(reply: FastifyReply, title: string, content: string, current?: BrowserSession) {
  const sso = current?.source === 'sso'
  const until = current?.reauthenticated_at === null || current?.reauthenticated_at === undefined ? 0 : current.reauthenticated_at + authDefaults.recentAuthMs
  const remaining = Math.max(0, Math.ceil((until - Date.now()) / 60_000))
  const csrf = current ? reply.generateCsrf() : ''
  const header = current ? `<header class="site-header"><a class="brand" href="${current.administrator && !current.must_change ? '/admin' : '/account'}">artium-axi</a>
    <div><p>Signed in as ${escape(current.display_name)}.</p><small>${current.source === 'sso' ? 'SSO sign-in' : current.break_glass ? 'Break-glass account' : 'Local password sign-in'}</small></div>
    ${current.administrator && !current.must_change ? `<p data-reauth-until="${until}" data-reauth-method="${sso ? 'sso' : 'local'}">${remaining ? `Changes allowed for ${remaining} min` : 'Identity confirmation required for changes'}</p>` : ''}
    <form method="post" action="/logout"><input type="hidden" name="_csrf" value="${escape(csrf)}">${sso ? '<label><input type="checkbox" name="providerLogout" value="true"> Also sign out of your identity provider</label>' : ''}<button>Sign out</button></form></header>` : ''
  const navigation = current && !current.must_change ? `<aside>${current.administrator ? adminNav(title) : `<nav aria-label="Account"><a href="/account">Account</a>${current.source === 'local' ? '<a href="/password">Change password</a>' : ''}</nav>`}</aside>` : ''
  const dialogs = current ? `<dialog id="confirmation" aria-labelledby="confirmation-title"><form method="dialog"><h2 id="confirmation-title">Confirm change</h2><p data-consequence></p><div class="dialog-actions"><button value="cancel" autofocus>Cancel</button><button value="confirmed">Confirm change</button></div></form></dialog>
    ${current.administrator && !current.must_change ? `<dialog id="reauth-dialog" aria-labelledby="reauth-title"><h2 id="reauth-title">${sso ? 'Confirm identity' : 'Confirm password'}</h2><p>${sso ? 'Confirm your identity with your provider in a new window' : 'Confirm your password'} to continue the pending action. Changes are allowed for 15 minutes. Cancel keeps your draft.</p><form data-reauth>${sso ? '' : '<label>Password <input name="password" type="password" autocomplete="current-password" required></label>'}<p data-reauth-error role="alert"></p><div class="dialog-actions"><button type="button" data-reauth-cancel>Cancel</button><button>Confirm and continue</button></div></form></dialog>` : ''}` : ''
  return reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} - artium-axi</title><link rel="stylesheet" href="/admin/assets/style.css"><script defer src="/admin/assets/confirm.js"></script></head><body${current ? ` class="signed-in" data-session-id="${escape(current.id)}"` : ''}>${header}<div class="page-layout">${navigation}<main id="main"><h1>${escape(title)}</h1>${pageHelp(title, current?.source)}<p id="message" role="alert" tabindex="-1"></p>${content}</main></div>${dialogs}</body></html>`)
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

  function form(reply: FastifyReply, action: string, label: string, fields = '') {
    return `<form method="post" action="${action}"><input type="hidden" name="_csrf" value="${escape(reply.generateCsrf())}">${fields}<button type="submit">${label}</button></form>`
  }
  const passwordField = (name: string, label: string, autocomplete: string) =>
    `<p><label>${label} <input type="password" name="${name}" autocomplete="${autocomplete}" required></label></p>`

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
    return browserPage(reply, 'Sign in', form(reply, '/login', 'Sign in',
      '<p><label>Username <input name="username" autocomplete="username" required></label></p>' + passwordField('password', 'Password', 'current-password')) +
      (providers.length ? '<p>Local password sign-in is limited to designated break-glass administrators. Every break-glass sign-in and password confirmation is flagged in Audit.</p>' : '') +
      providers.map(provider => `<p><a href="/auth/sso/${escape(encodeURIComponent(provider.id))}/start">Sign in with ${provider.kind === 'entra' ? `Microsoft (${escape(provider.name)})` : escape(provider.name)}</a></p>`).join(''))
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
        if (destination) return browserPage(reply, 'Signed out', `<p>You are signed out of artium.</p><p><a data-provider-signout href="${escape(destination)}">Continue to provider sign-out</a></p><p><a href="/login">Return to artium sign-in</a></p>`)
      } catch { /* Local revocation succeeds even when discovery is unavailable. */ }
      return browserPage(reply, 'Signed out', '<p>You are signed out of artium. Provider sign-out could not be started; your provider session may still be active.</p><p><a href="/login">Sign in</a></p>')
    }
    return reply.redirect('/login', 303)
  })
  app.get('/account', async (request, reply) => {
    const current = session(request)
    if (current.must_change) return reply.redirect('/password')
    return browserPage(reply, 'Account', accountContent(db, current, reply.generateCsrf(), `${request.protocol}://${request.host}`), current)
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
    return browserPage(reply, 'Change password', `${current.must_change ? '<p>You must change your temporary password before continuing.</p>' : ''}${form(reply, '/password', 'Change password',
      (current.must_change ? '' : passwordField('currentPassword', 'Current password', 'current-password')) + passwordField('newPassword', 'New password', 'new-password'))}`, current)
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
        return browserPage(reply, 'Identity confirmed', '<p data-sso-reauth-complete>Confirmation complete. You can close this window and return to your pending action.</p><p><a href="/account">Account</a></p>', current)
      }
      return browserPage(reply, 'Confirm identity', `<p>Confirm your identity with your provider before making changes.</p><p><a data-sso-reauth-start href="/auth/sso/${escape(encodeURIComponent(identity.provider_id))}/start?reauth=1">Confirm with your provider</a></p>`, current)
    }
    return browserPage(reply, 'Confirm password', '<p>Confirm your password, then submit your administration action again.</p>' +
      form(reply, '/reauth', 'Confirm password', passwordField('password', 'Password', 'current-password')), current)
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
