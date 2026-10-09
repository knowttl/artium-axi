import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { cliVersion } from '../shared/version.js'

export function registerCliDownload(app: FastifyInstance) {
  const bundlePath = new URL('../../cli/artium-axi.mjs', import.meta.url)
  for (const checksum of [false, true]) {
    app.get(`/cli/artium-axi.mjs${checksum ? '.sha256' : ''}`, async (_request, reply) => {
      const bundle = readFileSync(bundlePath)
      const digest = createHash('sha256').update(bundle).digest('hex')
      reply.header('X-Artium-Cli-Version', cliVersion)
      reply.header('X-Artium-Cli-Sha256', digest)
      reply.header('Cache-Control', 'no-cache')
      reply.type(checksum ? 'text/plain; charset=utf-8' : 'text/javascript; charset=utf-8')
      reply.header('Content-Disposition', `attachment; filename="artium-axi.mjs${checksum ? '.sha256' : ''}"`)
      return checksum ? `${digest}  artium-axi.mjs\n` : bundle
    })
  }
}
