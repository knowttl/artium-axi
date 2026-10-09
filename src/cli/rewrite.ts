import { decode } from '@toon-format/toon'

type Span = { start: number, raw: string, value: string, quoted: boolean }

// The pinned inventories record only the root help field as suggestions.
export function rewriteSuggestions(output: string, tool: string, truncated = false): string {
  if (truncated) return output
  let spans: Span[]
  try { spans = output.trimStart().startsWith('{') ? jsonHelp(output) : toonHelp(output) }
  catch { return output }
  const insertions = new Set<number>()
  for (const span of spans) {
    const offsets: number[] = []
    let rawIndex = span.quoted ? 1 : 0
    for (let index = 0; index < span.value.length; index++) {
      offsets.push(rawIndex)
      rawIndex += span.quoted && span.raw[rawIndex] === '\\' ? (span.raw[rawIndex + 1] === 'u' ? 6 : 2) : 1
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
      if (wrapped) continue
      insertions.add(span.start + offsets[start])
    }
    for (const match of span.value.matchAll(/([`'"])([^\n]*?)(\1|(?=\n|$))/g)) {
      if (commandRanges.some(([start, end]) => match.index! >= start && match.index! < end)) continue
      const wrapped = match[2].startsWith(`artium-axi ${tool}`)
      const executable = wrapped ? `artium-axi ${tool}` : tool
      if (match[2].startsWith(executable) && /^(?:\s|$)/.test(match[2].slice(executable.length))) {
        if (!match[3]) return output
        if (wrapped) continue
        insertions.add(span.start + offsets[match.index! + 1])
      }
    }
  }
  for (const offset of [...insertions].sort((a, b) => b - a)) output = output.slice(0, offset) + 'artium-axi ' + output.slice(offset)
  return output
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
  const validation = lines.map(line => line[0])
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
    helpFields++
    if (!field[1]) {
      scalar(field[2], lines[index].index! + text.length - field[2].length)
      continue
    }
    const count = Number(field[1].slice(1, -1))
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
      // Pinned tools emit primitive list rows without TOON's list marker.
      validation[index] = `  - ${row[1]}\n`
    }
    if (lines[index + 1]?.[0].startsWith(' ')) throw new Error('Extra suggestion rows')
  }
  decode(validation.join(''))
  return helpFields === 1 ? spans : []
}
