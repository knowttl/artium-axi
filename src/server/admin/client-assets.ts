import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'

const assets = [
  { name: 'hydrate.js', type: 'application/javascript' },
  { name: 'astryx.css', type: 'text/css' },
]

export function registerAdminClientAssets(app: FastifyInstance): void {
  for (const { name, type } of assets) {
    const body = readFileSync(new URL(`./client/${name}`, import.meta.url))
    const etag = `"${createHash('sha256').update(body).digest('base64url')}"`
    app.get(`/admin/assets/${name}`, async (request, reply) => {
      reply.header('cache-control', 'no-cache').header('etag', etag)
      if (request.headers['if-none-match'] === etag) return reply.code(304).send()
      return reply.type(type).send(body)
    })
  }
}
