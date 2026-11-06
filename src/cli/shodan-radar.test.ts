import { execFile, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'
import { copyClientInput } from '../../test/fixtures/client-inputs.js'
import { SessionStore } from './session.js'

test.each([
  { name: 'consumes every retained page', state: 'closed', empty: false, expires: '', code: 0, events: 2, error: '' },
  { name: 'refreshes authentication between pages', state: 'closed', empty: false, expires: 'read', code: 0, events: 2, error: '' },
  { name: 'refreshes authentication during cleanup', state: 'closed', empty: false, expires: 'DELETE', code: 0, events: 2, error: '' },
  { name: 'saves retained pages and reports worker failure', state: 'failed', empty: false, expires: '', code: 1, events: 2, error: 'TOOL_FAILED' },
  { name: 'reports worker failure before any events', state: 'failed', empty: true, expires: '', code: 1, events: 0, error: 'TOOL_FAILED' },
  { name: 'saves consumed events after a connection failure', state: 'closed', empty: false, expires: 'network', code: 1, events: 1, error: 'SERVER_UNAVAILABLE' },
  { name: 'saves consumed events after an invalid response', state: 'closed', empty: false, expires: 'invalid', code: 1, events: 1, error: 'INVALID_RESPONSE' },
  { name: 'saves the consumed page at the loss limit', state: 'closed', empty: false, expires: 'loss', code: 1, events: 2, error: 'OUTPUT_LIMIT' },
])('radar $name', async ({ state, empty, expires, code, events, error }) => {
  const directory = await mkdtemp(join(tmpdir(), 'artium-radar-'))
  let stopped = false
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    if (request.url === '/v1/auth/refresh') {
      response.end(JSON.stringify({ status: 'authenticated', accessToken: 'CANARY-fresh', refreshToken: 'CANARY-next',
        accessExpiresAt: Date.now() + 3600000, familyExpiresAt: Date.now() + 7200000 }))
    } else if (request.headers.authorization !== 'Bearer CANARY-fresh' && (expires === 'read' && request.url?.endsWith('/read') && JSON.parse(body).continuation
      || expires === 'DELETE' && request.method === 'DELETE')) {
      response.statusCode = 401
      response.end(JSON.stringify({ error: { code: 'TOKEN_EXPIRED', source: 'artium-axi', message: 'Access token expired.',
        next: 'Refresh authentication.', requestId: '00000000-0000-4000-8000-000000000002' } }))
    } else if (request.url?.endsWith('/read')) {
      const continuation = JSON.parse(body).continuation
      if (continuation && expires === 'network') { request.socket.destroy(); return }
      if (continuation && expires === 'invalid') { response.end('{}'); return }
      response.end(JSON.stringify({ items: empty ? [] : [{ sequence: continuation ? 2 : 1,
        value: { location: continuation ? { latitude: -10, longitude: 20 } : { latitude: 10, longitude: -20 } } }],
      lost: continuation && expires === 'loss' ? Array.from({ length: 1025 }, (_, index) => ({ from: index + 3, to: index + 3, reason: 'retention' })) : [],
      upstreamLoss: {}, continuation: continuation ? 'second' : 'first', cleaned: true, hasMore: !empty && !continuation, state }))
    } else {
      if (request.method === 'DELETE') stopped = true
      response.end('{}')
    }
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    new SessionStore(url, join(directory, 'artium-axi/session.json')).write({ status: 'authenticated', accessToken: 'CANARY-token',
      refreshToken: 'CANARY-refresh', accessExpiresAt: Date.now() + 45000, familyExpiresAt: Date.now() + 7200000 })
    const bundle = copyClientInput('bundle', join(directory, 'client.mjs')), output = join(directory, 'radar.json')
    const result = await promisify(execFile)(process.execPath, [bundle, 'shodan-axi', 'radar', '--session', '00000000-0000-4000-8000-000000000001',
      '--max-events', '10', '--output', output], { env: { PATH: process.env.PATH, XDG_CONFIG_HOME: directory, ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1' } })
      .then(result => ({ code: 0, stdout: result.stdout, stderr: result.stderr }),
        error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))
    expect(result).toEqual({ code, stdout: expect.stringContaining(error || 'saved:'), stderr: '' })
    expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject({ events, plottedPoints: events, ignoredPoints: 0, state })
    expect(stopped).toBe(true)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})

test.each([
  { managed: false, args: ['shodan-axi', 'radar', '--help'] },
  { managed: false, args: ['shodan-axi', 'radar', '-h'] },
  { managed: true, args: ['shodan-axi', 'radar', '--help'] },
  { managed: true, args: ['shodan-axi', 'radar', '-h'] },
])('radar help stays local with managed=$managed and $args', async ({ managed, args }) => {
  const directory = await mkdtemp(join(tmpdir(), 'artium-radar-help-'))
  try {
    const url = 'http://127.0.0.1:1'
    new SessionStore(url, join(directory, 'artium-axi/session.json')).write({ status: 'authenticated', accessToken: 'CANARY-token',
      refreshToken: 'CANARY-refresh', accessExpiresAt: Date.now() + 3600000, familyExpiresAt: Date.now() + 7200000 }, undefined, true)
    const bundle = copyClientInput('bundle', join(directory, 'client.mjs'))
    const result = await promisify(execFile)(process.execPath, [bundle, ...(managed ? ['--managed-session'] : []), ...args],
      { env: { PATH: process.env.PATH, XDG_CONFIG_HOME: directory, ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1' } })
    expect(result.stdout).toContain('usage: artium-axi shodan-axi radar --session <id>')
    expect(result.stderr).toBe('')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test.each(['SIGINT', 'SIGTERM'] as const)('radar saves consumed events and stops its session on %s', async signal => {
  const directory = await mkdtemp(join(tmpdir(), 'artium-radar-'))
  let child: ChildProcess | undefined, stopped = false
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    if (request.url?.endsWith('/read')) {
      if (JSON.parse(body).continuation) {
        child!.kill(signal)
        return
      }
      response.end(JSON.stringify({ items: [{ sequence: 1, value: { location: { latitude: 10, longitude: -20 } } }],
        lost: [], upstreamLoss: {}, continuation: 'first', cleaned: false, hasMore: false, state: 'running' }))
    } else {
      if (request.method === 'DELETE') stopped = true
      response.end('{}')
    }
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    new SessionStore(url, join(directory, 'artium-axi/session.json')).write({ status: 'authenticated', accessToken: 'CANARY-token',
      refreshToken: 'CANARY-refresh', accessExpiresAt: Date.now() + 3600000, familyExpiresAt: Date.now() + 7200000 })
    const bundle = copyClientInput('bundle', join(directory, 'client.mjs')), output = join(directory, 'radar.json')
    const result = await new Promise<{ code: number | string | null, stdout: string, stderr: string }>(resolve => {
      child = execFile(process.execPath, [bundle, 'shodan-axi', 'radar', '--session', '00000000-0000-4000-8000-000000000001',
        '--max-events', '10', '--output', output],
      { env: { PATH: process.env.PATH, XDG_CONFIG_HOME: directory, ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1' } },
      (error, stdout, stderr) => resolve({ code: error ? error.code ?? null : 0, stdout, stderr }))
    })
    expect(result).toEqual({ code: 0, stdout: expect.stringContaining('saved:'), stderr: '' })
    expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject({ events: 1, plottedPoints: 1, state: 'running' })
    expect(stopped).toBe(true)
  } finally {
    child?.kill('SIGKILL')
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
