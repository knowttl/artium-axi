import { execFileSync } from 'node:child_process'
import { decode, encode } from '@toon-format/toon'
import { expect, test } from 'vitest'
import { rewriteSuggestions } from './rewrite.js'

test.each([
  { tool: 'unifi-axi', bin: 'dist/bin.js', args: ['info', '--help'], command: 'info', flags: ['help'] },
  { tool: 'unifi-axi', bin: 'dist/bin.js', args: ['--help'], command: '', flags: ['help', 'site'] },
  { tool: 'unifi-axi', bin: 'dist/bin.js', args: ['commands'], command: '', flags: ['help', 'site'] },
  { tool: 'proxmox-axi', bin: 'bin/proxmox-axi.mjs', args: ['get', '/version', '--help'], command: 'get /version',
    flags: ['catalogue', 'fields', 'format', 'full', 'help', 'limit'] },
  { tool: 'proxmox-axi', bin: 'bin/proxmox-axi.mjs', args: ['get', '/version', '--help', '--format', 'json'], command: 'get /version',
    flags: ['catalogue', 'fields', 'format', 'full', 'help', 'limit'] },
])('$tool normalizes published help $args against admitted reads', ({ tool, bin, args, command, flags }) => {
  const native = execFileSync(process.execPath, [`tools/node_modules/@knowttl/${tool}/${bin}`, ...args], { encoding: 'utf8' })
  const output = rewriteSuggestions(native, tool)
  const document = (output.trimStart().startsWith('{') ? JSON.parse(output) : decode(output)) as {
    command: string, usage: string, flags: Record<string, string>, examples: string[], commands?: string[], help: string[] }
  const hosted = `artium-axi ${tool}${command ? ` ${command}` : ''}`
  expect(document.command).toBe(hosted)
  expect(document.usage).toBe(`${hosted} [flags]`)
  expect(Object.keys(document.flags).sort()).toEqual(flags)
  expect(document.examples).toEqual([`${hosted} --help`])
  expect(document.commands ?? []).not.toContain('profile configure')
  expect(document.commands ?? []).not.toContain('acl-rule create')
  expect(rewriteSuggestions(output, tool)).toBe(output)
})

test.each(['unifi-axi', 'proxmox-axi'])('%s authentication recovery uses managed credentials in both formats', tool => {
  for (const serialize of [encode, JSON.stringify]) {
    const input = { error: { code: 'AUTH_REQUIRED', message: 'No available credential.' },
      help: [`${tool} auth status --config /synthetic/config`, `${tool} profile configure --file /synthetic/profile`] }
    const output = rewriteSuggestions(serialize(input), tool)
    const document = (output.trimStart().startsWith('{') ? JSON.parse(output) : decode(output)) as typeof input
    expect(document.error).toEqual(input.error)
    expect(document.help).toContain('Ask an administrator to update the managed credential.')
    expect(document.help.join('\n')).not.toMatch(/--config|profile configure|auth status/)
    expect(rewriteSuggestions(output, tool)).toBe(output)
  }
})
