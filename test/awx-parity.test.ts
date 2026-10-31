import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const { DOMAINS } = await import(new URL('../tools/node_modules/awx-axi/dist/cli.js', import.meta.url).href)
const parity = JSON.parse(readFileSync(new URL('../tools/inventories/awx-axi-parity.json', import.meta.url), 'utf8'))

type Flag = { name: string; takesValue: boolean; description: string }
type Command = { command: string; flags: Flag[]; positionals: { names: string[]; required: number } }
type Domain = { name: string; subcommands: (Omit<Command, 'command'> & { name: string })[] }

test('AWX parity public artifact covers every pinned domain command, flag and positional contract', () => {
  const expected = (DOMAINS as Domain[]).flatMap(domain => domain.subcommands.map(route => ({
    command: `${domain.name} ${route.name}`,
    flags: [{ name: 'help', takesValue: false, description: 'Command help' }, ...route.flags],
    positionals: route.positionals,
  })))
  const domains = new Set((DOMAINS as Domain[]).map(domain => domain.name))
  const actual = (parity.commands as Command[]).filter(route => domains.has(route.command.split(' ')[0]))
    .map(route => ({ command: route.command,
      flags: route.flags.map(({ name, takesValue, description }) => ({ name, takesValue, description })),
      positionals: route.positionals }))
  expect(actual).toEqual(expected)
})
