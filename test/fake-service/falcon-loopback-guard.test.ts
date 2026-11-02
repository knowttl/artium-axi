import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { expect, test } from 'vitest'

const guard = new URL('./falcon-loopback-guard.ts', import.meta.url).href
function child(source: string) {
  return new Promise<{ code: number | null, stdout: string, stderr: string }>((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', source], { env: { PATH: globalThis.process.env.PATH } })
    let stdout = ''; let stderr = ''
    process.stdout.on('data', chunk => { stdout += chunk })
    process.stderr.on('data', chunk => { stderr += chunk })
    process.on('error', reject)
    process.on('close', code => resolve({ code, stdout, stderr }))
  })
}

test.each(['api.crowdstrike.com', 'api.us-2.crowdstrike.com', 'api.eu-1.crowdstrike.com',
  'api.laggar.gcw.crowdstrike.com', 'external.example', '192.0.2.1'])('Falcon test guard refuses %s before network dispatch', async host => {
  const result = await child(`import https from 'node:https';
    https.request = () => { throw new Error('UNGUARDED_NETWORK_FACTORY'); };
    await import(${JSON.stringify(guard)});
    try { https.request('https://${host}/oauth2/token'); }
    catch (error) { console.log(error.code ?? error.message); }`)
  expect(result).toMatchObject({ code: 0, stdout: 'FALCON_TEST_NON_LOOPBACK\n' })
})

test('Falcon test guard admits actual loopback bytes and pins its synthetic alias to loopback', async () => {
  const server = createServer((_request, reply) => reply.end('synthetic-loopback-bytes'))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const address = server.address() as { port: number }
    const result = await child(`await import(${JSON.stringify(guard)});
      const http = await import('node:http');
      http.get({ hostname: 'falcon.synthetic.crowdstrike.com', port: ${address.port}, path: '/',
        lookup() { throw new Error('UNGUARDED_LOOKUP'); } }, response => {
        response.on('data', chunk => process.stdout.write(chunk));
      }).on('error', error => { throw error; });`)
    expect(result).toMatchObject({ code: 0, stdout: 'synthetic-loopback-bytes' })
  } finally { server.close(); await once(server, 'close') }
})

test('Falcon test guard survives the explicit child environment used by Runner', async () => {
  const source = `import https from 'node:https';
    try { https.request({ hostname: 'api.crowdstrike.com', lookup() { throw new Error('UNGUARDED_LOOKUP'); } }); }
    catch (error) { console.log(error.code ?? error.message); }`
  const result = await child(`await import(${JSON.stringify(guard)});
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(source)}], { env: { NODE_OPTIONS: '--max-old-space-size=64' }, stdio: 'inherit' });
    child.on('close', code => { process.exitCode = code; });`)
  expect(result).toMatchObject({ code: 0, stdout: 'FALCON_TEST_NON_LOOPBACK\n' })
})
