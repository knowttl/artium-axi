import { readFileSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'

const figtree = [400, 500, 600, 700].map(weight => ({ name: `fonts/figtree-${weight}.woff2`, type: 'font/woff2' }))
const assets = [
  { name: 'hydrate.js', type: 'application/javascript' },
  { name: 'astryx.css', type: 'text/css' },
  ...figtree,
  { name: 'fonts/figtree-OFL.txt', type: 'text/plain; charset=utf-8' },
]

export function registerAdminClientAssets(app: FastifyInstance): void {
  for (const { name, type } of assets) {
    const body = readFileSync(new URL(`./client/${name}`, import.meta.url))
    app.get(`/admin/assets/${name}`, async (_request, reply) => reply.type(type).send(body))
  }
}
