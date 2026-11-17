import type { FastifyInstance, InjectOptions } from 'fastify'
import { confirmationRouteFor } from '../../src/shared/confirmation-routes.js'
import { mintConfirmation } from '../../src/server/admin/confirmation-token.js'
import { browserCookie } from '../../src/server/auth/browser.js'
import { hashToken } from '../../src/server/auth/tokens.js'

export const confirmationOf = (cookie: string, method: string, path: string, name = '') =>
  mintConfirmation(hashToken(new RegExp(`${browserCookie}=([^;]+)`).exec(cookie)![1]!), method, path, name)

export function withConfirmation<Fields extends object>(cookie: string | undefined, method: string, url: string, fields: Fields, name = '') {
  const path = url.split('?')[0]!
  const route = confirmationRouteFor(method, path)
  if (!cookie?.includes(`${browserCookie}=`) || '_confirm' in fields || !route) return fields
  return { ...fields, _confirm: confirmationOf(cookie, method, path, name), ...route.tier === 3 ? { _confirmName: name } : {} }
}

export function confirmBrowserRequests(app: FastifyInstance, names: (method: string, url: string, payload: object) => string = () => '') {
  const inject = app.inject.bind(app) as (options: InjectOptions | string) => ReturnType<FastifyInstance['inject']>
  app.inject = ((options: InjectOptions | string) => {
    if (typeof options === 'string') return inject(options)
    const { headers = {}, payload } = options
    if (headers.authorization || !payload || typeof payload !== 'object' || Buffer.isBuffer(payload)) return inject(options)
    const method = String(options.method ?? 'GET')
    return inject({ ...options, payload: withConfirmation(String(headers.cookie ?? ''), method, String(options.url), payload, names(method, String(options.url), payload)) })
  }) as typeof app.inject
}
