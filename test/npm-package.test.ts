import { execFile, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'
import { SessionStore } from '../src/cli/session.js'
import { cliVersion } from '../src/shared/version.js'

const execute = promisify(execFile)

test('npm tarball installs an offline client and sets up its embedded skill with authentication without server assets', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'artium-npm-'))
  const server = createServer((request, reply) => {
    if (request.url !== '/v1/skills' || request.headers.authorization !== 'Bearer CANARY-access') {
      reply.writeHead(401).end()
      return
    }
    reply.setHeader('content-type', 'application/json')
    reply.end(JSON.stringify({ skills: [] }))
  })
  try {
    execFileSync(process.execPath, ['scripts/build-npm.mjs'])
    const [packed] = JSON.parse(execFileSync('npm', ['pack', resolve('dist/npm'), '--json', '--pack-destination', directory], { encoding: 'utf8' }))
    expect(packed.files.map((file: { path: string }) => file.path).sort()).toEqual([
      'LICENSE', 'NOTICE', 'README.md', 'bin/artium-axi.mjs', 'package.json', 'skill/artium-axi/SKILL.md',
    ])
    execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', directory, join(directory, packed.filename)])
    const executable = join(directory, 'node_modules', '.bin', 'artium-axi')
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const config = join(directory, '.config')
    new SessionStore(url, join(config, 'artium-axi/session.json')).write({ status: 'authenticated', accessToken: 'CANARY-access',
      refreshToken: 'CANARY-refresh', accessExpiresAt: Date.now() + 3_600_000, familyExpiresAt: Date.now() + 43_200_000 })
    const env = { PATH: process.env.PATH, HOME: directory, USERPROFILE: directory, XDG_CONFIG_HOME: config,
      ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1', CLAUDE_CONFIG_DIR: join(directory, '.claude') }
    const result = await execute(executable, ['setup', '--host', 'claude'], { cwd: directory, env, timeout: 10_000 })
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe('skills[1]{name,status}:\n  artium-axi,installed\n')
    const skill = readFileSync(join(directory, '.claude', 'skills', 'artium-axi', 'SKILL.md'), 'utf8')
    expect(skill).toContain('artium-axi')
    const metadata = JSON.parse(readFileSync(join(directory, 'node_modules', '@knowttl', 'artium-axi', 'package.json'), 'utf8'))
    expect(metadata).toMatchObject({ name: '@knowttl/artium-axi', version: cliVersion, license: 'MIT',
      bin: { 'artium-axi': 'bin/artium-axi.mjs' } })
    expect(metadata.dependencies).toBeUndefined()
    expect(metadata.scripts).toBeUndefined()
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    rmSync(directory, { recursive: true, force: true })
  }
})
