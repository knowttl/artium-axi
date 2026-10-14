import { toolSchema } from '../shared/api.js'
import falcon from '../../tools/inventories/falcon-axi.json' with { type: 'json' }
import vectra from '../../tools/inventories/vectra-axi.json' with { type: 'json' }
import ldap from '../../tools/inventories/ldap-axi.json' with { type: 'json' }

const commands = {
  home: { usage: 'artium-axi [tools [show <tool>]|whoami|login|passwd|logout|doctor|setup|<tool> <args>]', purpose: 'Show your identity, roles and available tools.', flags: [], example: 'artium-axi' },
  setup: { usage: 'artium-axi setup --host <claude|codex|opencode> [--hook] [--force]', purpose: 'Install the embedded skill and an optional verified Claude Code session hook.',
    flags: ['--host <claude|codex|opencode> (required)', '--hook (default false; Claude Code only)', '--force (default false; explicitly replace an edited skill)'], example: 'artium-axi setup --host claude --hook' },
  tools: { usage: 'artium-axi tools', purpose: 'List available tools with their status and pinned version.', flags: [], example: 'artium-axi tools' },
  'tools show': { usage: 'artium-axi tools show <tool>', purpose: 'Show one available tool and its vetted upstream help.', flags: [], example: 'artium-axi tools show falcon-axi' },
  whoami: { usage: 'artium-axi whoami', purpose: 'Show your identity, roles, access expiry and server.', flags: [], example: 'artium-axi whoami' },
  login: { usage: 'artium-axi login --username <username> [--password-stdin]', purpose: 'Sign in with a local account.',
    flags: ['--username <username> (required)', '--password-stdin (default false; otherwise ARTIUM_AXI_PASSWORD or a terminal prompt)'],
    example: 'artium-axi login --username <username> --password-stdin' },
  passwd: { usage: 'artium-axi passwd [--password-stdin]', purpose: 'Change your password, then sign in again.',
    flags: ['--password-stdin (default false; otherwise a terminal prompt; current password uses ARTIUM_AXI_CURRENT_PASSWORD or a terminal prompt)'],
    example: 'artium-axi passwd --password-stdin' },
  logout: { usage: 'artium-axi logout', purpose: 'Remove local tokens and revoke the server session.', flags: [], example: 'artium-axi logout' },
  doctor: { usage: 'artium-axi doctor', purpose: 'Check the server, certificate, token, CLI version and cached tool health.', flags: [], example: 'artium-axi doctor' },
  'falcon-axi': { usage: 'artium-axi falcon-axi [<args>]', purpose: 'Run Falcon commands with your managed credentials.',
    flags: ['Arguments after falcon-axi are forwarded upstream, including --help.'], example: `artium-axi falcon-axi ${falcon.discovery.example.join(' ')}` },
  'vectra-axi': { usage: 'artium-axi vectra-axi [<args>]', purpose: 'Run Vectra commands with your managed credentials.',
    flags: ['Arguments after vectra-axi are forwarded upstream, including --help.'], example: `artium-axi vectra-axi ${vectra.discovery.example.join(' ')}` },
  'ldap-axi': { usage: 'artium-axi ldap-axi [<args>]', purpose: 'Read directory data with the managed LDAP bind identity.',
    flags: ['Arguments after ldap-axi are forwarded upstream, including --help.'], example: `artium-axi ldap-axi ${ldap.discovery.example.join(' ')}` },
} as const

export type HelpCommand = keyof typeof commands

export function commandHelp(command: HelpCommand): string {
  const entry = commands[command]
  const flags = [command === 'falcon-axi' || command === 'vectra-axi' || command === 'ldap-axi' ? '--help before the tool name (default false)' : '--help (default false)', ...entry.flags]
  return `usage: ${entry.usage}\npurpose: ${entry.purpose}\nflags[${flags.length}]:\n${flags.map(flag => `  - ${JSON.stringify(flag)}`).join('\n')}\nexample: ${entry.example}\n`
}

export function helpCommand(args: string[], prefixHelp = false): HelpCommand | undefined {
  if (args[0] === 'setup' && args.includes('--help')) {
    const path = args.filter(arg => arg !== '--help')
    for (let index = 1; index < path.length; index++) {
      if (path[index] === '--host' && ['claude', 'codex', 'opencode'].includes(path[index + 1])) index++
      else if (path[index] !== '--hook' && path[index] !== '--force') return undefined
    }
    return 'setup'
  }
  if (args[0] === 'falcon-axi' || args[0] === 'vectra-axi' || args[0] === 'ldap-axi') return prefixHelp && args.length === 2 ? args[0] : undefined
  if (args[0] === 'login' || args[0] === 'passwd') {
    let requested = false
    let username = false
    let stdin = false
    for (let index = 1; index < args.length; index++) {
      const option = args[index]
      if (option === '--username' && args[0] === 'login' && !username && args[index + 1] !== undefined) {
        username = true
        index++
      } else if (option === '--password-stdin' && !stdin) stdin = true
      else if (option === '--help' && !requested) requested = true
      else return undefined
    }
    return requested ? args[0] : undefined
  }
  if (!args.includes('--help')) return undefined
  const path = args.filter(arg => arg !== '--help')
  if (path.length === 0) return 'home'
  if (path[0] === 'tools' && path[1] === 'show' && (path.length === 2 || path.length === 3 && toolSchema.safeParse(path[2]).success)) return 'tools show'
  if (path.length === 1 && path[0] !== 'home' && Object.hasOwn(commands, path[0])) return path[0] as HelpCommand
  return undefined
}
