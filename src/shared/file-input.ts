import { toolManifests } from './tool-manifests.js'
import { ArtiumError } from './errors.js'
import type { RunInput } from './api.js'

// Reviewed inventories declare both the tool's file flags and each command's flags.
export function inputFileFlags(tool: string, args: readonly string[]): string[] {
  const manifest = toolManifests[tool as keyof typeof toolManifests]
  if (!manifest || !('adapterBoundary' in manifest)) return []
  const flags = 'inputFileFlags' in manifest.adapterBoundary ? manifest.adapterBoundary.inputFileFlags
    : tool === 'mg-axi' ? ['file'] : []
  if (!flags.length) return []
  let leading = 0
  if (tool === 'az-axi') {
    while (args[leading]?.startsWith('-')) {
      const token = args[leading++]
      if (!token.includes('=') && token !== '--full') leading++
      else if (token === '--full' && ['true', 'false'].includes(args[leading])) leading++
    }
  }
  const route = [...manifest.commands].sort((a, b) => b.command.length - a.command.length)
    .find(route => route.command.split(' ').every((word, index) => args[leading + index] === word))
  if (!route) return []
  return flags.filter(name => Object.hasOwn(route.flags, name))
}

export function validateFileInput(tool: string, args: readonly string[], input: RunInput): void {
  if (!input.files?.length) return
  const flags = inputFileFlags(tool, args)
  const names = new Set<string>()
  if (!args.some(arg => ['--help', '-h', '--version', '-v', '-V'].includes(arg))) {
    for (let index = 0; index < args.length; index++) {
      const token = args[index]
      if (token === '--') break
      const equals = token.indexOf('=')
      if (!flags.includes(token.slice(2).split('=')[0]) || !token.startsWith('--')) continue
      names.add(equals < 0 ? args[++index] : token.slice(equals + 1))
    }
  }
  if (input.files?.some(file => !names.has(file.name))) throw new ArtiumError('UNSUPPORTED_INPUT')
}
