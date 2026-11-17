import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { confirmationRoutes } from '../../shared/confirmation-routes.js'
import { ArtiumError } from '../../shared/errors.js'
import { browserCookie } from '../auth/browser.js'
import { readBrowserSession } from '../auth/sessions.js'
import { checkConfirmation, mintConfirmation } from './confirmation-token.js'
import { renderAuthPage } from './render-page.js'

type Fields = Record<string, unknown>

const nameOf = (db: Database.Database, sql: string, id: unknown) => (db.prepare(sql).get(id) as { name: string } | undefined)?.name

export const confirmationNames: Readonly<Record<string, (db: Database.Database, params: Fields, body: Fields) => string | undefined>> = {
  'POST /v1/admin/users/:id/archive': (db, { id }) => nameOf(db, 'SELECT username AS name FROM users WHERE id = ?', id),
  'POST /v1/admin/ssh/credential-delete': (_db, _params, { id }) => typeof id === 'string' ? id : undefined,
  'POST /v1/admin/ssh/host-delete': (_db, _params, { id }) => typeof id === 'string' ? id : undefined,
  'DELETE /v1/admin/roles/:id': (db, { id }) => nameOf(db, 'SELECT name FROM roles WHERE id = ?', id),
  'DELETE /v1/admin/sso/role-rules/:id': (db, { id }) => nameOf(db, 'SELECT value AS name FROM role_rules WHERE id = ?', id),
  'DELETE /v1/admin/tools/:tool/instances/:name': (_db, { name }) => typeof name === 'string' ? name : undefined,
}

export function registerConfirmationGate(app: FastifyInstance, db: Database.Database, isBrowser: (request: FastifyRequest) => boolean) {
  const nativeConfirmations = new WeakMap<object, string>()
  app.addHook('preValidation', async (request, reply) => {
    const key = `${request.method} ${request.routeOptions.url}`
    const route = request.routeOptions.url && confirmationRoutes[key]
    if (!route || !isBrowser(request) || !request.cookies[browserCookie]) return
    const body = request.body !== null && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body as Fields : undefined
    const { _confirm, _confirmName, ...input } = body ?? {}
    if (body) request.body = input
    const session = readBrowserSession(db, request.cookies[browserCookie]!)
    const path = request.url.split('?')[0]!
    const native = Boolean(request.headers['content-type']?.startsWith('application/x-www-form-urlencoded'))
    const name = route.tier === 3 ? confirmationNames[key]?.(db, request.params as Fields, input) : ''
    const state = name === undefined ? 'invalid' : checkConfirmation(_confirm, session.id, request.method, path, name)
    const typed = route.tier === 2 || _confirmName === name
    if (state === 'confirmed' && typed) {
      if (native) nativeConfirmations.set(request, path.startsWith('/v1/account/') ? '/account' : '/admin')
      return
    }
    if (!native) {
      if (state === 'lapsed' && typed) reply.header('x-artium-confirmation', mintConfirmation(session.id, request.method, path, name!))
      throw new ArtiumError('CONFIRMATION_REQUIRED')
    }
    const referrer = (() => {
      try { return new URL(request.headers.referer ?? '') } catch { return undefined }
    })()
    const back = referrer?.origin === `${request.protocol}://${request.host}` && /^\/[^/\\]/.test(referrer.pathname) ? referrer.pathname + referrer.search
      : session.administrator ? '/admin' : '/account'
    if (!route.native) {
      reply.code(409)
      return renderAuthPage(reply, { title: 'Page script required', mark: { icon: 'alert', tone: 'warn' }, blocks: [
        { kind: 'text', parts: ['This change needs the page to finish loading. Nothing was changed. Reload the page, wait for it to finish loading, and submit it again.'] },
        { kind: 'buttons', buttons: [{ label: 'Go back', tone: 'primary', href: back }] }] }, session)
    }
    const text = (field: string) => typeof input[field] === 'string' ? input[field].slice(0, 1000) : ''
    const carried = Object.fromEntries(route.native.flatMap(field => typeof input[field] === 'string' ? [[field, input[field]]] : []))
    return renderAuthPage(reply, { title: text('_confirmTitle') || 'Confirm this change', mark: { icon: 'alert', tone: 'warn' }, blocks: [
      { kind: 'text', parts: [text('_confirmText') || 'This change takes effect as soon as you confirm it.'] },
      { kind: 'form', action: path, fields: [], post: { csrf: reply.generateCsrf(), hidden: { ...carried, _confirm: mintConfirmation(session.id, request.method, path, '') } }, blocks: [
        { kind: 'buttons', row: true, buttons: [{ label: 'Cancel', tone: 'ghost', href: back }, { label: text('_confirmAction') || 'Confirm', tone: 'primary' }] }] }] }, session)
  })
  app.addHook('onSend', async (request, reply, payload) => {
    const destination = nativeConfirmations.get(request)
    if (!destination || reply.statusCode < 200 || reply.statusCode >= 300) return payload
    reply.code(303).header('location', destination)
    return null
  })
}
