import { decode, encode } from '@toon-format/toon'
import inventory from '../../../tools/inventories/gh-axi.json' with { type: 'json' }
import { ArtiumError } from '../../shared/errors.js'
import type { RunnerResult } from '../runner/runner.js'
import type { PreparedCall } from './types.js'

function managedHelp(command: string): string {
  const routes = inventory.commands.filter(route => command === 'help' || route.command === command || route.command.startsWith(command + ' '))
  return encode({ commands: routes.map(route => {
    const positional = route.command === 'api' ? ' [GET] <relative-path>'
      : route.positionals === 'variadic' ? ' [<query> ...]'
        : Array.from({ length: Number(route.positionals) }, () => ' [<argument>]').join('')
    const flags = Object.entries(route.flags).map(([name, type]) => name === 'repo'
      ? `${route.repository ? '-R OWNER/NAME' : '[-R OWNER/NAME]'}`
      : name === 'owner' && route.effect === 'write' && route.command.startsWith('project ') ? '--owner OWNER'
      : `[--${name}${type === 'value' ? ' <value>' : type === 'boolean-value' ? '[=true|false]' : ''}]`).join(' ')
    return `artium-axi gh-axi ${route.command}${positional} ${flags}`
  }), help: ['Artium supplies the managed GitHub host and credential. Use -R OWNER/NAME for repository commands. Writes default off and require an administrator-enabled exact operation. Preview without --confirm, then repeat the exact request with its returned --confirm value. API requests accept GET and relative paths only. Deletes, secret set, merge --admin, local git, downloads and files are refused. Only gist create/edit with --filename accepts stdin. Ask an Artium administrator to reconnect the GitHub credential or check its permissions.'] }) + '\n'
}

export function hostedGhOutput(invocation: PreparedCall['invocation'], result: RunnerResult): RunnerResult {
  if (!invocation) return result
  if (invocation.credentialAuth === 'device' && result.exitCode !== 0) {
    const revoked = ([result.stdout, result.stderr]).some(output => {
      if (invocation.nativeGh && /\bBad credentials \(HTTP 401\)/i.test(output)) return true
      try {
        const document = (output.trimStart().startsWith('{') ? JSON.parse(output)
          : decode(output.split(/\nhelp\[\d+\]:/)[0])) as Record<string, unknown>
        return document.code === 'AUTH_REQUIRED' || document.code === 'UNKNOWN'
          && typeof document.error === 'string' && /\bBad credentials \(HTTP 401\)/i.test(document.error)
      } catch { return false }
    })
    if (revoked) throw new ArtiumError('CREDENTIAL_EXPIRED')
  }
  if (invocation.help && result.exitCode === 0) return { ...result, stdout: managedHelp(invocation.command), stderr: '' }
  if (result.exitCode !== 0) {
    const diagnostic = (output: string, truncated: boolean) => {
      if (truncated) return output
      try {
        const json = output.trimStart().startsWith('{')
        const document = (json ? JSON.parse(output) : decode(output.split(/\nhelp\[\d+\]:/)[0])) as Record<string, unknown>
        if (typeof document.error !== 'string' || !(['AUTH_REQUIRED', 'FORBIDDEN'].includes(String(document.code))
          || document.code === 'UNKNOWN' && /\bBad credentials \(HTTP 401\)/i.test(document.error))) return output
        const managed = { ...document, error: 'GitHub authentication or permission check failed.',
          help: ['Ask an Artium administrator to reconnect the GitHub credential and check its permissions.'] }
        return (json ? JSON.stringify(managed) : encode(managed)) + '\n'
      } catch { return output }
    }
    return { ...result, stdout: diagnostic(result.stdout, result.truncated.stdout), stderr: diagnostic(result.stderr, result.truncated.stderr) }
  }
  if (!invocation.help && invocation.command === 'issue transfer') return { ...result,
    stdout: encode({ status: 'transferred', checkArgs: invocation.checkArgs }) + '\n', stderr: '' }
  if (invocation.nativeGh) return { ...result, stdout: encode(invocation.command === 'issue comment'
    ? { comment: { url: result.stdout.trim() } }
    : { operation: invocation.command, status: 'completed', output: result.stdout.trim() }) + '\n' }
  if (invocation.command !== 'run view' || !result.stdout.startsWith('run_log:')) return result
  if (result.truncated.stdout) throw new ArtiumError('INVALID_RESPONSE', 'The hosted run output was truncated.')
  const document = decode(result.stdout.split(/\nhelp\[\d+\]:/)[0]) as { run_log?: Record<string, unknown>, help?: string[] }
  if (!document.run_log?.truncated) return result
  delete document.run_log.full_log
  document.help = ['Log output is truncated to its tail. The complete log is unavailable through Artium.']
  return { ...result, stdout: encode(document) + '\n' }
}
