import { meResponseSchema, toolsResponseSchema } from '../shared/api.js'
import { ArtiumError } from '../shared/errors.js'
import { Client } from './http.js'
import { sessionExpiryView } from './views.js'

const DIAGNOSTIC_REQUEST_DEADLINE_MS = 5_000

export async function doctor(createClient = (deadline: number) => new Client(process.env, undefined, deadline), write = (text: string) => { process.stdout.write(text) }): Promise<void> {
  let failure: ArtiumError | undefined
  const line = (name: string, pass: boolean, detail?: string, error?: ArtiumError) => {
    if (!pass) failure ??= error ?? new ArtiumError('INVALID_RESPONSE')
    write(`${pass ? 'pass' : 'fail'}: ${name}${detail ? ` (${detail})` : ''}\n`)
  }
  let client: Client
  try { client = createClient(DIAGNOSTIC_REQUEST_DEADLINE_MS) }
  catch (error) {
    for (const name of ['server address', 'certificate', 'token', 'CLI version']) line(name, false, 'CLIENT_CONFIG_INVALID')
    throw error
  }
  let addressOk = false
  try {
    const live = await client.request('/health/live', 'GET')
    addressOk = !!live && typeof live === 'object' && 'status' in live && live.status === 'ok'
    line('server address', addressOk, client.serverUrlSource)
    line('certificate', client.certificateVerified, client.certificateVerified ? undefined : 'test HTTP', new ArtiumError('CLIENT_CONFIG_INVALID'))
  } catch (error) {
    const cause = error instanceof ArtiumError ? error : new ArtiumError('INVALID_RESPONSE')
    line('server address', cause.code === 'CERTIFICATE_INVALID', `${client.serverUrlSource}: ${cause.code}`, cause)
    line('certificate', client.certificateVerified, client.certificateVerified ? undefined : cause.code, cause)
  }
  if (!addressOk && failure) throw failure
  let versionOk = true
  let versionError: ArtiumError | undefined
  try { await client.request('/v1/me', 'GET') }
  catch (error) {
    versionOk = error instanceof ArtiumError && error.code === 'TOKEN_INVALID'
    if (!versionOk) versionError = error instanceof ArtiumError ? error : new ArtiumError('INVALID_RESPONSE')
  }
  let tokenOk = false
  let tokenError: ArtiumError | undefined
  let tokenDetail: string | undefined
  try {
    const parsed = meResponseSchema.safeParse(await client.authenticated('/v1/me', 'GET'))
    tokenOk = parsed.success
    if (parsed.success) tokenDetail = `session expires ${sessionExpiryView(parsed.data.sessionExpiresAt)}`
  }
  catch (error) { tokenError = error instanceof ArtiumError ? error : new ArtiumError('INVALID_RESPONSE') }
  line('token', tokenOk, tokenDetail, tokenError)
  line('CLI version', versionOk, undefined, versionError)
  if (tokenOk && versionOk) {
    try {
      const parsed = toolsResponseSchema.safeParse(await client.authenticated('/v1/tools', 'GET'))
      if (!parsed.success) throw new ArtiumError('INVALID_RESPONSE')
      for (const tool of parsed.data.tools) {
        // A re-check is already scheduled after a configuration change; it is pending, not a failure.
        if (tool.status === 'checking') { write(`pass: ${tool.name} (checking)\n`); continue }
        line(tool.name, tool.status === 'ok', tool.status,
          new ArtiumError(tool.status === 'unconfigured' ? 'CREDENTIAL_NOT_CONFIGURED' : tool.status === 'error' ? 'TOOL_FAILED' : tool.status === 'disabled' ? 'TOOL_DISABLED' : 'SERVER_UNAVAILABLE'))
      }
    } catch (error) {
      const cause = error instanceof ArtiumError ? error : new ArtiumError('INVALID_RESPONSE')
      line('tools', false, cause.code, cause)
    }
  }
  if (failure) throw failure
}
