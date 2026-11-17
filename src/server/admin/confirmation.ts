import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { confirmationRoutes } from '../../shared/confirmation-routes.js'
import { ArtiumError } from '../../shared/errors.js'
import { browserCookie } from '../auth/browser.js'
import { readBrowserSession } from '../auth/sessions.js'
import { isConfirmed, mintConfirmation } from './confirmation-token.js'
import { renderAuthPage } from './render-page.js'

export function registerConfirmationGate(app: FastifyInstance, db: Database.Database) {
  app.addHook('preValidation', async (request, reply) => {
    const route = request.routeOptions.url && confirmationRoutes[`${request.method} ${request.routeOptions.url}`]
    if (!route || request.headers.authorization || !request.cookies[browserCookie]) return
    const body = request.body !== null && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body as Record<string, unknown> : undefined
    const { _confirm, ...input } = body ?? {}
    if (body) request.body = input
    const session = readBrowserSession(db, request.cookies[browserCookie]!)
    const path = request.url.split('?')[0]!
    if (isConfirmed(_confirm,session.id, request.method, path)) return
    if (!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) throw new ArtiumError('CONFIRMATION_REQUIRED')
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
    const text = (name: string) => typeof input[name] === 'string' ? input[name].slice(0, 1000) : ''
    const carried = Object.fromEntries(route.native.flatMap(name => typeof input[name] === 'string' ? [[name, input[name]]] : []))
    return renderAuthPage(reply, { title: text('_confirmTitle') || 'Confirm this change', mark: { icon: 'alert', tone: 'warn' }, blocks: [
      { kind: 'text', parts: [text('_confirmText') || 'This change takes effect as soon as you confirm it.'] },
      { kind: 'form', action: path, fields: [], post: { csrf: reply.generateCsrf(), hidden: { ...carried, _confirm: mintConfirmation(session.id, request.method, path) } }, blocks: [
        { kind: 'buttons', row: true, buttons: [{ label: 'Cancel', tone: 'ghost', href: back }, { label: text('_confirmAction') || 'Confirm', tone: 'primary' }] }] }] }, session)
  })
}
