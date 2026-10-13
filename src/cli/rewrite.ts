import { decode, encode } from '@toon-format/toon'
import az from '../../tools/inventories/az-axi.json' with { type: 'json' }

type Span = { start: number, raw: string, value: string, quoted: boolean }

// The pinned inventories record only the root help field as suggestions.
export function rewriteSuggestions(output: string, tool: string, truncated = false): string {
  if (truncated) return output
  if (tool === 'az-axi' && /^(?:Command: )?(?:artium-axi )?az-axi(?:\s|$)/.test(output)) return azureHelp(output)
  let spans: Span[]
  try { spans = output.trimStart().startsWith('{') ? jsonHelp(output) : toonHelp(output) }
  catch { return output }
  if (tool === 'az-axi') {
    for (const span of [...spans].reverse()) {
      const value = azureHelp(span.value)
      if (value === span.value) continue
      output = output.slice(0, span.start) + (span.quoted ? JSON.stringify(value) : value) + output.slice(span.start + span.raw.length)
    }
    spans = output.trimStart().startsWith('{') ? jsonHelp(output) : toonHelp(output)
  }
  if (spans.some(span => /\\[`'"]/.test(span.value))) return output
  const insertions = new Set<number>()
  const removals = new Map<number, number>()
  for (const span of spans) {
    const offsets: number[] = []
    let rawIndex = span.quoted ? 1 : 0
    for (let index = 0; index < span.value.length; index++) {
      offsets.push(rawIndex)
      rawIndex += span.quoted && span.raw[rawIndex] === '\\' ? (span.raw[rawIndex + 1] === 'u' ? 6 : 2) : 1
    }
    offsets.push(rawIndex)
    function commandEdit(start: number, end: number, wrapped: boolean): void {
      if (!wrapped) insertions.add(span.start + offsets[start])
      if (tool !== 'az-axi') return
      const command = span.value.slice(start, end)
      const tokens = [...command.matchAll(/(?:[^\s'"]+|'[^']*'|"(?:\\.|[^"\\])*")+/g)]
      for (let index = 1; index < tokens.length; index++) {
        const token = tokens[index]
        if (token[0] === '--') break
        if (!token[0].startsWith('--') || !az.adapterBoundary.unsafeOverrides.includes(token[0].split('=')[0].slice(2))) continue
        const last = token[0].includes('=') ? token : tokens[++index]
        if (!last) continue
        const from = start + token.index! - 1
        const to = start + last.index! + last[0].length
        removals.set(span.start + offsets[from], span.start + offsets[to])
      }
    }
    // A command starts a suggestion line or a complete quoted command.
    const commands = /(?:^|\n)[ \t]*(?:Run |Use )?([`'"]?)([^\n]*)/g
    const commandRanges: [number, number][] = []
    for (const match of span.value.matchAll(commands)) {
      const quote = match[1]
      const command = match[2]
      if (!quote && /^(?:artium-axi )?\S+-axi(?:\s|$)/.test(command)) commandRanges.push([match.index!, match.index! + match[0].length])
      const wrapped = command.startsWith(`artium-axi ${tool}`)
      const executable = wrapped ? `artium-axi ${tool}` : tool
      const remainder = command.slice(executable.length)
      if (!command.startsWith(executable) || !(remainder === '' || /^\s/.test(remainder) || (quote && remainder.startsWith(quote)))) continue
      if (quote && !command.includes(quote)) return output
      const start = match.index! + match[0].length - command.length
      commandRanges.push([match.index!, quote ? start + command.indexOf(quote) + 1 : match.index! + match[0].length])
      commandEdit(start, quote ? start + command.indexOf(quote) : start + command.length, wrapped)
    }
    for (const match of span.value.matchAll(/(?<![^\s(])([`'"])([^\n]*?)(\1|(?=\n|$))/g)) {
      if (commandRanges.some(([start, end]) => match.index! >= start && match.index! < end)) continue
      if (!/^(?:artium-axi )?[^\s`'"]+-axi(?:\s|$)/.test(match[2])) return output
      const preceding = span.value.slice(0, match.index!)
      if (!/(?:^|\n|\S[`'"])[ \t]*(?:(?:Run|Use|run|use|Verify with|If you're unsure, run|Check current state before trying again:|or(?:, if you're unsure, run)?)[ \t]+)?$/.test(preceding)) return output
      const wrapped = match[2].startsWith(`artium-axi ${tool}`)
      const executable = wrapped ? `artium-axi ${tool}` : tool
      if (match[2].startsWith(executable) && /^(?:\s|$)/.test(match[2].slice(executable.length))) {
        if (!match[3]) return output
        commandEdit(match.index! + 1, match.index! + 1 + match[2].length, wrapped)
      }
    }
  }
  for (const offset of [...new Set([...insertions, ...removals.keys()])].sort((a, b) => b - a)) {
    output = output.slice(0, offset) + (insertions.has(offset) ? 'artium-axi ' : '') + output.slice(removals.get(offset) ?? offset)
  }
  return output
}

function azureHelp(help: string): string {
  const selectors = az.adapterBoundary.unsafeOverrides.join('|')
  return help.replace(/^((?:Flags|Globals|Selector flags on every command|Valid flags for `[^`]+`): )([^\r\n]*)/gm,
    (_, label: string, flags: string) => {
      const retained = flags.split(', ').filter(flag => !az.adapterBoundary.unsafeOverrides.includes(/^--([\w-]+)/.exec(flag)?.[1] ?? '')).join(', ')
      return label + retained + (flags.endsWith('.') && !retained.endsWith('.') ? '.' : '')
    }).replace(/^(?:(?:artium-axi )?az-axi\b|Examples:)[^\r\n]*/gm, line => line.replace(
      new RegExp(` ?\\[--(?:${selectors})\\s+<[^>]+>\\]|\\s+--(?:${selectors})\\s+(?:<[^>]+>|'[^']*'|"(?:\\\\.|[^"\\\\])*"|[^\\s;'\"]+)`, 'g'), ''))
    .replace(/^(?:(?:Command|Native operation|Examples): )?az-axi(?=\s|$)/gm, command => command.replace('az-axi', 'artium-axi az-axi'))
    .replace(/^Examples:[^\r\n]*/gm, line => line.replace(/'[^']*'|"(?:\\.|[^"\\])*"|(; )az-axi(?=\s|$)/g,
      (match, separator) => separator ? '; artium-axi az-axi' : match))
    .replace(/`az-axi(?=\s|`)([^\r\n`]*`)/g, '`artium-axi az-axi$1')
}

function jsonHelp(output: string): Span[] {
  const parsed = JSON.parse(output)
  if (typeof parsed.help !== 'string' && !(Array.isArray(parsed.help) && parsed.help.every((item: unknown) => typeof item === 'string'))) return []
  const tokens = [...output.matchAll(/"(?:\\[\s\S]|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\]:,]/g)]
  const spans: Span[] = []
  let index = 0
  let helpFields = 0
  function value(help = false, root = false): void {
    const token = tokens[index++]
    if (token[0] === '{') {
      while (tokens[index][0] !== '}') {
        const key = JSON.parse(tokens[index++][0])
        index++ // colon
        if (root && key === 'help') helpFields++
        value(root && key === 'help')
        if (tokens[index][0] === ',') index++
      }
      index++
    } else if (token[0] === '[') {
      while (tokens[index][0] !== ']') {
        value(help)
        if (tokens[index][0] === ',') index++
      }
      index++
    } else if (help && token[0].startsWith('"')) {
      spans.push({ start: token.index!, raw: token[0], value: JSON.parse(token[0]), quoted: true })
    }
  }
  value(false, true)
  return helpFields === 1 ? spans : []
}

function toonHelp(output: string): Span[] {
  const lines = [...output.matchAll(/[^\r\n]*(?:\r\n|\n|$)/g)].filter(line => line[0])
  const spans: Span[] = []
  const validation = lines.map(line => line[0].replace(/\r?\n$/, ''))
  let helpFields = 0
  function scalar(raw: string, start: number): void {
    const parsed = decode(`value: ${raw}`) as { value: unknown }
    if (typeof parsed.value !== 'string') throw new Error('Unknown suggestion format')
    const quoted = raw.startsWith('"')
    if (quoted && JSON.parse(raw) !== parsed.value) throw new Error('Unknown escaping')
    spans.push({ start, raw, value: parsed.value, quoted })
  }
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index][0].replace(/\r?\n$/, '')
    const field = /^(?:help|"help")(?:(\[\d+\]))?:[ \t]*(.*)$/.exec(text)
    if (!field) continue
    const count = field[1] ? Number(field[1].slice(1, -1)) : 0
    if (field[1] && !field[2]) {
      for (const line of lines.slice(index + 1, index + count + 1)) {
        if (!/^  -(?:[ \t\r\n]|$)/.test(line[0])) continue
        const parsed = decode(`value[1]:\n${line[0]}`) as { value: unknown[] }
        if (typeof parsed.value[0] !== 'string') throw new Error('Unknown suggestion item')
      }
    }
    helpFields++
    validation[index] = 'help: ""'
    if (!field[1]) {
      scalar(field[2], lines[index].index! + text.length - field[2].length)
      continue
    }
    if (field[2]) {
      const raw = field[2]
      let cursor = 0
      let items = 0
      while (cursor < raw.length) {
        while (/[ \t]/.test(raw[cursor] ?? '')) cursor++
        const start = cursor
        if (raw[cursor] === '"') {
          const quoted = /^"(?:\\[\s\S]|[^"\\])*"/.exec(raw.slice(cursor))
          if (!quoted) throw new Error('Incomplete inline suggestion')
          cursor += quoted[0].length
        } else {
          const comma = raw.indexOf(',', cursor)
          cursor = comma === -1 ? raw.length : comma
        }
        scalar(raw.slice(start, cursor).trimEnd(), lines[index].index! + text.length - raw.length + start)
        items++
        while (/[ \t]/.test(raw[cursor] ?? '')) cursor++
        if (cursor < raw.length && raw[cursor++] !== ',') throw new Error('Unknown inline suggestion')
        if (cursor === raw.length && raw.endsWith(',')) throw new Error('Incomplete inline suggestion')
      }
      if (items !== count) throw new Error('Incomplete suggestions')
      continue
    }
    for (let item = 0; item < count; item++) {
      index++
      const line = lines[index]
      if (!line) throw new Error('Incomplete suggestions')
      const row = /^  (?:- )?(\S[^\r\n]*)(?:\r?\n)?$/.exec(line[0])
      if (!row) throw new Error('Unknown suggestion item')
      scalar(row[1], line.index! + line[0].indexOf(row[1]))
      validation[index] = ''
    }
    if (lines[index + 1]?.[0].startsWith(' ')) throw new Error('Extra suggestion rows')
  }
  const document = validation.filter(line => line !== '').join('\n')
  if (encode(decode(document)) !== document) throw new Error('Unknown document structure')
  return helpFields === 1 ? spans : []
}
