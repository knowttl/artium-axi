import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:https'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestCertificates } from './certificates.mjs'

export async function withFakeService(check: (fixture: {
  directory: string
  port: number
  send: (path: string, method?: string, trusted?: boolean) => Promise<string>
}) => Promise<void>, onHeldRequest?: () => void) {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const directory = mkdtempSync(join(root, '.tmp-tls-'))
  let child: ReturnType<typeof spawn> | undefined
  try {
    createTestCertificates(directory, ['localhost'])
    child = spawn(process.execPath, [join(root, 'test/fake-service/server.mjs'), directory, '0'], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    child.on('message', message => {
      if (message === 'held-request') onHeldRequest?.()
    })
    const [chunk] = await once(child.stdout!, 'data', { signal: AbortSignal.timeout(3000) })
    const port = Number(chunk.toString().trim().split(' ')[1])
    const send = (path: string, method = 'GET', trusted = true) => new Promise<string>((resolve, reject) => {
      const req = request({ hostname: 'localhost', port, path, method,
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
