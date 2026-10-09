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
  ['help[2]:\r\n  Run `falcon-axi host show --id "two words"`\r\n  Run `vectra-axi host list`\r\n',
    'help[2]:\r\n  Run `artium-axi falcon-axi host show --id "two words"`\r\n  Run `vectra-axi host list`\r\n'],
  ['help[1]:\n  - "Run `falcon-axi host list --filter \\"name\\"`\\nRun `falcon-axi host list`"\n',
    'help[1]:\n  - "Run `artium-axi falcon-axi host list --filter \\"name\\"`\\nRun `artium-axi falcon-axi host list`"\n'],
  ['{ "data": "falcon-axi host list", "help": ["Run \'falcon-axi host list\'", "falcon\\u002daxi host list\\nUse \\"falcon-axi host show\\""] }',
    '{ "data": "falcon-axi host list", "help": ["Run \'artium-axi falcon-axi host list\'", "artium-axi falcon\\u002daxi host list\\nUse \\"artium-axi falcon-axi host show\\""] }'],
  ['data:\n  help: falcon-axi host list\nhelp: "Run `falcon-axi host list`"\n',
    'data:\n  help: falcon-axi host list\nhelp: "Run `artium-axi falcon-axi host list`"\n'],
])('preserves bytes around recognised suggestions: %s', (input, expected) => {
  expect(rewriteSuggestions(input, 'falcon-axi')).toBe(expected)
  expect(rewriteSuggestions(expected, 'falcon-axi')).toBe(expected)
})

test.each([
  { format: 'JSON scalar', encode: (value: string) => JSON.stringify({ help: value }) },
  { format: 'JSON list', encode: (value: string) => JSON.stringify({ help: [value] }) },
  { format: 'TOON scalar', encode: (value: string) => `help: ${value}\n` },
  { format: 'TOON quoted scalar', encode: (value: string) => `help: ${JSON.stringify(value)}\n` },
  { format: 'TOON list', encode: (value: string) => `help[1]:\n  ${JSON.stringify(value)}\n` },
  { format: 'TOON inline list', encode: (value: string) => `help[1]: ${JSON.stringify(value)}\n` },
].flatMap(({ format, encode }) => ['`', "'", '"'].flatMap(quote => ['', 'artium-axi '].map(prefix =>
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
])('preserves unknown, incomplete and unrelated output: %s', input => {
  expect(rewriteSuggestions(input, 'falcon-axi')).toBe(input)
})

test.each(['help: falcon-axi host list\n', '{"help":"falcon-axi host list"}'])('preserves explicitly truncated streams: %s', input => {
  expect(rewriteSuggestions(input, 'falcon-axi', true)).toBe(input)
})
