import { readFileSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'

const assets = [
  { name: 'hydrate.js', type: 'application/javascript' },
  { name: 'astryx.css', type: 'text/css' },
]

export function registerAdminClientAssets(app: FastifyInstance): void {
  for (const { name, type } of assets) {
    const body = readFileSync(new URL(`./client/${name}`, import.meta.url))
    app.get(`/admin/assets/${name}`, async (_request, reply) => reply.type(type).send(body))
  }
}
