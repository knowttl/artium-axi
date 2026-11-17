import type { FastifyInstance, InjectOptions } from 'fastify'
import { confirmationRouteFor } from '../../src/shared/confirmation-routes.js'
import { mintConfirmation } from '../../src/server/admin/confirmation-token.js'
import { browserCookie } from '../../src/server/auth/browser.js'
import { hashToken } from '../../src/server/auth/tokens.js'

export const confirmationOf = (cookie: string, method: string, path: string) =>
  mintConfirmation(hashToken(new RegExp(`${browserCookie}=([^;]+)`).exec(cookie)![1]!), method, path)

export function withConfirmation<Fields extends object>(cookie: string | undefined, method: string, url: string, fields: Fields) {
  const path = url.split('?')[0]!
  if (!cookie?.includes(`${browserCookie}=`) || '_confirm' in fields || !confirmationRouteFor(method, path)) return fields
  return { ...fields, _confirm: confirmationOf(cookie, method, path) }
}

export function confirmBrowserRequests(app: FastifyInstance) {
  const inject = app.inject.bind(app) as (options: InjectOptions | string) => ReturnType<FastifyInstance['inject']>
  app.inject = ((options: InjectOptions | string) => {
    if (typeof options === 'string') return inject(options)
    const { headers = {}, payload } = options
    if (headers.authorization || !payload || typeof payload !== 'object' || Buffer.isBuffer(payload)) return inject(options)
    return inject({ ...options, payload: withConfirmation(String(headers.cookie ?? ''), String(options.method ?? 'GET'), String(options.url), payload) })
  }) as typeof app.inject
}
