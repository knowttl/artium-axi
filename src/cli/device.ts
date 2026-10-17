import { setTimeout } from 'node:timers/promises'
import { devicePollResponseSchema, deviceStartResponseSchema } from '../shared/api.js'
import { ArtiumError } from '../shared/errors.js'
import type { Client } from './http.js'
import type { ManagedSession } from './managed-session.js'

export async function ssoLogin(client: Client, managed?: ManagedSession) {
  const parsed = deviceStartResponseSchema.safeParse(await client.request('/v1/auth/device', 'POST', {}))
  if (!parsed.success) throw new ArtiumError('INVALID_RESPONSE')
  const device = parsed.data
  managed?.protect(device.deviceCode)
  if (device.verificationUri !== client.serverUrl + '/device') throw new ArtiumError('INVALID_RESPONSE')
  process.stdout.write(`status: approval-required\nopen: ${JSON.stringify(device.verificationUri)}\ncode: ${device.userCode}\nexpires: ${new Date(device.expiresAt).toISOString()}\n`)
  process.stderr.write('Waiting for browser approval. Approve only the code shown on your own terminal.\n')
  while (Date.now() < device.expiresAt) {
    try {
      const response = devicePollResponseSchema.safeParse(await client.request('/v1/auth/device/poll', 'POST', { deviceCode: device.deviceCode }))
      if (!response.success || response.data.status === 'password-change-required') throw new ArtiumError('INVALID_RESPONSE')
      if (response.data.status === 'authenticated') {
        const session = response.data
        if (managed) await managed.emit(client.serverUrl, session)
        else await client.sessions.locked(async () => { client.sessions.write(session) })
        const message = `status: authenticated\nsession-ends: ${new Date(session.familyExpiresAt).toISOString()}\nnext: artium-axi tools\n`
        if (managed) managed.write('stdout', message)
        else process.stdout.write(message)
        return
      }
    } catch (error) {
      if (!(error instanceof ArtiumError) || error.code !== 'DEVICE_POLL_LIMITED') throw error
    }
    await setTimeout(Math.min(device.intervalMs, Math.max(0, device.expiresAt - Date.now())))
  }
  throw new ArtiumError('DEVICE_CODE_EXPIRED')
}
