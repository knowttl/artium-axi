import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:https'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createTestCertificates } from './certificates.mjs'

export async function withFakeService(check: (fixture: {
  directory: string
  port: number
  send: (path: string, method?: string, trusted?: boolean) => Promise<string>
}) => Promise<void>, onHeldRequest?: () => void, endpoint = { port: 0, hosts: ['localhost'] }) {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const directory = mkdtempSync(join(tmpdir(), 'artium-tls-'))
  let child: ReturnType<typeof spawn> | undefined
  try {
    const preparedCertificates = process.env.ARTIUM_TEST_PREBUILT_CERTS
    if (preparedCertificates) for (const name of ['ca.crt', 'server.crt', 'server.key']) copyFileSync(join(preparedCertificates, name), join(directory, name))
    else createTestCertificates(directory, endpoint.hosts)
    child = spawn(process.execPath, [join(root, 'test/fake-service/server.mjs'), directory, String(endpoint.port)], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    child.on('message', message => {
      if (message === 'held-request') onHeldRequest?.()
    })
    // Child startup needs the same headroom as integration hooks under concurrent load.
    const [chunk] = await once(child.stdout!, 'data', { signal: AbortSignal.timeout(30_000) })
    const port = Number(chunk.toString().trim().split(' ')[1])
    const send = (path: string, method = 'GET', trusted = true) => new Promise<string>((resolve, reject) => {
      const req = request({ hostname: 'localhost', port, path, method, agent: false,
        headers: { authorization: 'Bearer CANARY-synthetic' },
        ...(trusted ? { ca: readFileSync(join(directory, 'ca.crt')) } : {}),
      }, response => {
        let body = ''
        response.on('data', chunk => { body += chunk })
        response.on('end', () => resolve(body))
      })
      req.on('error', reject)
      req.setTimeout(3000, () => req.destroy(new Error('Synthetic request timed out')))
      req.end()
    })
    await check({ directory, port, send })
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close')
      child.kill('SIGTERM')
      await closed
    }
    rmSync(directory, { recursive: true, force: true })
  }
}
