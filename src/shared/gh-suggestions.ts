import inventory from '../../tools/inventories/gh-axi.json' with { type: 'json' }

export function rewriteGhSuggestions(output: string, invocation?: { command: string, help: boolean }, truncated = false): string {
  if (!invocation || invocation.help || invocation.command === 'api' || truncated) return output
  return output.replace(/(^|\n)help\[(\d+)\]:\n((?:  [^\n]*\n)*  [^\n]*)(?=\n|$)/g, (block, prefix: string, count: string, body: string) => {
    const rows = body.trimEnd().split('\n')
    if (rows.length !== Number(count)) return block
    const help = rows.flatMap(row => {
      let allowed = true
      const line = row.replace(/`(?:artium-axi )?gh-axi ([^`]+)`/g, (_, command: string) => {
        const route = inventory.commands.find(route => command === route.command || command.startsWith(route.command + ' '))
        const flags = [...command.matchAll(/(?:^|\s)(--[a-z][a-z-]*|-R)(?==|\s|$)/g)].map(match => match[1])
        if (!route || route.command === 'api' || /https?:\/\//.test(command)
          || flags.some(flag => !Object.hasOwn(route.flags, flag === '-R' ? 'repo' : flag.slice(2)))
          || route.repository && !flags.some(flag => flag === '-R' || flag === '--repo')) allowed = false
        return `\`artium-axi gh-axi ${command}\``
      })
      if (!allowed || /\bgh-axi\b|\bgh auth\b|\bGH_[A-Z_]+\b/.test(line.replaceAll('artium-axi gh-axi', ''))) return []
      return [line]
    })
    return help.length ? `${prefix}help[${help.length}]:\n${help.join('\n')}` : ''
  })
}
