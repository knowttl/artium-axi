import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { copyClientInput } from '../../test/fixtures/client-inputs.js'
import { SessionStore } from './session.js'

const id = '00000000-0000-4000-8000-000000000001'
const confirm = '00000000-0000-4000-8000-000000000002'
const gzip = Buffer.from([0x1f, 0x8b, 8, 0, 1, 2, 3, 4, 255, 128])
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
type Scenario = 'complete' | 'partial' | 'digest' | 'header-digest' | 'completeness' | 'failed' | 'destination-created'
let directory: string, saves: string, scenario: Scenario, requests: { path: string, body: unknown }[]
let server: ReturnType<typeof createServer>, url: string
let bundle: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'artium-export-'))
  saves = join(directory, 'saves')
  await mkdir(saves, { mode: 0o700 })
  scenario = 'complete'
  requests = []
  server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({ path: request.url!, body: body ? JSON.parse(body) : undefined })
    const complete = scenario !== 'partial'
    if (request.url!.endsWith('/retrieve')) {
      response.writeHead(200, { 'content-type': 'application/gzip', 'content-length': gzip.length,
        'x-artium-export-sha256': scenario === 'header-digest' ? 'a'.repeat(64) : digest(gzip),
        'x-artium-export-complete': String(scenario === 'completeness' ? !complete : complete) })
      response.end(scenario === 'digest' ? Buffer.alloc(gzip.length, 7) : gzip)
    } else if (request.url!.includes(`/exports/${id}`)) {
      if (scenario === 'destination-created') await writeFile(join(saves, 'export.json.gz'), 'sentinel')
      response.end(JSON.stringify(scenario === 'failed' ? { id, state: 'failed', result: { error: 'INTERNAL_ERROR' } }
        : { id, state: complete ? 'completed' : 'partial', result: { count: 2, total: complete ? 2 : 5, complete, bytes: gzip.length,
          sha256: digest(gzip), requests: 1, retainedUntil: Date.now() + 60000 } }))
    } else if (request.url!.endsWith('/start')) response.end(JSON.stringify({ id, state: 'running' }))
    else if (request.url!.endsWith('/preview')) response.end(JSON.stringify({ confirm, total: 2 }))
    else response.end('{}')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  new SessionStore(url, join(directory, 'artium-axi/session.json')).write({ status: 'authenticated', accessToken: 'CANARY-token',
    refreshToken: 'CANARY-refresh', accessExpiresAt: Date.now() + 3600000, familyExpiresAt: Date.now() + 7200000 })
  bundle = copyClientInput('bundle', join(directory, 'client.mjs'))
})
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await rm(directory, { recursive: true, force: true })
})

async function run(args: string[]) {
  return promisify(execFile)(process.execPath, [bundle, ...args],
    { env: { PATH: process.env.PATH, XDG_CONFIG_HOME: directory, ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1' } })
    .then(result => ({ code: 0, stdout: result.stdout, stderr: result.stderr }),
      error => ({ code: error.code as number, stdout: error.stdout as string, stderr: error.stderr as string }))
}
const bounds = ['--limit', '2', '--max-bytes', '4096', '--query-credit-budget', '1', '--max-requests', '1']
const execute = ['--execute', '--confirm', confirm]

test('saves a complete export at the requested path after verifying it', async () => {
  const output = join(saves, 'export.json.gz')
  const result = await run(['shodan-axi', 'download', 'port:22', ...bounds, ...execute, '--output', output, '--json'])
  expect(result).toEqual({ code: 0, stderr: `export: ${id}\n`,
    stdout: JSON.stringify({ saved: output, count: 2, total: 2, complete: true, bytes: gzip.length, sha256: digest(gzip) }) + '\n' })
  expect(await readFile(output)).toEqual(gzip)
  expect((await stat(output)).mode & 0o777).toBe(0o600)
  expect(await readdir(saves)).toEqual(['export.json.gz'])
})

test('keeps .partial in the saved name for an incomplete export and exits 1', async () => {
  scenario = 'partial'
  const output = join(saves, 'export.json.gz')
  await writeFile(output + '.partial', 'stale')
  const result = await run(['shodan-axi', 'download', 'port:22', ...bounds, ...execute, '--output', output, '--json'])
  expect(result).toMatchObject({ code: 1, stdout: expect.stringContaining(`"saved":${JSON.stringify(output + '.partial')}`) })
  expect(await readFile(output + '.partial')).toEqual(gzip)
  expect(await readdir(saves)).toEqual(['export.json.gz.partial'])
})

test('leaves a stale partial file untouched for a complete export', async () => {
  const output = join(saves, 'export.json.gz')
  await writeFile(output + '.partial', 'stale')
  const result = await run(['shodan-axi', 'download', 'port:22', ...bounds, ...execute, '--output', output])
  expect(result.code).toBe(0)
  expect(await readFile(output)).toEqual(gzip)
  expect(await readFile(output + '.partial', 'utf8')).toBe('stale')
})

test('refuses a partial symlink before retrieval', async () => {
  scenario = 'partial'
  const output = join(saves, 'export.json.gz')
  await symlink('elsewhere', output + '.partial')
  const result = await run(['shodan-axi', 'download', 'port:22', ...bounds, ...execute, '--output', output])
  expect(result.code).toBe(1)
  expect(requests.some(request => request.path.endsWith('/retrieve'))).toBe(false)
})

test('refuses a final destination created while the export runs', async () => {
  scenario = 'destination-created'
  const output = join(saves, 'export.json.gz')
  const result = await run(['shodan-axi', 'download', 'port:22', ...bounds, ...execute, '--output', output])
  expect(result.code).toBe(1)
  expect(await readFile(output, 'utf8')).toBe('sentinel')
  expect(requests.some(request => request.path.endsWith('/retrieve'))).toBe(false)
})

test.each(['digest', 'header-digest', 'completeness'] as const)('rejects a %s mismatch without saving any bytes', async mismatch => {
  scenario = mismatch
  const result = await run(['shodan-axi', 'download', 'port:22', ...bounds, ...execute, '--output', join(saves, 'export.json.gz')])
  expect(result).toMatchObject({ code: 1, stdout: expect.stringContaining('INVALID_RESPONSE') })
  expect(await readdir(saves)).toEqual([])
})

test('reports a failed export without saving', async () => {
  scenario = 'failed'
  const result = await run(['shodan-axi', 'download', 'port:22', ...bounds, ...execute, '--output', join(saves, 'export.json.gz')])
  expect(result).toMatchObject({ code: 1, stdout: expect.stringContaining('TOOL_FAILED') })
  expect(await readdir(saves)).toEqual([])
})

test.each([
  { name: 'an existing output file', prepare: (output: string) => writeFile(output, 'sentinel'), output: 'export.json.gz' },
  { name: 'a relative path', prepare: async () => {}, output: 'export.json.gz', relative: true },
  { name: 'a directory that is not private', prepare: async () => { await mkdir(join(saves, 'shared'), { mode: 0o755 }) }, output: 'shared/export.json.gz' },
])('refuses $name before contacting the server', async ({ prepare, output, relative }) => {
  const path = relative ? output : join(saves, output)
  await prepare(path)
  const execution = await run(['shodan-axi', 'download', 'port:22', ...bounds, ...execute, '--output', path])
  const preview = await run(['shodan-axi', 'download', 'port:22', ...bounds, '--output', path])
  expect([execution, preview]).toEqual(Array(2).fill({ code: 1, stdout: expect.stringContaining('ARTIFACT_SAVE_FAILED'), stderr: '' }))
  expect(requests).toEqual([])
})

test('preview sends the search input and instance without writing', async () => {
  const output = join(saves, 'export.json.gz')
  const result = await run(['--instance', 'lab', 'shodan-axi', 'download', 'port:22', ...bounds, '--fields', 'ip_str,port', '--output', output, '--json'])
  expect(result).toEqual({ code: 0, stderr: '', stdout: JSON.stringify({ confirm, total: 2 }) + '\n' })
  expect(requests.filter(request => request.path.includes('/exports/'))).toEqual([{ path: '/v1/tools/shodan-axi/exports/preview',
    body: { command: 'download', query: 'port:22', fields: ['ip_str', 'port'], limit: 2, maxBytes: 4096, queryCreditBudget: 1, maxRequests: 1, instance: 'lab' } }])
  expect(await readdir(saves)).toEqual([])
})

test('alert download sends the alert and saves the verified export', async () => {
  const output = join(saves, 'alert.json.gz')
  const result = await run(['shodan-axi', 'alert', 'download', '--alert-id', 'AL-1', ...bounds, ...execute, '--output', output, '--json'])
  expect(result.code).toBe(0)
  expect(requests.find(request => request.path.endsWith('/start'))?.body).toEqual({ command: 'alert download', alertId: 'AL-1', fields: [],
    limit: 2, maxBytes: 4096, queryCreditBudget: 1, maxRequests: 1, confirm })
  expect(await readFile(output)).toEqual(gzip)
})

test.each([
  { name: 'a missing output', args: ['download', 'port:22', ...bounds] },
  { name: 'a missing query', args: ['download', ...bounds, '--output', '/x'] },
  { name: 'a missing bound', args: ['download', 'port:22', '--limit', '2', '--output', '/x'] },
  { name: 'a confirmation without execution', args: ['download', 'port:22', ...bounds, '--confirm', confirm, '--output', '/x'] },
  { name: 'execution without a confirmation', args: ['download', 'port:22', ...bounds, '--execute', '--output', '/x'] },
  { name: 'an alert id on search download', args: ['download', 'port:22', ...bounds, '--alert-id', 'AL-1', '--output', '/x'] },
  { name: 'a query on alert download', args: ['alert', 'download', 'port:22', ...bounds, '--output', '/x'] },
])('refuses $name locally', async ({ args }) => {
  expect(await run(['shodan-axi', ...args])).toMatchObject({ code: 2, stdout: expect.stringContaining('INVALID_INPUT') })
  expect(requests).toEqual([])
})

test.each([['download'], ['alert', 'download']])('%s help stays local', async (...words) => {
  const result = await run(['shodan-axi', ...words.flat(), '--help'])
  expect(result).toMatchObject({ code: 0, stdout: expect.stringContaining('usage: artium-axi shodan-axi download <query> --output'), stderr: '' })
  expect(requests).toEqual([])
})
