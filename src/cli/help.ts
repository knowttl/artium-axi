import { toolSchema } from '../shared/api.js'

const commands = {
  home: { usage: 'artium-axi [tools [show <tool>]|whoami|login|passwd|logout|doctor|<tool> <args>]', purpose: 'Show your identity, roles and available tools.', flags: [], example: 'artium-axi' },
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
} as const

export type HelpCommand = keyof typeof commands

export function commandHelp(command: HelpCommand): string {
  const entry = commands[command]
  const flags = ['--help (default false)', ...entry.flags]
  return `usage: ${entry.usage}\npurpose: ${entry.purpose}\nflags[${flags.length}]:\n${flags.map(flag => `  ${JSON.stringify(flag)}`).join('\n')}\nexample: ${entry.example}\n`
}

// Tool arguments belong to upstream, including --help. Only Artium commands use this layout.
export function helpCommand(args: string[]): HelpCommand | undefined {
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
