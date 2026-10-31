import { toolsResponseSchema } from '../shared/api.js'
import { ArtiumError } from '../shared/errors.js'
import { Client } from './http.js'

// Ambient context excludes identity, roles, server addresses and session metadata.
// Never reuse a cached grant list after an authentication or connectivity failure.
export async function sessionContext(): Promise<string> {
  let client: Client | undefined
  let deadline: NodeJS.Timeout | undefined
  const cancel = () => client?.cancel()
  try {
    client = new Client(process.env, undefined, 5_000)
    deadline = setTimeout(cancel, 5_000)
    process.once('SIGTERM', cancel)
    process.once('SIGINT', cancel)
    const previous = client.sessions.read()
    const parsed = toolsResponseSchema.safeParse(await client.authenticated('/v1/tools', 'GET', undefined, previous))
    if (!parsed.success) throw new ArtiumError('INVALID_RESPONSE')
    const tools = [...new Map(parsed.data.tools.map(tool => [tool.name, tool])).values()]
    return `artium: available\ntools[${tools.length}]{name,status,readOnly}:\n${tools.map(tool =>
      `  ${tool.name},${tool.status},${tool.readOnly ?? true}`).join('\n')}\nnext: artium-axi tools\nnote: Server roles and write gates still apply.\n`
  } catch (error) {
    const code = error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR'
    return `artium: unavailable\nreason: ${code}\nnote: Current tool access could not be verified; no cached grants are shown.\nnext: artium-axi doctor\n`
  } finally {
    clearTimeout(deadline)
    process.off('SIGTERM', cancel)
    process.off('SIGINT', cancel)
  }
}
