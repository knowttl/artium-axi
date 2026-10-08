import cookie from '@fastify/cookie'
import csrf from '@fastify/csrf-protection'
import formbody from '@fastify/formbody'
import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { loginSchema, passwordChangeSchema, reauthSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import type { Audit } from '../audit/audit.js'
import type { AuthAttempts } from './attempts.js'
import { LocalAuthProvider } from './local.js'
import { createBrowserSession, readBrowserSession, requireBrowserAdmin } from './sessions.js'

export const browserCookie = 'artium-session'
const cookieOptions = { path: '/', secure: true, httpOnly: true, sameSite: 'strict' } as const
const pages = ['/login', '/logout', '/password', '/reauth', '/admin', '/account']

function escape(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

export function browserPage(reply: FastifyReply, title: string, content: string) {
  return reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} - artium-axi</title><body><main><h1>${escape(title)}</h1>${content}</main></body></html>`)
}

export function registerBrowser(app: FastifyInstance, db: Database.Database, audit: Audit, attempts: AuthAttempts) {
  app.register(cookie)
  app.register(formbody)
  app.register(csrf, { cookieOpts: cookieOptions })
  const provider = new LocalAuthProvider(db)
  const context = (request: FastifyRequest) => ({ requestId: request.id, clientAddress: request.ip })
  const session = (request: FastifyRequest) => readBrowserSession(db, request.cookies[browserCookie] ?? '')
  const isBrowser = (request: FastifyRequest) => pages.includes(request.url.split('?')[0]!) ||
    Boolean(request.cookies?.[browserCookie] && !request.headers.authorization && request.url.startsWith('/v1/'))

  app.addHook('onRequest', async (request, reply) => {
    if (isBrowser(request)) {
      reply.header('cache-control', 'no-store')
      reply.header('content-security-policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
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
    return browserPage(reply, 'Sign in', form(reply, '/login', 'Sign in',
      '<p><label>Username <input name="username" autocomplete="username" required></label></p>' + passwordField('password', 'Password', 'current-password')))
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
    const result = audit.change({ ...context(request), event: 'sign-in', userId: identity.userId, tool: null, outcome: 'success' }, () => {
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
    audit.change({ ...context(request), event: 'sign-out', userId: current.user_id, tool: null, outcome: 'success' }, () => {
      db.prepare('UPDATE session_families SET revoked_at = ? WHERE id = ?').run(Date.now(), current.family_id)
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(Date.now(), current.id)
    })
    return reply.clearCookie(browserCookie, cookieOptions).clearCookie('_csrf', cookieOptions).redirect('/login', 303)
  })
  app.get('/admin', async (request, reply) => {
    const current = session(request)
    requireBrowserAdmin(db, request.cookies[browserCookie]!, false)
    return browserPage(reply, 'Administration', `<p>Signed in as ${escape(current.display_name)}.</p><p>Administration screens are under construction.</p><p><a href="/password">Change password</a> | <a href="/reauth">Confirm password</a></p>${form(reply, '/logout', 'Sign out')}`)
  })
  app.get('/account', async (request, reply) => {
    const current = session(request)
    if (current.must_change) return reply.redirect('/password')
    return browserPage(reply, 'Account', `<p>Signed in as ${escape(current.display_name)}.</p><p><a href="/password">Change password</a>${current.administrator ? ' | <a href="/admin">Administration</a>' : ''}</p>${form(reply, '/logout', 'Sign out')}`)
  })
  app.get('/password', async (request, reply) => {
    const current = session(request)
    return browserPage(reply, 'Change password', `${current.must_change ? '<p>You must change your temporary password before continuing.</p>' : ''}${form(reply, '/password', 'Change password',
      (current.must_change ? '' : passwordField('currentPassword', 'Current password', 'current-password')) + passwordField('newPassword', 'New password', 'new-password'))}${form(reply, '/logout', 'Sign out')}`)
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
    return browserPage(reply, 'Confirm password', '<p>Confirm your password, then submit your administration action again.</p>' +
      form(reply, '/reauth', 'Confirm password', passwordField('password', 'Password', 'current-password')))
  })
  async function reauthenticate(request: FastifyRequest) {
    const current = session(request)
    if (current.must_change) throw new ArtiumError('PASSWORD_CHANGE_REQUIRED')
    const input = reauthSchema.safeParse(request.body)
    if (!input.success) throw new ArtiumError('INVALID_INPUT')
    await attempts.signIn(current.username, input.data.password, context(request))
    const latest = session(request)
    db.prepare('UPDATE sessions SET reauthenticated_at = ? WHERE id = ?').run(Date.now(), latest.id)
  }
  app.post('/reauth', async (request, reply) => {
    await reauthenticate(request)
    return reply.redirect(session(request).administrator ? '/admin' : '/account', 303)
  })
  return { reauthenticate, isBrowser }
}
