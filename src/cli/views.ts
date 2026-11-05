import { toolManifests as manifests } from '../shared/tool-manifests.js'
import type { z } from 'zod'
import { meResponseSchema, toolsResponseSchema } from '../shared/api.js'
import { ArtiumError } from '../shared/errors.js'
import { rewriteDiscoveryHelp } from './rewrite.js'

type Tools = z.input<typeof toolsResponseSchema>['tools']

export function identityView(user: z.infer<typeof meResponseSchema>, server: string): string {
  const scope = 'roles' in user ? `roles[${user.roles.length}]: ${user.roles.map(role => JSON.stringify(role)).join(',')}\n`
    : `delegation: ${JSON.stringify(user.delegation.label)}\n`
  return `user: ${JSON.stringify(user.username)}\nserver: ${JSON.stringify(server)}\n${scope}sessionExpiresAt: ${sessionExpiryView(user.sessionExpiresAt)}\naccessExpiresAt: ${sessionExpiryView(user.accessExpiresAt)}\nnote: Access tokens refresh automatically when a refresh token is available.\n`
}

export function sessionExpiryView(expiresAt: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((expiresAt - now) / 60_000))
  const remaining = expiresAt <= now ? 'expired' : `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`
  return `${new Date(expiresAt).toISOString().replace('.000Z', 'Z')} (${remaining})`
}

export function toolsView(tools: Tools): string {
  if (!tools.length) return 'tools: 0 available\nreason: No enabled runtime tool is available through your assigned roles.\ncontact: Ask an administrator to check your role assignments and enabled tools.\nnext[1]:\n  - artium-axi whoami\n'
  const example = tools[0].commands ? '' : `  - artium-axi ${tools[0].name} ${manifests[tools[0].name].discovery.example.join(' ')}\n`
  return `tools[${tools.length}]{name,status,version,readOnly}:\n${tools.map(tool => `  ${tool.name},${tool.status},${JSON.stringify(tool.version)},${tool.readOnly ?? true}`).join('\n')}\nnext[${example ? 2 : 1}]:\n  - artium-axi tools show ${tools[0].name}\n${example}`
}

export function toolView(tool: Tools[number]): string {
  const manifest = manifests[tool.name]
  if (tool.version !== manifest.version) throw new ArtiumError('INVALID_RESPONSE', 'The server tool version differs from the bundled manifest.', 'Download the current CLI from /cli/artium-axi.mjs.')
  if (tool.commands) return `tool: ${tool.name}\nversion: ${JSON.stringify(tool.version)}\nstatus: ${tool.status}\nreadOnly: ${tool.readOnly ?? true}\ncommands[${tool.commands.length}]: ${tool.commands.map(command => JSON.stringify(command)).join(',')}\n`
  const commands = manifest.discovery.commands
  const help = rewriteDiscoveryHelp(manifest.discovery.help, tool.name)
  return `tool: ${tool.name}\nversion: ${JSON.stringify(tool.version)}\nstatus: ${tool.status}\nreadOnly: ${tool.readOnly ?? true}\ncommands[${commands.length}]: ${commands.join(',')}\nexample: artium-axi ${tool.name} ${manifest.discovery.example.join(' ')}\nupstreamHelp: ${JSON.stringify(help)}\n`
}
