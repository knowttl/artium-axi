import { toolSchema } from '../shared/api.js'
import falcon from '../../tools/inventories/falcon-axi.json' with { type: 'json' }
import vectra from '../../tools/inventories/vectra-axi.json' with { type: 'json' }
import ldap from '../../tools/inventories/ldap-axi.json' with { type: 'json' }

const commands = {
  home: { usage: 'artium-axi [tools [show <tool>]|whoami|login|passwd|logout|doctor|setup|<tool> <args>]', purpose: 'Show your identity, roles and available tools.', flags: ['--version (default false; print the client package version and exit)'], example: 'artium-axi' },
  setup: { usage: 'artium-axi setup --host <claude|codex|opencode|pi> [--hook] [--force]', purpose: 'Install skills for your signed-in account’s granted tools and an optional Claude Code session hook.',
    flags: ['--host <claude|codex|opencode|pi> (required)', '--hook (default false; Claude Code only)', '--force (default false; explicitly replace an edited skill)'], example: 'artium-axi setup --host claude --hook' },
  tools: { usage: 'artium-axi tools', purpose: 'List available tools with their status and pinned version.', flags: [], example: 'artium-axi tools' },
  'tools show': { usage: 'artium-axi tools show <tool>', purpose: 'Show one available tool and its vetted upstream help.', flags: [], example: 'artium-axi tools show falcon-axi' },
  whoami: { usage: 'artium-axi whoami', purpose: 'Show your identity, roles, access expiry and server.', flags: [], example: 'artium-axi whoami' },
  login: { usage: 'artium-axi login --sso | --username <username> [--password-stdin]', purpose: 'Sign in through browser SSO (8-hour session) or with a local account.',
    flags: ['--sso (default false; open the displayed URL in any browser and approve your terminal code; no password flags)', '--username <username> (required for local sign-in)', '--password-stdin (default false; local only; otherwise ARTIUM_AXI_PASSWORD or a terminal prompt)'],
    example: 'artium-axi login --sso' },
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
  const flags = [command === 'falcon-axi' || command === 'vectra-axi' || command === 'ldap-axi' ? '--help before the tool name (default false)' : '--help (default false)', ...entry.flags,
    '--managed-session before the command (default false; login and authenticated calls; session JSON on inherited pipe fd 3, new sessions and rotations as JSON lines on private pipe fd 4; no session file)',
    'Managed input: {serverUrl, accessToken, refreshToken?}; close fd 3 after JSON (64 KiB maximum). Output: {serverUrl, status, accessToken, refreshToken, accessExpiresAt, familyExpiresAt} per rotation, before retry, including on later failure.',
    'Managed login: fd 3 is unused; fd 4 must be a writable private pipe/socket. Local sign-in requires --username <username> --password-stdin with protected inherited stdin; password argv and ARTIUM_AXI_PASSWORD are refused. SSO uses login --sso and displays browser approval instructions immediately. New sessions use the rotation envelope; password-change-required returns {serverUrl, status, passwordChangeToken, passwordChangeExpiresAt} on fd 4 and exits 1.',
    'Managed exits: 0 success; 2 invalid JSON/descriptors or refused passwd/logout/setup; 1 authentication/transport failure; tool exit codes pass through. Only TOKEN_EXPIRED permits one refresh/retry; without refreshToken or on refusal, return control to the caller.']
  return `usage: ${entry.usage}\npurpose: ${entry.purpose}\nflags[${flags.length}]:\n${flags.map(flag => `  - ${JSON.stringify(flag)}`).join('\n')}\nexample: ${entry.example}\n`
}

export function helpCommand(args: string[], prefixHelp = false): HelpCommand | undefined {
  if (args[0] === 'setup' && args.includes('--help')) {
    const path = args.filter(arg => arg !== '--help')
    for (let index = 1; index < path.length; index++) {
      if (path[index] === '--host' && ['claude', 'codex', 'opencode', 'pi'].includes(path[index + 1])) index++
      else if (path[index] !== '--hook' && path[index] !== '--force') return undefined
    }
    return 'setup'
  }
  if (args[0] === 'falcon-axi' || args[0] === 'vectra-axi' || args[0] === 'ldap-axi') return prefixHelp && args.length === 2 ? args[0] : undefined
  if (args[0] === 'login' || args[0] === 'passwd') {
    if (args[0] === 'login' && args.length === 3 && args.includes('--sso') && args.includes('--help')) return 'login'
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
