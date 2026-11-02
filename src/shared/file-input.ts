import { parseArgs } from 'node:util'
import { toolManifests } from './tool-manifests.js'
import { ArtiumError } from './errors.js'
import type { RunInput } from './api.js'

export function normalizeGiteaFileArguments(args: readonly string[]): string[] {
  const fileFlags = inputFileFlags('gitea-axi', args)
  if (!fileFlags.length) return [...args]
  const route = toolManifests['gitea-axi'].commands.find(route => route.command && route.command.split(' ').every((word, index) => args[index] === word))!
  const length = route.command.split(' ').length
  let parsed
  try {
    parsed = parseArgs({ args: args.slice(length).map(arg => {
      const match = /^--([^=]+)=(true|false)$/.exec(arg)
      return match && route.flags[match[1] as keyof typeof route.flags] === 'boolean' ? '--' + match[1] : arg
    }), allowPositionals: true, strict: true, tokens: true,
    options: Object.fromEntries(Object.entries(route.flags).map(([name, type]) => {
      const short = Object.entries(route.shortFlags).find(([, target]) => target === name)?.[0]
      return [name, { type: type === 'boolean' ? 'boolean' : 'string', ...(short ? { short } : {}),
        multiple: (route.repeatableFlags as readonly string[]).includes(name) }]
    })) })
  } catch { throw new ArtiumError('INVALID_INPUT') }
  if (parsed.values.help && !args.includes('--help=false')) return [...args]
  const indexes = new Set(parsed.tokens.flatMap(token => token.kind === 'option' && fileFlags.includes(token.name)
    && token.rawName.startsWith('-') && !token.rawName.startsWith('--') ? [token.index] : []))
  return args.flatMap((arg, index) => indexes.has(index - length)
    ? parsed.tokens.flatMap(token => token.kind === 'option' && token.index === index - length
      ? ['--' + token.name + (token.inlineValue ? '=' + token.value : '')] : []) : [arg])
}

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
  if (tool === 'gitea-axi') args = normalizeGiteaFileArguments(args)
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
