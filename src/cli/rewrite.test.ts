import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { rewriteDiscoveryHelp, rewriteSuggestions } from './rewrite.js'
import { decode, encode } from '@toon-format/toon'
import { toolView } from './views.js'
import falcon from '../../tools/inventories/falcon-axi.json' with { type: 'json' }
import vectra from '../../tools/inventories/vectra-axi.json' with { type: 'json' }
import graph from '../../tools/inventories/mg-axi.json' with { type: 'json' }

test.each([
  { tool: 'vectra-axi', command: 'host list --name synthetic' },
  { tool: 'vectra-axi', command: 'detection show 42 --full' },
  { tool: 'vectra-axi', command: 'host close --id 7 --execute --confirm "host 7"' },
  { tool: 'vectra-axi', command: 'match enablement set --value true' },
  { tool: 'vectra-axi', command: 'group member set --id 8 --members-file members.json' },
  { tool: 'vectra-axi', command: 'setting syslog set --config-file export.json' },
  { tool: 'falcon-axi', command: 'search start --query "synthetic | head(5)" --wait 30' },
  { tool: 'falcon-axi', command: 'search status synthetic-job --wait 30' },
  { tool: 'falcon-axi', command: 'search stop synthetic-job' },
  { tool: 'falcon-axi', command: 'detection process synthetic-detection --full' },
  { tool: 'falcon-axi', command: 'process tree synthetic-process --full' },
  { tool: 'falcon-axi', command: 'sandbox list --sha256 ' + 'a'.repeat(64) },
  { tool: 'falcon-axi', command: 'file-change list --filter synthetic --limit 1' },
  { tool: 'falcon-axi', command: 'policy show synthetic-policy --type device-control' },
  { tool: 'falcon-axi', command: 'host usb ' + 'a'.repeat(32) + ' --since 24h' },
  { tool: 'falcon-axi', command: 'malquery search --hex "4d 5a" --fuzzy --limit 10' },
  { tool: 'falcon-axi', command: 'malquery status 00000000-0000-4000-8000-000000000001 --limit 10' },
])('$tool preserves the new command arguments in managed suggestions: $command', ({ tool, command }) => {
  const input = encode({ help: [`Run \`${tool} ${command}\``] })
  expect(rewriteSuggestions(input, tool)).toBe(encode({ help: [`Run \`artium-axi ${tool} ${command}\``] }))
})

test('Falcon discovery hosts every indented executable example', () => {
  const output = decode(toolView({ name: 'falcon-axi', status: 'ok', version: falcon.version })) as { upstreamHelp: string }
  const expected = falcon.discovery.help.replace(/^(\s*)falcon-axi/gm, '$1artium-axi falcon-axi')
  expect(output.upstreamHelp).toBe(expected)
  expect(rewriteDiscoveryHelp(output.upstreamHelp, 'falcon-axi')).toBe(expected)
})

test('Vectra discovery hosts command and examples while preserving other help fields', () => {
  const output = decode(toolView({ name: 'vectra-axi', status: 'ok', version: vectra.version })) as { upstreamHelp: string }
  const expected = { ...vectra.discovery.help, command: 'artium-axi vectra-axi detection list', examples: ['artium-axi vectra-axi detection list'] }
  expect(JSON.parse(output.upstreamHelp)).toEqual(expected)
  expect(rewriteDiscoveryHelp(expected, 'vectra-axi')).toBe(output.upstreamHelp)
})

test.each(['falcon-axi', 'vectra-axi', 'az-axi', 'mg-axi'].flatMap(tool =>
  ['', '  ', '\t'].flatMap(indent => ['', 'artium-axi ', 'npx -y @knowttl/'].map(prefix => ({ tool, indent, prefix })))))(
  '$tool plain help hosts indented commands with prefix "$prefix"', ({ tool, indent, prefix }) => {
    const input = `${indent}${prefix}${tool} home\n${indent}--profile <name>: Select a profile\n${indent}${prefix}${tool} home --profile artium --filter "--profile literal"\n`
    const expected = `${indent}artium-axi ${tool} home\n${indent}artium-axi ${tool} home --filter "--profile literal"\n`
    expect(rewriteSuggestions(input, tool)).toBe(expected)
    expect(rewriteSuggestions(expected, tool)).toBe(expected)
  })

test.each(['falcon-axi', 'vectra-axi', 'az-axi', 'mg-axi'].flatMap(tool =>
  [JSON.stringify, encode].flatMap(serialize => ['', 'artium-axi ', 'npx -y @knowttl/'].map(prefix => ({ tool, serialize, prefix })))))(
  '$tool strips managed selectors with prefix "$prefix"', ({ tool, serialize, prefix }) => {
    const input = serialize({ help: [`Run \`${prefix}${tool} home --profile=artium --help\``], data: '--profile=artium' })
    const expected = serialize({ help: [`Run \`artium-axi ${tool} home --help\``], data: '--profile=artium' })
    expect(rewriteSuggestions(input, tool)).toBe(expected)
    expect(rewriteSuggestions(expected, tool)).toBe(expected)
  })

test('Graph static tool help hides managed flags and hosts its examples', () => {
  const output = toolView({ name: 'mg-axi', status: 'ok', version: graph.version })
  expect(output).not.toMatch(/--(?:profile|config|scopes)\b/)
  expect(output).toContain('artium-axi mg-axi')
  expect(output).not.toMatch(/npx -y @knowttl\/mg-axi/)
})

test('Graph plain help strips managed flags while retaining literal filter text', () => {
  const input = 'mg-axi entra user list\n--profile <name>: Select a configured profile\n--scopes <scopes>: Graph scopes\n--config <path>: Configuration file override\n--limit <positive-integer>: Cap returned rows\nmg-axi entra user list --profile soc --limit 10\nmg-axi entra user list --profile=artium --filter "--profile artium"\n'
  const expected = 'artium-axi mg-axi entra user list\n--limit <positive-integer>: Cap returned rows\nartium-axi mg-axi entra user list --limit 10\nartium-axi mg-axi entra user list --filter "--profile artium"\n'
  expect(rewriteSuggestions(input, 'mg-axi')).toBe(expected)
  expect(rewriteSuggestions(expected, 'mg-axi')).toBe(expected)
})

test('Falcon managed booleans do not consume the following command flag', () => {
  const input = encode({ help: ['Run `falcon-axi host list --no-member-cid --limit 1`'] })
  expect(rewriteSuggestions(input, 'falcon-axi')).toBe(encode({ help: ['Run `artium-axi falcon-axi host list --limit 1`'] }))
})

test('LDAP per-flag help removes managed descriptions with comma-separated defaults', () => {
  const input = 'ldap-axi user show <name>\nFlags:\n  --base <dn>  Search base (default: configured base, otherwise root)\n  --fields <fields>  Output fields (default: dn, name)\n  --attributes <attributes>  LDAP attributes (default: cn, mail)\n  --config <path>  Configuration (default: environment, then platform config directory)\n  --start-tls  Upgrade transport (default: configured value, otherwise false)\n  --ca-file <path>  Trusted CA (default: environment, otherwise system)\n  --tls-max-version <version>  TLS cap (default: configured value, otherwise automatic)\n  --profile <name>  Profile (default: environment, otherwise default)\n  --gssapi-service <name>  Service (default: configured value, otherwise ldap)\n  --gssapi-protection <mode>  Protection (default: configured value, otherwise auto)\n'
  const expected = 'artium-axi ldap-axi user show <name>\nFlags:\n  --base <dn>  Search base (default: configured base, otherwise root)\n  --fields <fields>  Output fields (default: dn, name)\n  --attributes <attributes>  LDAP attributes (default: cn, mail)\n'
  expect(rewriteSuggestions(input, 'ldap-axi')).toBe(expected)
})

test.each(['json', 'toon'].flatMap(format => [false, true].map(multiline => ({ format, multiline }))))(
  'Graph $format validation headings preserve separate suggestions (multiline: $multiline)', ({ format, multiline }) => {
    const heading = 'Valid flags for `mg-axi entra user list`: --profile <name>, --scopes <scopes>, --config <path>, --limit <positive-integer>'
    const suggestion = 'Run `mg-axi entra user list --profile=artium --limit 1`'
    const expectedHeading = 'Valid flags for `mg-axi entra user list`: --limit <positive-integer>'
    const expectedSuggestion = 'Run `artium-axi mg-axi entra user list --limit 1`'
    const serialize = (help: string[]) => format === 'json' ? JSON.stringify({ help }) : encode({ help })
    const input = serialize(multiline ? [heading + '\n' + suggestion] : [heading, suggestion])
    const expected = serialize(multiline ? [expectedHeading + '\n' + expectedSuggestion] : [expectedHeading, expectedSuggestion])
    expect(rewriteSuggestions(input, 'mg-axi')).toBe(expected)
    expect(rewriteSuggestions(expected, 'mg-axi')).toBe(expected)
  })

test.each(['plain', 'json', 'toon'])('Falcon %s root help hides managed flags in grouped rows', format => {
  const input = 'falcon-axi 0.7.2\n  profile list   configured profiles\n  config path   configuration paths\n  setup hooks   local integrations\nGlobal flags:\n  --help, --region <name|url>, --allow-unknown-origin, --member-cid <cid>, --no-member-cid\n  --config <path>, --profile <name>\n'
  const expected = 'artium-axi falcon-axi 0.7.2\nGlobal flags:\n  --help\n'
  const serialize = (help: string) => format === 'plain' ? help : format === 'json' ? JSON.stringify({ help }) : encode({ help })
  expect(rewriteSuggestions(serialize(input), 'falcon-axi')).toBe(serialize(expected))
  expect(rewriteSuggestions(serialize(expected), 'falcon-axi')).toBe(serialize(expected))
})

test.each(['json', 'toon'])('Falcon %s validation help hides managed flags and preserves native errors', format => {
  const input = { code: 'VALIDATION_ERROR', help: ['valid flags for `detection list`: --help, --region, --allow-unknown-origin, --member-cid, --no-member-cid, --config, --profile, --limit'] }
  const expected = { code: 'VALIDATION_ERROR', help: ['valid flags for `detection list`: --help, --limit'] }
  const serialize = (value: typeof input) => format === 'json' ? JSON.stringify(value) : encode(value)
  expect(rewriteSuggestions(serialize(input), 'falcon-axi')).toBe(serialize(expected))
  expect(rewriteSuggestions(serialize(expected), 'falcon-axi')).toBe(serialize(expected))
})

test('Graph doctor suggestions use the hosted command without managed profile flags', () => {
  const input = encode({ help: [
    'Run `npx -y @knowttl/mg-axi entra user list --profile artium --limit 1`',
    'Run `mg-axi entra user list --profile artium --limit 1`',
  ] })
  const expected = encode({ help: [
    'Run `artium-axi mg-axi entra user list --limit 1`',
    'Run `artium-axi mg-axi entra user list --limit 1`',
  ] })
  expect(rewriteSuggestions(input, 'mg-axi')).toBe(expected)
  expect(rewriteSuggestions(expected, 'mg-axi')).toBe(expected)
})

test.each(['json', 'toon'].flatMap(format => [
  { format, code: 'UNKNOWN_OUTCOME', suffix: ' --full' }, { format, code: 'VALIDATION_ERROR', suffix: '' },
]))(
  '$format recovery adds full output only for $code', ({ format, code, suffix }) => {
    const recovery = 'Check current state before trying again: `az-axi api GET /subscriptions/synthetic --config /tmp/synthetic --profile artium --tenant synthetic`'
    const verify = 'Verify with `az-axi api GET /subscriptions/synthetic --config /tmp/synthetic --profile artium --tenant synthetic`'
    const normal = 'Run `az-axi api GET /subscriptions/synthetic`'
    const input = { code, help: [recovery, verify, normal], data: { help: recovery } }
    const serialized = format === 'json' ? JSON.stringify(input) : encode(input)
    const output = rewriteSuggestions(serialized, 'az-axi')
    const parsed = (format === 'json' ? JSON.parse(output) : decode(output)) as typeof input
    expect(parsed.help).toEqual([
      `Check current state before trying again: \`artium-axi az-axi api GET /subscriptions/synthetic${suffix}\``,
      `Verify with \`artium-axi az-axi api GET /subscriptions/synthetic${suffix}\``,
      'Run `artium-axi az-axi api GET /subscriptions/synthetic`',
    ])
    expect(parsed.data).toEqual(input.data)
    expect(rewriteSuggestions(output, 'az-axi')).toBe(output)
  })

test('Azure help prefixes executable examples while retaining literal arguments', () => {
  const input = "Command: az-axi api\nExamples: az-axi api GET /subscriptions --query 'az-axi=literal; az-axi sub list'; az-axi sub list\nSee `az-axi network nsg rule create --help`.\n"
  const expected = "Command: artium-axi az-axi api\nExamples: artium-axi az-axi api GET /subscriptions --query 'az-axi=literal; az-axi sub list'; artium-axi az-axi sub list\nSee `artium-axi az-axi network nsg rule create --help`.\n"
  expect(rewriteSuggestions(input, 'az-axi')).toBe(expected)
  expect(rewriteSuggestions(expected, 'az-axi')).toBe(expected)
})

test.each(['falcon-axi', 'vectra-axi', 'az-axi', 'mg-axi'].flatMap(tool =>
  ['plain', 'json', 'toon'].flatMap(format => ['Command', 'Native operation', 'Examples'].flatMap(label =>
    ['', 'npx -y @knowttl/'].map(prefix => ({ tool, format, label, prefix }))))))(
  '$tool hosts $label help in $format with prefix "$prefix"', ({ tool, format, label, prefix }) => {
    const input = `\t${label}: ${prefix}${tool} home --profile artium --limit 1`
    const expected = `\t${label}: artium-axi ${tool} home --limit 1`
    const serialize = (help: string) => format === 'plain' ? help : format === 'json' ? JSON.stringify({ help: [help], data: input }) : encode({ help: [help], data: input })
    const output = rewriteSuggestions(serialize(input), tool)
    expect(output).toBe(serialize(expected))
    expect(rewriteSuggestions(output, tool)).toBe(output)
  })

test.each(['json', 'toon'])('Azure structured %s examples host sibling commands while preserving literal arguments', format => {
  const help = "Flags: --profile, --subscription\nExamples: az-axi sub list --query 'az-axi=literal; az-axi sub list'; az-axi sub list --profile artium --subscription <id>"
  const expected = "Flags: --subscription\nExamples: artium-axi az-axi sub list --query 'az-axi=literal; az-axi sub list'; artium-axi az-axi sub list --subscription <id>"
  const serialize = (value: string) => format === 'json' ? JSON.stringify({ help: [value], data: help }) : encode({ help: [value], data: help })
  const output = rewriteSuggestions(serialize(help), 'az-axi')
  expect(output).toBe(serialize(expected))
  expect(rewriteSuggestions(output, 'az-axi')).toBe(output)
})

const captures = JSON.parse(readFileSync(new URL('../../test/fake-tool/fixtures/upstreams.json', import.meta.url), 'utf8')) as
  Record<string, Record<string, { stdout: string, stderr: string }>>

test.each(Object.entries(captures).flatMap(([tool, cases]) => Object.entries(cases).map(([name, capture]) =>
  ({ tool, name, ...capture }))))('$tool $name capture changes only its suggestion command', ({ tool, stdout, stderr }) => {
  const expected = stdout.replace(`Run \`${tool}`, `Run \`artium-axi ${tool}`)
  expect(rewriteSuggestions(stdout, tool)).toBe(expected)
  expect(rewriteSuggestions(expected, tool)).toBe(expected)
  expect(rewriteSuggestions(stderr, tool)).toBe(stderr)
})

test.each([
  ['help: falcon-axi host list\n', 'help: artium-axi falcon-axi host list\n'],
  ['help: Run `falcon-axi`\n', 'help: Run `artium-axi falcon-axi`\n'],
  ['help: falcon-axi host list --filter \'falcon-axi host show\'\n',
    'help: artium-axi falcon-axi host list --filter \'falcon-axi host show\'\n'],
  ['help[2]: "Verify with `falcon-axi host list --id \\"two,words\\"`",Run `vectra-axi host list`\n',
    'help[2]: "Verify with `artium-axi falcon-axi host list --id \\"two,words\\"`",Run `vectra-axi host list`\n'],
  ['help[1]: Run `falcon-axi host list`\n', 'help[1]: Run `artium-axi falcon-axi host list`\n'],
  ['help[1]:\n  - Run `falcon-axi host list`\n', 'help[1]:\n  - Run `artium-axi falcon-axi host list`\n'],
  ['help[2]:\n  - "-"\n  - "Run `falcon-axi host list` --filter -"\n',
    'help[2]:\n  - "-"\n  - "Run `artium-axi falcon-axi host list` --filter -"\n'],
  ['help[2]:\r\n  Run `falcon-axi host show --id "two words"`\r\n  Run `vectra-axi host list`\r\n',
    'help[2]:\r\n  Run `artium-axi falcon-axi host show --id "two words"`\r\n  Run `vectra-axi host list`\r\n'],
  ['help[1]:\n  - "Run `falcon-axi host list --filter \\"name\\"`\\nRun `falcon-axi host list`"\n',
    'help[1]:\n  - "Run `artium-axi falcon-axi host list --filter \\"name\\"`\\nRun `artium-axi falcon-axi host list`"\n'],
  ['{ "data": "falcon-axi host list", "help": ["Run \'falcon-axi host list\'", "falcon\\u002daxi host list\\nUse \\"falcon-axi host show\\""] }',
    '{ "data": "falcon-axi host list", "help": ["Run \'artium-axi falcon-axi host list\'", "artium-axi falcon\\u002daxi host list\\nUse \\"artium-axi falcon-axi host show\\""] }'],
  ['data:\n  help: falcon-axi host list\nhelp: "Run `falcon-axi host list`"\n',
    'data:\n  help: falcon-axi host list\nhelp: "Run `artium-axi falcon-axi host list`"\n'],
  ['help: Run `vectra-axi host list --filter \'falcon-axi host show\'` or `falcon-axi host list`\n',
    'help: Run `vectra-axi host list --filter \'falcon-axi host show\'` or `artium-axi falcon-axi host list`\n'],
])('preserves bytes around recognised suggestions: %s', (input, expected) => {
  expect(rewriteSuggestions(input, 'falcon-axi')).toBe(expected)
  expect(rewriteSuggestions(expected, 'falcon-axi')).toBe(expected)
})

const suggestionFormats = [
  { format: 'JSON scalar', encode: (value: string) => JSON.stringify({ help: value }) },
  { format: 'JSON list', encode: (value: string) => JSON.stringify({ help: [value] }) },
  { format: 'TOON scalar', encode: (value: string) => `help: ${value}\n` },
  { format: 'TOON quoted scalar', encode: (value: string) => `help: ${JSON.stringify(value)}\n` },
  { format: 'TOON list', encode: (value: string) => `help[1]:\n  ${JSON.stringify(value)}\n` },
  { format: 'TOON marked list', encode: (value: string) => `help[1]:\n  - ${JSON.stringify(value)}\n` },
  { format: 'TOON inline list', encode: (value: string) => `help[1]: ${JSON.stringify(value)}\n` },
]

test.each(suggestionFormats.flatMap(({ format, encode }) => ['Check current state before trying again:', 'Verify with'].map(prefix => ({ format, encode, prefix }))))(
  'unknown-outcome $prefix recovery uses full output in $format', ({ encode, prefix }) => {
    const value = `${prefix} \`az-axi api GET /subscriptions/synthetic\``
    const input = encode(value)
    const expected = encode(`${prefix} \`artium-axi az-axi api GET /subscriptions/synthetic --full\``)
    const document = input.startsWith('{') ? JSON.stringify({ ...JSON.parse(input), code: 'UNKNOWN_OUTCOME' }) : `code: UNKNOWN_OUTCOME\n${input}`
    const output = expected.startsWith('{') ? JSON.stringify({ ...JSON.parse(expected), code: 'UNKNOWN_OUTCOME' }) : `code: UNKNOWN_OUTCOME\n${expected}`
    expect(rewriteSuggestions(document, 'az-axi')).toBe(output)
    expect(rewriteSuggestions(output, 'az-axi')).toBe(output)
  })

test.each(suggestionFormats.flatMap(({ format, encode }) => ['`', "'", '"'].flatMap(quote =>
  ['', ...['`', "'", '"'].filter(outer => outer !== quote)].flatMap(outer =>
    ['', 'artium-axi '].flatMap(prefix => ['before', 'after', 'between'].map(position =>
      ({ format, encode, quote, outer, prefix, position })))))))(
  'preserves ambiguous commands in $format with $quote inside "$outer", prefix "$prefix", $position',
  ({ encode, quote, outer, prefix, position }) => {
    const ambiguous = `Run ${outer}echo ${quote}falcon-axi host list${quote}${outer}`
    const complete = `Run \`${prefix}falcon-axi host show\``
    const value = position === 'before' ? `${ambiguous} or ${complete}`
      : position === 'after' ? `${complete} or ${ambiguous}` : `${complete} or ${ambiguous} or ${complete}`
    const input = encode(value)
    const actual = rewriteSuggestions(input, 'falcon-axi')
    expect(actual).toBe(input)
    expect(rewriteSuggestions(actual, 'falcon-axi')).toBe(input)
    expect(rewriteSuggestions(input, 'falcon-axi', true)).toBe(input)
  })

test.each([
  JSON.stringify({ help: ['falcon-axi host show', "echo 'falcon-axi host list'", 'falcon-axi host show'] }),
  'help[3]:\n  falcon-axi host show\n  echo \'falcon-axi host list\'\n  falcon-axi host show\n',
  'help[3]:\r\n  - falcon-axi host show\r\n  - Run `echo \'falcon-axi host list\'`\r\n  - falcon-axi host show\r\n',
  'help[3]: falcon-axi host show,Run `echo \'falcon-axi host list\'`,falcon-axi host show\n',
  'help: Run echo with \'falcon-axi host list\'\n',
  'help: Run `falcon-axi host show` or echo or \'falcon-axi host list\'\n',
])('preserves every suggestion when a sibling command is ambiguous: %s', input => {
  const actual = rewriteSuggestions(input, 'falcon-axi')
  expect(actual).toBe(input)
  expect(rewriteSuggestions(actual, 'falcon-axi')).toBe(input)
})

test.each(suggestionFormats.flatMap(({ format, encode }) => ['`', "'", '"'].flatMap(quote => ['', 'artium-axi '].map(prefix =>
  ({ format, encode, quote, prefix })))))('rewrites same-line commands in $format with $quote and prefix "$prefix"', ({ encode, quote, prefix }) => {
  const argumentQuote = quote === "'" ? '"' : "'"
  const first = `falcon-axi host list --filter ${argumentQuote}falcon-axi host show${argumentQuote}`
  const input = encode(`Run ${quote}${prefix}${first}${quote} or ${quote}falcon-axi host show --id 7${quote}`)
  const expected = encode(`Run ${quote}artium-axi ${first}${quote} or ${quote}artium-axi falcon-axi host show --id 7${quote}`)
  expect(rewriteSuggestions(input, 'falcon-axi')).toBe(expected)
  expect(rewriteSuggestions(expected, 'falcon-axi')).toBe(expected)
  expect(rewriteSuggestions(input, 'falcon-axi', true)).toBe(input)
  const incomplete = encode(`Run ${quote}${prefix}${first}${quote} or ${quote}falcon-axi host show --id 7`)
  expect(rewriteSuggestions(incomplete, 'falcon-axi')).toBe(incomplete)
  const incompleteWrapped = encode(`Run ${quote}${prefix}${first}${quote} or ${quote}artium-axi falcon-axi host show --id 7`)
  expect(rewriteSuggestions(incompleteWrapped, 'falcon-axi')).toBe(incompleteWrapped)
  const prose = encode(`If you're unsure, run ${quote}${prefix}${first}${quote}`)
  const expectedProse = encode(`If you're unsure, run ${quote}artium-axi ${first}${quote}`)
  expect(rewriteSuggestions(prose, 'falcon-axi')).toBe(expectedProse)
  expect(rewriteSuggestions(expectedProse, 'falcon-axi')).toBe(expectedProse)
  const incompleteProse = encode(`Run ${quote}${prefix}${first}${quote} or, if you're unsure, run ${quote}falcon-axi host show`)
  expect(rewriteSuggestions(incompleteProse, 'falcon-axi')).toBe(incompleteProse)
  const incompleteWrappedProse = encode(`Run ${quote}${prefix}${first}${quote} or, if you're unsure, run ${quote}artium-axi falcon-axi host show`)
  expect(rewriteSuggestions(incompleteWrappedProse, 'falcon-axi')).toBe(incompleteWrappedProse)
})

test.each(suggestionFormats.flatMap(({ format, encode }) => ['`', "'", '"'].flatMap(quote =>
  ['', 'artium-axi '].flatMap(prefix => ['', quote].map(closing => ({ format, encode, quote, prefix, closing }))))))(
  'preserves escaped delimiters in $format with $quote, prefix "$prefix" and closing "$closing"', ({ encode, quote, prefix, closing }) => {
    const input = encode(`Run \`falcon-axi host list\` or ${quote}${prefix}falcon-axi host show --filter \\${quote}synthetic\\${quote} --other \\${quote}falcon-axi host list\\${quote}${closing}`)
    const actual = rewriteSuggestions(input, 'falcon-axi')
    expect(actual).toBe(input)
    expect(rewriteSuggestions(actual, 'falcon-axi')).toBe(input)
  })

test.each(['\n', '\r\n'].flatMap(newline => ['', ' ', '  ', '\t', ' \t'].flatMap(whitespace =>
  ['', newline].flatMap(ending => [
    `help[1]:${newline}  -${whitespace}${ending}`,
    `help[2]:${newline}  - Run \`falcon-axi host list\`${newline}  -${whitespace}${ending}`,
    `help[2]:${newline}  -${whitespace}${newline}  - Run \`falcon-axi host list\`${ending}`,
    `help[2]:${newline}  Run \`falcon-axi host list\`${newline}  -${whitespace}${ending}`,
  ]))))('preserves bare TOON list markers: %s', input => {
  const actual = rewriteSuggestions(input, 'falcon-axi')
  expect(actual).toBe(input)
  expect(rewriteSuggestions(actual, 'falcon-axi')).toBe(input)
})

test.each([
  'message: Run `falcon-axi host list`',
  '"message": Run `falcon-axi host list`',
  '[1]: falcon-axi host list',
  '[0]:',
  'null',
  '7',
  'true',
  'false',
].flatMap(item => [
  `help[1]:\n  - ${item}\n`,
  `help[2]:\n  - "Run \`falcon-axi host list\`"\n  - ${item}\n`,
  `help[2]:\n  - ${item}\n  - "Run \`falcon-axi host list\`"\n`,
  `help[2]:\n  Run \`falcon-axi host list\`\n  - ${item}\n`,
]))('preserves unsupported marked TOON help items: %s', input => {
  const actual = rewriteSuggestions(input, 'falcon-axi')
  expect(actual).toBe(input)
  expect(rewriteSuggestions(actual, 'falcon-axi')).toBe(input)
})

test.each([
  'help: falcon-axi host list\n dangling\n',
  'help: falcon-axi host list\n  dangling\n',
  'help: "Run `falcon-axi host list`"\n  dangling\n',
  'help[1]: Run `falcon-axi host list`\n  dangling\n',
  'help[1]:\n  Run `falcon-axi host list`\n  dangling\n',
  'help[1]:\n  Run `falcon-axi host list`\n    dangling\n',
  'data: value\n  dangling\nhelp: falcon-axi host list\n',
  'help: falcon-axi host list\ndata: value\n  dangling\n',
  'help[1]: Run `falcon-axi host list`\ndata: value\n  dangling\n',
  'help[1]:\n  Run `falcon-axi host list`\ndata: value\n  dangling\n',
  'data:\n  value: synthetic\n    dangling\nhelp: falcon-axi host list\n',
  'rows[1]{id}:\n  7\n  dangling\nhelp: falcon-axi host list\n',
  'help: falcon-axi host list\nrows[1]{id}:\n  7\n  dangling\n',
  'data:\nhelp: falcon-axi host list\n  sibling: synthetic\n',
  'data:\nhelp[1]: Run `falcon-axi host list`\n  sibling: synthetic\n',
  'data:\nhelp[1]:\n  Run `falcon-axi host list`\n    sibling: synthetic\n',
])('preserves documents with unconsumed TOON structure: %s', input => {
  const actual = rewriteSuggestions(input, 'falcon-axi')
  expect(actual).toBe(input)
  expect(rewriteSuggestions(actual, 'falcon-axi')).toBe(input)
})

test.each([
  'help[2]:\n  Run `falcon-axi host list`\n',
  'help[2]: Run `falcon-axi host list`\n',
  'help[1]: "Run `falcon-axi host list`\n',
  'help[1]: Run `falcon-axi host list`,\n',
  'help[1]:\n  Run `falcon-axi host list`\n  extra\n',
  'rows[2]{id}:\n  1\nhelp: falcon-axi host list\n',
  '{ "help": ["falcon-axi host list"',
  'diagnostic text\nhelp: falcon-axi host list\n',
  'help: "Run `falcon-axi host list`\n',
  'help: Run `falcon-axi host list\n',
  'help[2]:\n  Run `falcon-axi host list`\n  Run `falcon-axi host show\n',
  'next: falcon-axi host list\n',
  'help: Run `falcon-axi-other host list`\n',
  'help: Run `artium-axi falcon-axi host list`\n',
  'help: vectra-axi host list --filter \'falcon-axi host show\'\n',
  '{ "help": { "data": "falcon-axi host list" } }',
  '{ "help": [["falcon-axi host list"]] }',
  '{ "help": ["falcon-axi host list", {"data": "falcon-axi host list"}] }',
  '{ "data": { "help": "falcon-axi host list" } }',
  '{ "help": "falcon-axi host list", "help": "falcon-axi host show" }',
  'help: falcon-axi host list\nhelp: falcon-axi host show\n',
  JSON.stringify({ help: ['falcon-axi host list', 'Run "falcon-axi host show --filter \\"synthetic\\"'] }),
  `help[2]:\n  falcon-axi host list\n  ${JSON.stringify('Run "falcon-axi host show --filter \\"synthetic\\"')}\n`,
])('preserves unknown, incomplete and unrelated output: %s', input => {
  expect(rewriteSuggestions(input, 'falcon-axi')).toBe(input)
})

test.each(['help: falcon-axi host list\n', '{"help":"falcon-axi host list"}'])('preserves explicitly truncated streams: %s', input => {
  expect(rewriteSuggestions(input, 'falcon-axi', true)).toBe(input)
})

test.each([
  { code: 'TLS_UNTRUSTED', hint: 'Use --ca-file <pem> to append a corporate CA, or NODE_EXTRA_CA_CERTS; Node does not use the system trust store' },
  { code: 'TLS_UNTRUSTED', hint: 'Set NODE_EXTRA_CA_CERTS to trust a private CA' },
  { code: 'VALIDATION_ERROR', hint: 'Use ldaps:// alone, or ldap:// with --start-tls' },
  { code: 'VALIDATION_ERROR', hint: 'Pass --ca-file <readable-pem> or correct the configured caFile path and permissions' },
  { code: 'TLS_REQUIRED', hint: 'Use ldaps:// or --start-tls' },
  { code: 'TLS_REQUIRED', hint: 'Use ldaps:// or --start-tls instead' },
  { code: 'TLS_REQUIRED', hint: 'Use ldaps:// or --start-tls without --tls-no-verify' },
  { code: 'TLS_REQUIRED', hint: 'Or use ldap:// without --start-tls for the sealed GSSAPI transport' },
  { code: 'AUTH_REQUIRED', hint: 'Set LDAP_AXI_BIND_DN and LDAP_AXI_BIND_PASSWORD, or select a profile with bindDn and a bindPassword SecretRef' },
  { code: 'NOT_FOUND', hint: 'The search base may be absent or hidden by access control; if using --anonymous, try an authenticated bind with read access' },
].flatMap(value => [JSON.stringify, encode].map(serialize => ({ ...value, serialize }))))(
  'LDAP $code recovery hosts credential changes without changing unrelated output', ({ code, hint, serialize }) => {
    const document = { code, error: 'Synthetic connection failure', data: { hint },
      help: [hint, 'Run `ldap-axi entry search --help` for filter syntax', 'Check directory read permissions'] }
    const input = serialize(document)
    const output = rewriteSuggestions(input, 'ldap-axi')
    expect(output).toBe(serialize({ ...document, help: [
      'Ask an Artium administrator to update the stored LDAP credentials: use verified LDAPS or LDAP with startTls=true, and supply trusted CA PEM contents in caFile when required.',
      'Run `artium-axi ldap-axi entry search --help` for filter syntax', 'Check directory read permissions',
    ] }))
    expect(rewriteSuggestions(output, 'ldap-axi')).toBe(output)
    expect(rewriteSuggestions(input, 'ldap-axi', true)).toBe(input)
  })

test.each([JSON.stringify, encode])('LDAP recovery preserves literal arguments in supported command suggestions', serialize => {
  const input = serialize({ code: 'VALIDATION_ERROR', help: ['Use `ldap-axi user list --name "--ca-file NODE_EXTRA_CA_CERTS"`'] })
  const expected = serialize({ code: 'VALIDATION_ERROR', help: ['Use `artium-axi ldap-axi user list --name "--ca-file NODE_EXTRA_CA_CERTS"`'] })
  expect(rewriteSuggestions(input, 'ldap-axi')).toBe(expected)
})
