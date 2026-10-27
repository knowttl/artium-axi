import { decode, encode } from '@toon-format/toon'
import az from '../../tools/inventories/az-axi.json' with { type: 'json' }
import falcon from '../../tools/inventories/falcon-axi.json' with { type: 'json' }
import vectra from '../../tools/inventories/vectra-axi.json' with { type: 'json' }
import mg from '../../tools/inventories/mg-axi.json' with { type: 'json' }
import ldap from '../../tools/inventories/ldap-axi.json' with { type: 'json' }
import ado from '../../tools/inventories/ado-axi.json' with { type: 'json' }
import awx from '../../tools/inventories/awx-axi.json' with { type: 'json' }
import tenable from '../../tools/inventories/tenable-axi.json' with { type: 'json' }
import hybrid from '../../tools/inventories/hybrid-axi.json' with { type: 'json' }
import checkpoint from '../../tools/inventories/checkpoint-axi.json' with { type: 'json' }

const managedFlags: Record<string, string[]> = {
  'checkpoint-axi': checkpoint.adapterBoundary.unsafeOverrides,
  'hybrid-axi': hybrid.adapterBoundary.unsafeOverrides,
  'tenable-axi': tenable.adapterBoundary.unsafeOverrides,
  'awx-axi': awx.adapterBoundary.unsafeOverrides,
  'falcon-axi': falcon.unsafeOverrides,
  'vectra-axi': vectra.adapterBoundary.unsafeOverrides,
  'az-axi': az.adapterBoundary.unsafeOverrides,
  'mg-axi': mg.adapterBoundary.unsafeOverrides,
  'ldap-axi': ldap.adapterBoundary.unsafeOverrides,
  'ado-axi': ado.adapterBoundary.unsafeOverrides,
}

type Span = { start: number, raw: string, value: string, quoted: boolean }
type Help = { spans: Span[], document: { code?: unknown, error?: { code?: unknown }, description?: unknown, commands?: unknown } }
const ldapHelp = /^(?:Read Active Directory and LDAPv3 directories\.|(?:entry (?:search|show)|auth status) |Usage: (?:artium-axi )?ldap-axi )/m
const ldapCommands = ldap.commands.filter(route => route.command !== 'home').map(route => route.command)
const ldapCredentialGuidance = 'Artium uses stored simple-bind credentials over verified LDAPS or StartTLS; an administrator manages the connection. Ambient Kerberos tickets and keytabs are not used.'

export function rewriteDiscoveryHelp(help: string | typeof vectra.discovery.help, tool: string): string {
  const flags = managedFlags[tool]
  if (typeof help === 'string') return hostedHelp(help, tool, flags, true)
  return JSON.stringify({
    ...help,
    command: hostedHelp(help.command, tool, flags, true),
    flags: Object.fromEntries(Object.entries(help.flags).filter(([flag]) => !flags.includes(/^--([\w-]+)/.exec(flag)?.[1] ?? ''))),
    examples: help.examples.map(example => hostedHelp(example, tool, flags, true)),
  })
}

// The pinned inventories record only the root help field as suggestions.
export function rewriteSuggestions(output: string, tool: string, truncated = false): string {
  if (truncated) return output
  if (tool === 'checkpoint-axi') {
    try {
      const document = decode(output) as { command?: string, flags?: Record<string, unknown>, examples?: string[], bin?: string, commands?: unknown }
      if (document.command && document.flags) return encode({ ...document,
        command: document.command.startsWith('artium-axi ') ? document.command : `artium-axi checkpoint-axi ${document.command}`,
        flags: Object.fromEntries(Object.entries(document.flags).filter(([name]) => !checkpoint.adapterBoundary.unsafeOverrides.includes(name.replace(/^--/, '')))),
        examples: (document.examples ?? []).filter(example => !/--(?:config|profile|out)\b/.test(example))
          .map(example => example.replace(/^checkpoint-axi\b/, 'artium-axi checkpoint-axi')),
        help: [checkpoint.discovery.help.replaceAll('checkpoint-axi ', 'artium-axi checkpoint-axi ')] }) + '\n'
      if (document.bin || document.commands) return encode({ bin: 'artium-axi checkpoint-axi',
        description: 'Investigate Check Point Email Security with managed credentials.',
        commands: checkpoint.commands.filter(route => route.effect !== 'blocked').map(route => route.command),
        help: [checkpoint.discovery.help.replaceAll('checkpoint-axi ', 'artium-axi checkpoint-axi ')] }) + '\n'
    } catch { /* Other output uses the normal suggestion contract below. */ }
  }
  if (tool === 'hybrid-axi') {
    try {
      const document = decode(output) as { command?: string, flags?: Record<string, unknown>, examples?: string[] }
      if (document.command && document.flags && hybrid.commands.some(route => route.command === document.command)) {
        return encode({ ...document, command: document.command.startsWith('artium-axi ') ? document.command : `artium-axi hybrid-axi ${document.command}`,
          flags: Object.fromEntries(Object.entries(document.flags).filter(([name]) => !hybrid.adapterBoundary.unsafeOverrides.includes(name.slice(2)))),
          examples: (document.examples ?? []).filter(example => !/--(?:config|profile|origin|output)\b/.test(example))
            .map(example => example.replace(/^hybrid-axi\b/, 'artium-axi hybrid-axi')),
          help: [hybrid.discovery.help.replaceAll('hybrid-axi ', 'artium-axi hybrid-axi ')] }) + '\n'
      }
    } catch { /* Other output uses the normal suggestion contract below. */ }
  }
  if (tool === 'awx-axi') {
    const diagnostic = /^(awx: [^;\n]+); Run `awx-axi auth (login|status)` (?:to configure credentials|to check configuration and access)\n$/.exec(output)
    if (diagnostic) return `${diagnostic[1]}; ${diagnostic[2] === 'login'
      ? 'Ask an administrator to update the managed credential'
      : 'Run `artium-axi awx-axi auth status` to check configuration and access'}\n`
    if (/^(?:job_stdout|ad_hoc_stdout):\n/.test(output)) {
      const footer = /\nhelp\[2\]: [^\n]*(?:\n)?$/.exec(output)
      return footer ? output.slice(0, footer.index + 1) + rewriteSuggestions(output.slice(footer.index + 1), tool) : output
    }
  }
  if (tool === 'awx-axi' && output.startsWith('bin: awx-axi\n')) {
    return encode({ bin: 'artium-axi awx-axi', description: 'Inspect AWX automation with managed credentials.',
      usage: 'artium-axi awx-axi <command> [args] [flags]', commands: awx.discovery.commands,
      help: [awx.discovery.help] }) + '\n'
  }
  if (tool === 'awx-axi' && /^(?:auth: authenticate against the controller\nusage: awx-axi auth |usage: awx-axi doctor(?: |\n))/.test(output)) {
    return hostedHelp(`awx-axi ${output.startsWith('auth:') ? 'auth status' : 'doctor'}\n`, tool, managedFlags[tool], true)
  }
  const awxGroup = tool === 'awx-axi' && /^([a-z-]+): [^\n]+\n\nSubcommands:\n/.exec(output)?.[1]
  if (awxGroup && awx.discovery.commands.includes(awxGroup)) {
    return encode({ command: `artium-axi awx-axi ${awxGroup}`,
      commands: awx.commands.filter(route => route.effect !== 'blocked' && route.command.startsWith(awxGroup + ' ')).map(route =>
        `artium-axi awx-axi ${route.command}${route.positionals.names.map(name => ` <${name}>`).join('')}`),
      help: ['Run a command with --help for its flags.', awx.discovery.help] }) + '\n'
  }
  const flags = managedFlags[tool]
  if (!flags) return output
  const executable = new RegExp(`^(?:artium-axi |npx -y @knowttl/)?${tool}(?=\\s|$)`)
  if (executable.test(output.replace(/^[ \t]*(?:(?:Command|Native operation|Examples|Usage): )?/, ''))
    || tool === 'ldap-axi' && ldapHelp.test(output)) return hostedHelp(output, tool, flags, true)
  let spans: Span[]
  let unknownOutcome = false
  try {
    const json = output.trimStart().startsWith('{')
    let parsed = json ? jsonHelp(output) : toonHelp(output)
    if (tool === 'hybrid-axi' && parsed.document.commands) {
      return encode({ description: 'Investigate Hybrid Analysis with a managed API key.',
        commands: hybrid.commands.filter(route => route.effect !== 'blocked').map(route => route.command),
        help: [hybrid.discovery.help.replaceAll('hybrid-axi ', 'artium-axi hybrid-axi ')] }) + '\n'
    }
    if (tool === 'tenable-axi' && parsed.document.commands) {
      return encode({ description: 'Investigate Tenable One with managed API keys.',
        commands: tenable.commands.filter(route => route.effect !== 'blocked').map(route => route.command),
        help: [tenable.discovery.help.replaceAll('tenable-axi ', 'artium-axi tenable-axi ')] }) + '\n'
    }
    if (tool === 'ldap-axi' && parsed.document.description === 'Read Active Directory and LDAPv3 directories safely with ldap-axi (read-only)'
      && Array.isArray(parsed.document.commands) && parsed.spans.length) {
      const home = { ...parsed.document, commands: parsed.document.commands.filter(command => ldapCommands.includes(command)),
        help: [...parsed.spans.map(span => span.value).filter(value => !/^(?:Authentication auto selects|Set LDAP_AXI_URL)/.test(value)
          && value !== ldapCredentialGuidance), ldapCredentialGuidance] }
      output = (json ? JSON.stringify(home) : encode(home)) + '\n'
      parsed = json ? jsonHelp(output) : toonHelp(output)
    }
    const { spans: suggestions, document } = parsed
    spans = suggestions
    if (tool === 'az-axi') {
      unknownOutcome = document?.code === 'UNKNOWN_OUTCOME' || document?.error?.code === 'UNKNOWN_OUTCOME'
    }
  }
  catch { return output }
  for (const span of [...spans].reverse()) {
    const value = hostedHelp(span.value, tool, flags, /^[ \t]*(?:Command|Native operation|Examples|Usage):/m.test(span.value))
    if (value === span.value) continue
    output = output.slice(0, span.start) + (span.quoted || ['ldap-axi', 'ado-axi', 'awx-axi'].includes(tool) && /[,\r\n]/.test(value) ? JSON.stringify(value) : value) + output.slice(span.start + span.raw.length)
  }
  spans = (output.trimStart().startsWith('{') ? jsonHelp(output) : toonHelp(output)).spans
  if (spans.some(span => /\\[`'"]/.test(span.value))) return output
  const insertions = new Map<number, string>()
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
      const command = span.value.slice(start, end)
      if (!wrapped) {
        insertions.set(span.start + offsets[start], 'artium-axi ')
        if (command.startsWith('npx -y @knowttl/')) removals.set(span.start + offsets[start], span.start + offsets[start + 'npx -y @knowttl/'.length])
      }
      const tokens = [...command.matchAll(/(?:[^\s'"]+|'[^']*'|"(?:\\.|[^"\\])*")+/g)]
      if (unknownOutcome && /(?:Check current state before trying again:|Verify with)\s+[`'"]?$/.test(span.value.slice(0, start)) &&
        /^(?:artium-axi )?az-axi api GET\s/.test(command) && !tokens.some(token => /^--full(?:=|$)/.test(token[0]))) {
        insertions.set(span.start + offsets[end], ' --full')
      }
      for (const [from, to] of managedFlagRanges(command, tool)) {
        removals.set(span.start + offsets[start + from], span.start + offsets[start + to])
      }
    }
    // A command starts a suggestion line or a complete quoted command.
    const commands = /(?:^|\n)[ \t]*(?:Run |Use )?([`'"]?)([^\n]*)/g
    const commandRanges: [number, number][] = []
    for (const match of span.value.matchAll(commands)) {
      const quote = match[1]
      const command = match[2]
      if (!quote && /^(?:artium-axi |npx -y @knowttl\/)?\S+-axi(?:\s|$)/.test(command)) commandRanges.push([match.index!, match.index! + match[0].length])
      const wrapped = command.startsWith(`artium-axi ${tool}`)
      if (!executable.test(quote ? command.split(quote)[0] : command)) continue
      if (quote && !command.includes(quote)) return output
      const start = match.index! + match[0].length - command.length
      commandRanges.push([match.index!, quote ? start + command.indexOf(quote) + 1 : match.index! + match[0].length])
      commandEdit(start, quote ? start + command.indexOf(quote) : start + command.length, wrapped)
    }
    for (const match of span.value.matchAll(/(?<![^\s(])([`'"])([^\n]*?)(\1|(?=\n|$))/g)) {
      if (commandRanges.some(([start, end]) => match.index! >= start && match.index! < end)) continue
      const preceding = span.value.slice(0, match.index!)
      if (/(?:^|\n)[ \t]*[Vv]alid flags for $/.test(preceding) && match[1] === '`' && match[3] === '`') continue
      if (!/^(?:artium-axi |npx -y @knowttl\/)?[^\s`'"]+-axi(?:\s|$)/.test(match[2])) return output
      if (!/(?:^|\n|\S[`'"])[ \t]*(?:(?:Run|Use|run|use|Verify with|If you're unsure, run|Check current state before trying again:|or(?:, if you're unsure, run)?)[ \t]+)?$/.test(preceding)) return output
      const wrapped = match[2].startsWith(`artium-axi ${tool}`)
      if (executable.test(match[2])) {
        if (!match[3]) return output
        commandEdit(match.index! + 1, match.index! + 1 + match[2].length, wrapped)
      }
    }
  }
  for (const offset of [...new Set([...insertions.keys(), ...removals.keys()])].sort((a, b) => b - a)) {
    output = output.slice(0, offset) + (insertions.get(offset) ?? '') + output.slice(removals.get(offset) ?? offset)
  }
  return output
}

function managedFlagRanges(command: string, tool: string): [number, number][] {
  const tokens = [...command.matchAll(/(?:[^\s;'"`]+|'[^']*'|"(?:\\.|[^"\\])*")+|;/g)]
  const ranges: [number, number][] = []
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index]
    if (token[0] === '--') break
    const name = token[0].split('=')[0].slice(2)
    if (!token[0].startsWith('--') || !managedFlags[tool].includes(name)) continue
    const boolean = tool === 'falcon-axi' && falcon.commands.some(command => (command.flags as Record<string, string | undefined>)[name] === 'boolean')
      || tool === 'ldap-axi' && ldap.commands.some(command => (command.flags as Record<string, string | undefined>)[name] === 'boolean')
    const last = token[0].includes('=') || boolean ? token : tokens[++index]
    if (last) ranges.push([token.index! - 1, last.index! + last[0].length])
  }
  return ranges
}

function hostedHelp(help: string, tool: string, flags: string[], commands: boolean): string {
  if (tool === 'checkpoint-axi') {
    help = help.split('\n').filter(line => !/CHECKPOINT_AXI_|SecretRef|checkpoint-axi (?:config|profile)|Valid commands:/.test(line)).join('\n')
    if (!help.trim()) help = checkpoint.discovery.help
  }
  if (tool === 'hybrid-axi') {
    help = help.split('\n').filter(line => !/HYBRID_AXI_|SecretRefs|hybrid-axi (?:setup|config|profile)|--(?:config|profile|origin|output)\b/.test(line)).join('\n')
    const guidance = 'Artium manages the API key and fixed origin. Submissions, YARA mutations, consuming matches and four reviewed archive downloads require independently selected administrator-enabled operations, native preview, execute, exact confirmation and journal. Quick scans transmit the supplied sample or URL. Use artium-axi download --help for authenticated one-shot CLI verified saving and live-malware warnings.'
    if (commands && !help.includes(guidance)) help = help.trimEnd() + '\n' + guidance + '\n'
  }
  if (tool === 'tenable-axi') {
    help = help.split('\n').filter(line => !/TENABLE_AXI_|SecretRefs|tenable-axi (?:setup|config|profile|hook)|export (?:attack|inventory) download/.test(line)).join('\n')
    const guidance = 'Artium manages both API keys and the fixed origin. Administrators enable write operations; native preview, execute, exact confirmation and journal gates remain required. Downloads are unavailable.'
    if (commands && !help.includes(guidance)) help = help.trimEnd() + '\n' + guidance + '\n'
  }
  if (tool === 'awx-axi') {
    const guidance = 'Artium manages the controller origin, verified TLS and token. Operational writes require administrator allowWrites and --confirm; configuration, deletion and security writes are blocked. No stdin or files. Ask an administrator to update the managed credential.'
    help = help.split('\n').filter(line => !/(?:\bAWX_AXI_[A-Z_]+\b|\bawx-axi (?:auth (?:login|logout)|setup|config|profile|update)\b|--(?:origin|profile|config|verify-ssl|allow-http)\b)/.test(line))
      .filter(line => !/^(?:Run|Use) .*\bawx-axi job stdout\b.*--download\b/.test(line))
      .map(line => (/^(?:artium-axi )?awx-axi job stdout\b/.test(line)
        ? line.replace(/ \[--(?:full|ansi)\]| \[--download <path>\]/g, '') : line)
        .replace(/^((?:artium-axi )?awx-axi job list\b[^\n]*) \[--fields <fields>\]/, '$1')
        .replace(/--timeout (?:600|3600)/g, '--timeout 50')).join('\n')
    if (!help.trim()) help = guidance
    else if (commands && !help.includes(guidance)) help = help.trimEnd() + '\n' + guidance + '\n'
  }
  if (tool === 'falcon-axi') {
    help = help.replace(new RegExp(`^  (?:${falcon.blockedCommands.join('|')})(?=\\s|$)[^\\r\\n]*(?:\\r?\\n|$)`, 'gm'), '')
  }
  if (tool === 'ado-axi') {
    const guidance = 'Artium manages the organization, profile, config and PAT. api accepts relative paths and GET only. Writes are off by default; administrators control allowWrites. No stdin or files. Use pipeline watch --timeout 50 or less.'
    if (/^(?:Usage: |(?:Run|Use) [`'"]?)?(?:artium-axi )?ado-axi api(?:\s|$)/.test(help)) {
      help = 'ado-axi api [GET] <relative-path> [--method GET] [--query <query>] [--api-version <version>] [--host dev|vsrm|vssps|almsearch] [--no-project] [--raw] [--limit <n>] [--full] [--fields <fields>]\n'
    }
    help = help.replace(/\n"built-in":\n[\s\S]*$/, '')
      .split('\n').filter(line => /^\s*(?:(?:Run|Use) [`'"]?|Usage: )?(?:artium-axi )?ado-axi (?!config\b|update\b)/.test(line)
        || !/(?:\bado-axi (?:config|update)\b|\baz (?:CLI )?login\b|\baz login\b|\bADO_[A-Z_]+\b|\bPAT\b.*\benv\b|stdin|piped|--profile|--org\b|--config\b)/i.test(line))
      .map(line => line.replace(/<path\|url>/g, '<relative-path>').replace(/--timeout 1800/g, '--timeout 50')
        .replace(/^([ \t]*MSYS_NO_PATHCONV=1 )ado-axi(?=\s|$)/, '$1artium-axi ado-axi')
        .replace('raw REST escape hatch for everything else', 'GET-only REST calls')
        .replace(/ \| config\b/g, '')).join('\n')
    if (!help.trim()) help = guidance
    else if (commands && !help.includes(guidance)) help = help.trimEnd() + '\n' + guidance + '\n'
  }
  const selectors = flags.join('|')
  if (tool === 'ldap-axi' && !commands && !/^(?:Run|Use) [`'"]?(?:artium-axi )?ldap-axi\b/.test(help)) {
    help = help.replace(new RegExp(`^(?:Use |Pass |Set |Or use |The search base may)[^\\r\\n]*(?:--(?:${selectors})\\b|\\b(?:NODE_EXTRA_CA_CERTS|LDAP_AXI_[A-Z_]+)\\b)[^\\r\\n]*$`, 'gm'),
      'Ask an Artium administrator to update the stored LDAP credentials: use verified LDAPS or LDAP with startTls=true, and supply trusted CA PEM contents in caFile when required.')
  }
  if (tool === 'ldap-axi' && commands && ldapHelp.test(help)) {
    help = help.replace(/^(?:Authentication defaults to auto|Use --auth simple|Select configuration with|The URL scheme selects the GSSAPI transport|Use --tls-max-version)[^\r\n]*(?:\r?\n|$)/gm, '')
      .replace(/^Commands: [^\r\n]*/m, `Commands: ${ldapCommands.join(', ')}`)
      .replace(/^(entry (?:search|show)|auth status) /, 'Usage: ldap-axi $1 ')
      .replace(/^Example: /gm, 'Examples: ')
    if (!help.includes(ldapCredentialGuidance)) help = help.trimEnd() + '\n' + ldapCredentialGuidance + '\n'
  }
  const filtered = help.replace(/^([ \t]*(?:(?:Flags|Globals|Global flags|Selector flags on every command|[Vv]alid flags for `[^`]+`): |(?=--)))([^\r\n]*)(\r?\n|$)/gm,
    (_, label: string, listed: string, ending: string) => {
      const entries = label.trim() || /^--[\w-]+(?: <[^>]+>)?(?:, --[\w-]+(?: <[^>]+>)?)*\.?$/.test(listed) ? listed.split(', ') : [listed]
      const retained = entries.filter(flag => !flags.includes(/^--([\w-]+)/.exec(flag)?.[1] ?? '')).join(', ')
      if (!retained && !label.trim()) return ''
      return label + retained + (listed.endsWith('.') && !retained.endsWith('.') ? '.' : '') + ending
    })
  if (!commands) return filtered
  return filtered.replace(new RegExp(`^[ \t]*(?:(?:(?:Command|Native operation|Usage): )?(?:artium-axi |npx -y @knowttl/)?${tool}\\b|Examples:)[^\\r\\n]*`, 'gm'), line => {
      line = line.replace(new RegExp(` ?\\[--(?:${selectors})\\s+<[^>]+>\\]`, 'g'), '')
      for (const [from, to] of managedFlagRanges(line, tool).reverse()) line = line.slice(0, from) + line.slice(to)
      return line
    })
    .replace(new RegExp(`^([ \t]*(?:(?:Command|Native operation|Examples|Usage): )?)(?:npx -y @knowttl/)?${tool}(?=\\s|$)`, 'gm'), `$1artium-axi ${tool}`)
    .replace(new RegExp(`^Run ${tool}(?=\\s|$)`, 'gm'), `Run artium-axi ${tool}`)
    .replace(/^[ \t]*Examples:[^\r\n]*/gm, line => line.replace(new RegExp(`'[^']*'|"(?:\\\\.|[^"\\\\])*"|(; )(?:npx -y @knowttl/)?${tool}(?=\\s|$)`, 'g'),
      (match, separator) => separator ? `; artium-axi ${tool}` : match))
    .replace(new RegExp('`(?:npx -y @knowttl/)?' + tool + '(?=\\s|`)([^\\r\\n`]*`)', 'g'), '`artium-axi ' + tool + '$1')
    .replace(new RegExp(`^([ \t]*cat [^\\r\\n|]+ \\| )(?:npx -y @knowttl/)?${tool}(?=\\s|$)`, 'gm'), `$1artium-axi ${tool}`)
    .replace(new RegExp(`\\buse ${tool} entry search\\b`, 'g'), `use artium-axi ${tool} entry search`)
}

function jsonHelp(output: string): Help {
  const parsed = JSON.parse(output)
  if (typeof parsed.help !== 'string' && !(Array.isArray(parsed.help) && parsed.help.every((item: unknown) => typeof item === 'string'))) return { spans: [], document: parsed }
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
  return { spans: helpFields === 1 ? spans : [], document: parsed }
}

function toonHelp(output: string): Help {
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
  const parsed = decode(document) as Help['document']
  if (encode(parsed) !== document) throw new Error('Unknown document structure')
  return { spans: helpFields === 1 ? spans : [], document: parsed }
}
