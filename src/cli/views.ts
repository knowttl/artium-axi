import falcon from '../../tools/inventories/falcon-axi.json' with { type: 'json' }
import vectra from '../../tools/inventories/vectra-axi.json' with { type: 'json' }
import az from '../../tools/inventories/az-axi.json' with { type: 'json' }
import mg from '../../tools/inventories/mg-axi.json' with { type: 'json' }
import type { z } from 'zod'
import { meResponseSchema, toolsResponseSchema } from '../shared/api.js'
import { ArtiumError } from '../shared/errors.js'
import { rewriteDiscoveryHelp } from './rewrite.js'

const manifests = { 'falcon-axi': falcon, 'vectra-axi': vectra, 'az-axi': az, 'mg-axi': mg }
type Tools = z.infer<typeof toolsResponseSchema>['tools']

export function identityView(user: z.infer<typeof meResponseSchema>, server: string): string {
  return `user: ${JSON.stringify(user.username)}\nserver: ${JSON.stringify(server)}\nroles[${user.roles.length}]: ${user.roles.map(role => JSON.stringify(role)).join(',')}\naccessExpiresAt: ${user.accessExpiresAt}\n`
}

export function toolsView(tools: Tools): string {
  if (!tools.length) return 'tools: 0 available\nreason: No enabled runtime tool is available through your assigned roles.\ncontact: Ask an administrator to check your role assignments and enabled tools.\nnext[1]:\n  - artium-axi whoami\n'
  return `tools[${tools.length}]{name,status,version}:\n${tools.map(tool => `  ${tool.name},${tool.status},${JSON.stringify(tool.version)}`).join('\n')}\nnext[2]:\n  - artium-axi tools show ${tools[0].name}\n  - artium-axi ${tools[0].name} ${manifests[tools[0].name].discovery.example.join(' ')}\n`
}

export function toolView(tool: Tools[number]): string {
  const manifest = manifests[tool.name]
  if (tool.version !== manifest.version) throw new ArtiumError('INVALID_RESPONSE', 'The server tool version differs from the bundled manifest.', 'Download the current CLI from /cli/artium-axi.mjs.')
  const commands = manifest.discovery.commands
  const help = rewriteDiscoveryHelp(manifest.discovery.help, tool.name)
  return `tool: ${tool.name}\nversion: ${JSON.stringify(tool.version)}\nstatus: ${tool.status}\ncommands[${commands.length}]: ${commands.join(',')}\nexample: artium-axi ${tool.name} ${manifest.discovery.example.join(' ')}\nupstreamHelp: ${JSON.stringify(help)}\n`
}
