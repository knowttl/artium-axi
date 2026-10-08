export interface SensitiveArguments {
  flags: readonly string[]
  positions: readonly number[]
}

const maximumArgumentLength = 512

function safeText(value: string): string {
  const escaped = value.replace(/[\x00-\x1f\x7f-\x9f]/g, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
  return escaped.length > maximumArgumentLength ? `${escaped.slice(0, maximumArgumentLength - 3)}...` : escaped
}

// Positions refer to the original caller arguments, never credential-injected arguments.
export function redactArguments(args: readonly string[], sensitive: SensitiveArguments): string[] {
  let hideNext = false
  return args.slice(0, 64).map((argument, index) => {
    const equals = argument.indexOf('=')
    const flag = equals < 0 ? argument : argument.slice(0, equals)
    const sensitiveFlag = sensitive.flags.includes(flag)
    const hide = hideNext || sensitive.positions.includes(index)
    hideNext = !hide && sensitiveFlag && equals < 0
    if (hide) return '[redacted]'
    if (sensitiveFlag && equals >= 0) return `${safeText(flag)}=[redacted]`
    return safeText(argument)
  })
}
