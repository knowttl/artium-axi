import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode } from '@toon-format/toon'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createAwxAdapter } from '../src/server/adapters/awx.js'
import { Runner } from '../src/server/runner/runner.js'

let directory: string
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'artium-awx-package-'))
  const tools = join(directory, 'opt/tools')
  mkdirSync(tools, { recursive: true })
  cpSync('tools/package.json', join(tools, 'package.json'))
  cpSync('tools/pnpm-lock.yaml', join(tools, 'pnpm-lock.yaml'))
  const installed = spawnSync('pnpm', ['--dir', tools, 'install', '--offline', '--frozen-lockfile', '--ignore-scripts'], {
    encoding: 'utf8', timeout: 30_000,
  })
  expect(installed.status, installed.stdout + installed.stderr).toBe(0)
})
afterAll(() => rmSync(directory, { recursive: true, force: true }))

test.each([
  { args: ['inventory', 'host-create', 'synthetic', '--inventory', '7', '--variables', '{"mode":"run"}', '--dry-run'],
    input: {}, expected: { action: 'create', type: 'host', would_send: 'POST hosts/', payload: { variables: '{"mode":"run"}' } } },
  { args: ['credential', 'edit', '42', '--inputs-file', '-', '--dry-run'],
    input: { stdin: '{"password":"a"}' }, expected: { action: 'edit', credential: 42, payload: { inputs: { password: null } } } },
])('packaged AWX private input works with separate application and tools roots: $args', async ({ args, input, expected }) => {
  const adapter = createAwxAdapter({ getCredential: async () => ({ origin: 'https://controller.example',
    token: 'CANARY-awx-token', allowWrites: true }) })
  const call = await adapter.prepare(args, { id: 'synthetic', tool: 'awx-axi' }, input)
  call.args[3] = join(directory, 'opt/tools/node_modules/.bin/awx-axi')
  const runner = await Runner.create(join(directory, 'opt/artium/calls'))
  try {
    const result = await runner.run('synthetic', call.executable, call.args, call.environment, call.secrets,
      call.limits, { ...input, fileArguments: call.fileArguments }, call.files)
    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect(decode(result.stdout)).toMatchObject({ dry_run: expected })
    expect(result.stdout).not.toContain('CANARY-awx-token')
  } finally { await runner.shutdown() }
})
