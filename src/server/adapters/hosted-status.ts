import { decode, encode } from '@toon-format/toon'
import { ArtiumError } from '../../shared/errors.js'
import type { RunnerResult } from '../runner/runner.js'
import type { PreparedCall } from './types.js'
import { hostedGhOutput } from './gh-output.js'
import { rewriteGhSuggestions } from '../../shared/gh-suggestions.js'
import falcon from '../../../tools/inventories/falcon-axi.json' with { type: 'json' }
import kubernetes from '../../../tools/inventories/kubernetes-axi.json' with { type: 'json' }
import ssh from '../../../tools/inventories/ssh-axi.json' with { type: 'json' }
import proxmox from '../../../tools/inventories/proxmox-axi.json' with { type: 'json' }

// Status metadata describes the hosted credential, never the server's local layout.
export function hostedStatus(tool: string, invocation: PreparedCall['invocation'], result: RunnerResult): RunnerResult {
  if (tool === 'proxmox-axi' && invocation?.help && result.exitCode === 0) {
    const route = proxmox.commands.find(route => route.command === invocation.command)
    const document = { command: `artium-axi proxmox-axi${invocation.command === 'home' ? '' : ' ' + invocation.command}`,
      flags: route?.flags ?? { help: 'boolean', format: 'value' },
      commands: invocation.command === 'home' ? proxmox.discovery.commands : proxmox.commands
        .filter(route => route.command.startsWith(invocation.command + ' ')).map(route => route.command),
      help: [proxmox.discovery.help] }
    const json = result.stdout.trimStart().startsWith('{')
    return { ...result, stdout: (json ? JSON.stringify(document) : encode(document)) + '\n' }
  }
  if (tool === 'proxmox-axi' && invocation && invocation.command !== 'version' && result.stdout) {
    if (result.truncated.stdout) throw new ArtiumError('INVALID_RESPONSE')
    try {
      const json = result.stdout.trimStart().startsWith('{')
      const document = (json ? JSON.parse(result.stdout) : decode(result.stdout)) as Record<string, unknown>
      delete document.credential
      const code = document.error && typeof document.error === 'object' && 'code' in document.error ? document.error.code : undefined
      if (code === 'AUTH_SESSION_REQUIRED') document.help = [
        'This operation forbids API tokens. Ask an administrator to configure an authorized username/password credential for automatic sign-in.',
        'TFA accounts cannot sign in automatically; use an API token for operations that permit tokens.',
      ]
      if (code === 'AUTH_REQUIRED' || code === 'AUTH_SESSION_INVALID') document.help = [
        'Artium manages Proxmox sign-in. Ask an administrator to verify the stored credential; users have no separate Proxmox login.',
        'The operation was not retried. Never replay a consumed write confirmation; reconcile its durable journal before further action.',
      ]
      result = { ...result, stdout: (json ? JSON.stringify(document) : encode(document)) + '\n' }
    } catch { throw new ArtiumError('INVALID_RESPONSE') }
  }
  if (tool === 'ssh-axi' && invocation && result.exitCode === 0) {
    if (result.truncated.stdout || result.truncated.stderr) throw new ArtiumError('INVALID_RESPONSE')
    if (invocation.help && ssh.managedCommands.some(route => route.command === invocation.command)) return result
    const json = result.stdout.trimStart().startsWith('{')
    try {
      const document = (json ? JSON.parse(result.stdout) : decode(result.stdout)) as Record<string, unknown>
      if (invocation.help) {
        const route = ssh.commands.find(route => route.command === invocation.command)!
        return { ...result, stdout: (json ? JSON.stringify : encode)({
          command: `artium-axi ssh-axi${route.command === 'home' ? '' : ' ' + route.command}`,
          flags: route.flags, commands: route.command === 'home' ? ssh.discovery.commands : [], help: [ssh.discovery.help],
        }) + '\n' }
      }
      if (Array.isArray(document.help)) document.help = ['artium-axi ssh-axi host show <host>', 'artium-axi ssh-axi doctor <host>']
      return { ...result, stdout: (json ? JSON.stringify(document) : encode(document)) + '\n' }
    } catch { if (/^\d+\.\d+\.\d+\s*$/.test(result.stdout)) return result; throw new ArtiumError('INVALID_RESPONSE') }
  }
  if (tool === 'kubernetes-axi' && invocation && !invocation.help && result.exitCode === 0
    && (invocation.command.startsWith('prepare -- ') || invocation.command === 'preview')) {
    const rewrite = (output: string, truncated: boolean) => {
      if (truncated || !output) return output
      try {
        const json = output.trimStart().startsWith('{')
        const document = (json ? JSON.parse(output) : decode(output)) as Record<string, unknown>
        if (Array.isArray(document.help)) {
          document.help = document.help.map(value => typeof value === 'string'
            ? value.replace(/^kubernetes-axi (?=preview |confirm )/, 'artium-axi kubernetes-axi ') : value)
          return (json ? JSON.stringify : encode)(document) + '\n'
        }
      } catch {}
      return output
    }
    return { ...result, stdout: rewrite(result.stdout, result.truncated.stdout), stderr: rewrite(result.stderr, result.truncated.stderr) }
  }
  if (tool === 'kubernetes-axi' && invocation?.help) {
    const workflow = /^(?:prepare|server-dry-run) -- (.+)$/.exec(invocation.command)
    const route = kubernetes.commands.find(route => route.command === invocation.command)
      ?? (workflow ? kubernetes.writeCommands.find(route => route.command === workflow[1]) : undefined)
      ?? kubernetes.workflows.find(workflow => workflow.command === invocation.command)
    if (!route) throw new ArtiumError('INVALID_RESPONSE')
    const command = `artium-axi kubernetes-axi${invocation.command === 'home' ? '' : ' ' + invocation.command}`
    const usage = 'usage' in route ? 'artium-axi kubernetes-axi ' + route.usage : command + ' [flags]'
    const rewrite = (output: string, truncated: boolean) => {
      if (truncated || !output) return output
      try {
        const json = output.trimStart().startsWith('{')
        const document = (json ? JSON.parse(output) : decode(output)) as Record<string, unknown>
        if (Array.isArray(document.flags) && (typeof document.command === 'string' || Array.isArray(document.commands))) {
          return (json ? JSON.stringify : encode)({ command, usage, effect: route.effect,
            flags: route.flags, commands: route.command === 'home' ? kubernetes.discovery.commands : [],
            examples: [command + ' --help'], help: [kubernetes.discovery.help] }) + '\n'
        }
      } catch {}
      return output
    }
    return { ...result, stdout: rewrite(result.stdout, result.truncated.stdout), stderr: rewrite(result.stderr, result.truncated.stderr) }
  }
  if (tool === 'gh-axi') {
    const output = hostedGhOutput(invocation, result)
    return { ...output, stdout: rewriteGhSuggestions(output.stdout, invocation, output.truncated.stdout),
      stderr: rewriteGhSuggestions(output.stderr, invocation, output.truncated.stderr) }
  }
  if (!invocation || invocation.help || !(['home', 'auth status'].includes(invocation.command)
    || tool === 'falcon-axi' && invocation.command === 'scopes' || tool === 'kubernetes-axi' && invocation.command === 'doctor')) return result
  if (result.truncated.stdout || result.truncated.stderr) throw new ArtiumError('INVALID_RESPONSE', 'The hosted status output was truncated.')
  if (result.stdout === '') return result
  try {
    const json = result.stdout.trimStart().startsWith('{')
    const document = (json ? JSON.parse(result.stdout) : decode(result.stdout)) as Record<string, unknown>
    if (tool === 'falcon-axi') {
      const posture = 'Reads are available. Writes default off and require administrator enablement of exact operations. RTR execution additionally requires native profile rtr.enabled, obeys command restrictions and requires --execute with exact --confirm device:command. Fixed Identity Protection queries require the vendor-labelled Identity Protection GraphQL:write scope.'
      if (invocation.command === 'scopes') {
        if (!Array.isArray(document.scopes)) throw new Error('Invalid scope matrix')
        const admitted = new Set(falcon.commands.map(entry => entry.command))
        document.scopes = document.scopes.flatMap((row: Record<string, unknown>) => {
          if (typeof row.commands !== 'string') throw new Error('Invalid scope commands')
          const commands = row.commands.split(', ').filter(command => admitted.has(command))
          return commands.length ? [{ ...row, commands: commands.join(', ') }] : []
        })
        document.posture = posture
        document.member_cid_token_scope = 'Additional Flight Control permissions may be required for the saved member CID; verify with your tenant administrator.'
        document.help = ['Grant the listed scopes in the Falcon console under Support and resources > API clients and keys.',
          'Identity Protection GraphQL:write permits only the fixed read queries exposed here.',
          'Some read scopes require the corresponding Falcon product licence.']
      } else if (Object.hasOwn(document, 'scopes')) document.scopes = posture
    }
    const references = new Map<string, string>()
    const replace = (value: unknown, kind: string) => {
      if (typeof value === 'string' && value.length > kind.length) references.set(value, kind)
      return kind
    }
    const sourceKind = (value: unknown): unknown => {
      if (typeof value === 'string') {
        const match = /^(env|file|stored):(.+)$/.exec(value)
        if (match) {
          const kind = match[1] === 'stored' ? 'file' : match[1]
          replace(match[2], kind)
          return replace(value, kind)
        }
        return value === 'stored' ? 'file' : value
      }
      if (value && typeof value === 'object') {
        const reference = value as Record<string, unknown>
        if (Object.hasOwn(reference, 'env')) return replace(reference.env, 'env')
        if (Object.hasOwn(reference, 'file')) return replace(reference.file, 'file')
        if (Object.hasOwn(reference, 'stored')) return 'file'
        throw new Error('Unknown secret source')
      }
      return value
    }
    for (const field of ['config', 'configPath', 'credential_path']) {
      replace(document[field], 'file')
      delete document[field]
    }
    if (Object.hasOwn(document, 'bin')) document.bin = replace(document.bin, `artium-axi ${tool}`)
    if (document.setup && typeof document.setup === 'object') document.setup = 'Managed by artium.'
    for (const field of ['source', 'bind_password_source', 'client_secret_source', 'apiKey', 'accessKey', 'secretKey', 'tokenSource', 'secretSource']) {
      if (Object.hasOwn(document, field)) document[field] = sourceKind(document[field])
    }
    if (document.secrets && typeof document.secrets === 'object') {
      const secrets = document.secrets as Record<string, unknown>
      for (const field of Object.keys(secrets)) secrets[field] = sourceKind(secrets[field])
    }
    if (tool === 'awx-axi' && document.auth && typeof document.auth === 'object') {
      const auth = document.auth as Record<string, unknown>
      if (typeof auth.source === 'string' && auth.source !== 'none') {
        auth.source = replace(auth.source, /^[A-Za-z_][A-Za-z0-9_]*$/.test(auth.source) && !['file', 'stored'].includes(auth.source) ? 'env' : 'file')
      }
    }
    if (Array.isArray(document.sources)) {
      for (const source of document.sources as Record<string, unknown>[]) {
        if (Object.hasOwn(source, 'source')) source.source = sourceKind(source.source)
        if (Object.hasOwn(source, 'location')) {
          source.kind = sourceKind(source.kind)
          replace(source.location, source.kind === 'env' ? 'env' : 'file')
          delete source.location
        }
      }
    }
    const sanitize = (text: string) => {
      for (const [reference, kind] of [...references].sort((a, b) => b[0].length - a[0].length)) text = text.replaceAll(reference, kind)
      return text
    }
    const suggestions = [document]
    if (tool === 'vectra-axi' && document.live && typeof document.live === 'object') suggestions.push(document.live as Record<string, unknown>)
    for (const owner of suggestions) {
      for (const field of ['error', 'help']) {
        if (Object.hasOwn(owner, field)) owner[field] = JSON.parse(JSON.stringify(owner[field], (_, value: unknown) =>
          typeof value === 'string' ? sanitize(value) : value))
      }
    }
    return { ...result, stdout: (json ? JSON.stringify(document) : encode(document)) + '\n', stderr: sanitize(result.stderr) }
  } catch { throw new ArtiumError('INVALID_RESPONSE', 'The hosted status output is invalid.') }
}
