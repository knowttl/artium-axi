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

type Decision = { command: string; status: string; effect: string; authorization: string; canonicalCommand?: string; flags: (Flag & { status: string })[] }
const inventory = JSON.parse(readFileSync(new URL('../tools/inventories/awx-axi.json', import.meta.url), 'utf8')) as
  { commands: { command: string; effect: string; flags: Record<string, string> }[] }
const decisions = parity.commands as Decision[]
const aliases = parity.aliases as Decision[]

test('every pinned command has one reviewed decision and every alias maps to a canonical equivalent', () => {
  expect(decisions).toHaveLength(215)
  expect(new Set(decisions.map(decision => decision.command)).size).toBe(215)
  expect(aliases).toHaveLength(27)
  for (const alias of aliases) {
    const canonical = decisions.find(decision => decision.command === alias.canonicalCommand)
    expect(canonical, alias.command).toBeDefined()
    expect(alias).toMatchObject({ status: 'managed equivalent', effect: canonical!.effect, authorization: canonical!.authorization })
    expect(alias.flags.map(flag => flag.name)).toEqual(canonical!.flags.map(flag => flag.name))
  }
})

test('the pinned inventory router resolves every reviewed alias spelling', async () => {
  const inventoryDomain = (DOMAINS as { name: string; run: (args: string[], context: unknown) => Promise<unknown> }[]).find(domain => domain.name === 'inventory')!
  const context = { createTransport: () => { throw new Error('REACHED_TRANSPORT') }, env: {}, selection: {} }
  for (const alias of aliases) {
    const failure = await inventoryDomain.run(alias.command.split(' ').slice(1), context).then(() => '', (error: Error) => error.message)
    expect(failure, alias.command).not.toMatch(/unknown subcommand/i)
  }
})

test('every flag decision matches the Artium route schema', () => {
  const routes = new Map(inventory.commands.map(route => [route.command, route]))
  const domains = new Set((DOMAINS as Domain[]).map(domain => domain.name))
  for (const decision of decisions.filter(decision => domains.has(decision.command.split(' ')[0]))) {
    const route = routes.get(decision.command)
    expect(route, decision.command).toBeDefined()
    for (const flag of decision.flags) {
      const accepted = Object.hasOwn(route!.flags, flag.name)
      if (flag.status === 'supported') expect(accepted, `${decision.command} --${flag.name}`).toBe(true)
      else expect(['managed equivalent', 'not applicable'], `${decision.command} --${flag.name}`).toContain(flag.status)
    }
    for (const name of Object.keys(route!.flags)) expect(decision.flags.map(flag => flag.name), decision.command).toContain(name)
  }
})
