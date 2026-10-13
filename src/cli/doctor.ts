import { meResponseSchema, toolsResponseSchema } from '../shared/api.js'
import { ArtiumError } from '../shared/errors.js'
import { Client } from './http.js'

export async function doctor(): Promise<void> {
  let failure: ArtiumError | undefined
  const line = (name: string, pass: boolean, detail?: string, error?: ArtiumError) => {
    if (!pass) failure ??= error ?? new ArtiumError('INVALID_RESPONSE')
    process.stdout.write(`${pass ? 'pass' : 'fail'}: ${name}${detail ? ` (${detail})` : ''}\n`)
  }
  let client: Client
  try { client = new Client() }
  catch (error) {
    for (const name of ['server address', 'certificate', 'token', 'CLI version']) line(name, false, 'CLIENT_CONFIG_INVALID')
    throw error
  }
  try {
    const live = await client.request('/health/live', 'GET')
    const ok = !!live && typeof live === 'object' && 'status' in live && live.status === 'ok'
    line('server address', ok)
    line('certificate', client.serverUrl.startsWith('https:'), client.serverUrl.startsWith('https:') ? undefined : 'test HTTP', new ArtiumError('CLIENT_CONFIG_INVALID'))
  } catch (error) {
    const cause = error instanceof ArtiumError ? error : new ArtiumError('INVALID_RESPONSE')
    line('server address', cause.code === 'CERTIFICATE_INVALID', cause.code, cause)
    line('certificate', cause.code !== 'CERTIFICATE_INVALID', cause.code === 'CERTIFICATE_INVALID' ? cause.code : undefined, cause)
  }
  let versionOk = true
  let versionError: ArtiumError | undefined
  try { await client.request('/v1/me', 'GET') }
  catch (error) {
    versionOk = error instanceof ArtiumError && error.code === 'TOKEN_INVALID'
    if (!versionOk) versionError = error instanceof ArtiumError ? error : new ArtiumError('INVALID_RESPONSE')
  }
  let tokenOk = false
  let tokenError: ArtiumError | undefined
  try { tokenOk = meResponseSchema.safeParse(await client.authenticated('/v1/me', 'GET')).success }
  catch (error) { tokenError = error instanceof ArtiumError ? error : new ArtiumError('INVALID_RESPONSE') }
  line('token', tokenOk, undefined, tokenError)
  line('CLI version', versionOk, undefined, versionError)
  if (tokenOk && versionOk) {
    try {
      const parsed = toolsResponseSchema.safeParse(await client.authenticated('/v1/tools', 'GET'))
      if (!parsed.success) throw new ArtiumError('INVALID_RESPONSE')
      for (const tool of parsed.data.tools) line(tool.name, tool.status === 'ok', tool.status,
        new ArtiumError(tool.status === 'unconfigured' || tool.status === 'error' ? 'CREDENTIAL_UNAVAILABLE' : tool.status === 'disabled' ? 'TOOL_DISABLED' : 'SERVER_UNAVAILABLE'))
    } catch (error) {
      const cause = error instanceof ArtiumError ? error : new ArtiumError('INVALID_RESPONSE')
      line('tools', false, cause.code, cause)
    }
  }
  if (failure) throw failure
}
