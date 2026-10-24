import { ArtiumError } from '../../shared/errors.js'

export function invalidCommand(tool: string, args: readonly string[], commands: readonly string[]): ArtiumError {
  const flagIndex = args.findIndex(arg => arg.startsWith('-'))
  const words = args.slice(0, flagIndex < 0 ? args.length : flagIndex).join(' ')
  const children = commands.filter(command => command.startsWith(words + ' '))
  return new ArtiumError('INVALID_INPUT', `${children.length ? 'Incomplete' : 'Unknown'} command ${JSON.stringify(words)} for ${tool}.`,
    children.length ? `Use a supported subcommand, for example: artium-axi ${tool} ${children[0]}. Run artium-axi tools show ${tool} for supported commands.`
      : `Run artium-axi tools show ${tool} for supported commands.`)
}

export function unknownFlag(tool: string, command: string, flag: string, flags: readonly string[]): ArtiumError {
  return new ArtiumError('INVALID_INPUT', `Unknown flag ${flag.split('=')[0]} for ${tool} ${command}.`,
    `Valid flags: ${flags.map(name => `--${name}`).join(', ')}. Run artium-axi ${tool} ${command} --help.`)
}
