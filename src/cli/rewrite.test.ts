import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { rewriteSuggestions } from './rewrite.js'

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
  { format: 'TOON inline list', encode: (value: string) => `help[1]: ${JSON.stringify(value)}\n` },
]

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
