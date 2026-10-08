import { meResponseSchema, toolsResponseSchema } from '../shared/api.js'
import { ArtiumError } from '../shared/errors.js'
import { Client } from './http.js'

export async function doctor(): Promise<void> {
  let failed = false
  const line = (name: string, pass: boolean, detail?: string) => {
    failed ||= !pass
    process.stdout.write(`${pass ? 'pass' : 'fail'}: ${name}${detail ? ` (${detail})` : ''}\n`)
  }
  let client: Client
  try { client = new Client() }
  catch {
    for (const name of ['server address', 'certificate', 'token', 'CLI version']) line(name, false, 'CLIENT_CONFIG_INVALID')
    process.exitCode = 1
    return
  }
  try {
    const ready = await client.request('/health/ready', 'GET')
    const ok = !!ready && typeof ready === 'object' && 'status' in ready && ready.status === 'ok'
    line('server address', ok)
    line('certificate', client.serverUrl.startsWith('https:'), client.serverUrl.startsWith('https:') ? undefined : 'test HTTP')
  } catch (error) {
    const code = error instanceof ArtiumError ? error.code : 'INVALID_RESPONSE'
    line('server address', code === 'CERTIFICATE_INVALID', code)
    line('certificate', false, code)
  }
  let versionOk = true
  try { await client.request('/v1/me', 'GET') }
  catch (error) {
    versionOk = error instanceof ArtiumError && error.code === 'TOKEN_INVALID'
  }
  let tokenOk = false
  try { tokenOk = meResponseSchema.safeParse(await client.authenticated('/v1/me', 'GET')).success }
  catch { /* Each diagnostic continues after a failed prerequisite. */ }
  line('token', tokenOk)
  line('CLI version', versionOk)
  if (tokenOk && versionOk) {
    try {
      const parsed = toolsResponseSchema.safeParse(await client.authenticated('/v1/tools', 'GET'))
      if (!parsed.success) throw new ArtiumError('INVALID_RESPONSE')
      for (const tool of parsed.data.tools) line(tool.name, tool.status === 'ok', tool.status)
    } catch (error) { line('tools', false, error instanceof ArtiumError ? error.code : 'INVALID_RESPONSE') }
  }
  process.exitCode = failed ? 1 : 0
}
