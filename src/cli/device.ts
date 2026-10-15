import { setTimeout } from 'node:timers/promises'
import { devicePollResponseSchema, deviceStartResponseSchema } from '../shared/api.js'
import { ArtiumError } from '../shared/errors.js'
import type { Client } from './http.js'

export async function ssoLogin(client: Client) {
  const parsed = deviceStartResponseSchema.safeParse(await client.request('/v1/auth/device', 'POST', {}))
  if (!parsed.success) throw new ArtiumError('INVALID_RESPONSE')
  const device = parsed.data
  if (device.verificationUri !== client.serverUrl + '/device') throw new ArtiumError('INVALID_RESPONSE')
  process.stdout.write(`status: approval-required\nopen: ${JSON.stringify(device.verificationUri)}\ncode: ${device.userCode}\nexpires: ${new Date(device.expiresAt).toISOString()}\n`)
  process.stderr.write('Waiting for browser approval. Approve only the code shown on your own terminal.\n')
  while (Date.now() < device.expiresAt) {
    const response = devicePollResponseSchema.safeParse(await client.request('/v1/auth/device/poll', 'POST', { deviceCode: device.deviceCode }))
    if (!response.success || response.data.status === 'password-change-required') throw new ArtiumError('INVALID_RESPONSE')
    if (response.data.status === 'authenticated') {
      const session = response.data
      await client.sessions.locked(async () => { client.sessions.write(session) })
      process.stdout.write(`status: authenticated\nsession-ends: ${new Date(session.familyExpiresAt).toISOString()}\nnext: artium-axi tools\n`)
      return
    }
    await setTimeout(Math.min(device.intervalMs, Math.max(0, device.expiresAt - Date.now())))
  }
  throw new ArtiumError('DEVICE_CODE_EXPIRED')
}
