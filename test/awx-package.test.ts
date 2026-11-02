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
    input: {}, expected: { action: 'create', type: 'host', would_send: 'POST hosts/', payload: '[structured input redacted, 14 bytes]' } },
  { args: ['inventory', 'host-create', 'synthetic', '--inventory', '7', '--variables', '{"ansible_password":12345678}', '--dry-run'],
    input: {}, expected: { payload: '[structured input redacted, 29 bytes]' } },
  { args: ['inventory', 'host-create', 'synthetic', '--inventory', '7', '--variables', 'variables.yml', '--dry-run'],
    input: { files: [{ name: 'variables.yml', contentBase64: Buffer.from('common: &pw CANARY-alias\nansible_password: *pw\n').toString('base64') }] },
    expected: { payload: '[structured input redacted, 47 bytes]' } },
  { args: ['template', 'create', 'synthetic', '--inventory', '7', '--project', '8', '--playbook', 'synthetic.yml', '--extra-vars', '{"ansible_password": 12345678}', '--dry-run'],
    input: {}, expected: { payload: '[structured input redacted, 30 bytes]' } },
  { args: ['inventory', 'source-create', 'synthetic', '--inventory', '7', '--source', 'scm', '--source-vars', '{"ansible_password":12345678}', '--dry-run'],
    input: {}, expected: { payload: '[structured input redacted, 29 bytes]' } },
  { args: ['credential', 'edit', '42', '--inputs-file', '-', '--dry-run'],
    input: { stdin: '{"password":"a"}' }, expected: { action: 'edit', credential: 42, payload: '[structured input redacted, 16 bytes]' } },
  { args: ['ad-hoc', 'launch', '7', '--module-name', 'uri', '--module-args', 'url=https://synthetic.invalid url_password=CANARY-module-password', '--dry-run'],
    input: {}, expected: { module_args: '[structured input redacted, 65 bytes]' } },
  { args: ['ad-hoc', 'launch', '7', '--args', 'args', '--module-args', 'redacted', '--dry-run'],
    input: {}, expected: { module_args: '[structured input redacted, 8 bytes]' } },
  { args: ['ad-hoc', 'launch', '7', '--args', 'echo héllo', '--dry-run'],
    input: {}, expected: { module_args: '[structured input redacted, 11 bytes]' } },
  { args: ['ad-hoc', 'launch', '7', '--module-args=', '--dry-run'],
    input: {}, expected: { module_args: '[structured input redacted, 0 bytes]' } },
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
