import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { encode } from '@toon-format/toon'
import { ZodError } from 'zod'
import { deviceStartResponseSchema, reauthResponseSchema, transferExecuteSchema, transferLimits,
  transferPrepareSchema, transferPreviewSchema, transferRoutes, transferStatusSchema, transferWarning, ssoReauthResponseSchema } from '../shared/api.js'
import { ArtiumError } from '../shared/errors.js'
import { artifactDestination } from './artifact-save.js'
import { Client } from './http.js'
import type { ManagedSession } from './managed-session.js'
import { readPassword } from './password.js'

export async function download(args: string[], output: (text: string) => void, managed?: ManagedSession) {
  const announce = (value: Record<string, unknown>) => {
    const text = encode(value) + '\n'
    if (managed) managed.notice(text)
    else output(text)
  }
  announce({ warning: transferWarning })
  const flags = new Map<string, string>()
  for (let index = 0; index < args.length; index++) {
    const name = args[index]
    if (['--execute', '--password-stdin', '--sso'].includes(name)) flags.set(name, 'true')
    else flags.set(name, args[++index])
  }
  const destination = flags.get('--destination') ?? ''
  const input = transferPrepareSchema.safeParse({ selection: { operation: flags.get('--operation'),
    selector: flags.get('--selector'), type: flags.get('--type') },
    targetDigest: createHash('sha256').update(destination).digest('hex') })
  if (!input.success || !destination || flags.has('--sso') && flags.has('--password-stdin')) throw new ArtiumError('INVALID_INPUT')
  const execute = flags.has('--execute')
  if (execute !== flags.has('--transfer') || execute !== flags.has('--confirm')) throw new ArtiumError('INVALID_INPUT')
  let execution: ReturnType<typeof transferExecuteSchema.parse> | undefined
  if (execute) {
    const parsed = transferExecuteSchema.safeParse({ ...input.data, transferId: flags.get('--transfer'),
      execute: true, confirm: flags.get('--confirm') })
    if (!parsed.success) throw new ArtiumError('INVALID_INPUT')
    execution = parsed.data
  }
  const client = new Client(process.env, managed)
  const local = await artifactDestination(destination)
  const interrupt = () => client.cancel()
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    await client.transferSession(async token => {
      let proof: unknown
      if (flags.has('--sso')) {
        const start = deviceStartResponseSchema.parse(await client.request('/v1/auth/reauth', 'POST', {}, token))
        if (start.verificationUri !== client.serverUrl + '/device') throw new ArtiumError('INVALID_RESPONSE')
        managed?.protect(start.deviceCode)
        announce({ status: 'approval-required', open: start.verificationUri, code: start.userCode, expiresAt: start.expiresAt })
        while (Date.now() < start.expiresAt) {
          try {
            proof = ssoReauthResponseSchema.parse(await client.request('/v1/auth/reauth', 'POST', { deviceCode: start.deviceCode }, token))
            if (reauthResponseSchema.safeParse(proof).success) break
          } catch (error) { if (!(error instanceof ArtiumError) || error.code !== 'DEVICE_POLL_LIMITED') throw error }
          await delay(Math.min(start.intervalMs, Math.max(0, start.expiresAt - Date.now())))
        }
      } else {
        const password = await readPassword(flags.has('--password-stdin'))
        managed?.protect(password)
        proof = await client.request('/v1/auth/reauth', 'POST', { password }, token)
      }
      const { ticket } = reauthResponseSchema.parse(proof)
      managed?.protect(ticket)
      const request = (path: string, body: unknown) => client.request(path, 'POST', body, token, false,
        { 'x-artium-reauth-ticket': ticket })
      if (!execution) {
        const preview = transferPreviewSchema.parse(await request(transferRoutes.prepare.path, input.data))
        if (preview.targetDigest !== input.data.targetDigest) throw new ArtiumError('INVALID_RESPONSE')
        announce({ ...input.data.selection, destination, limits: transferLimits, ...preview, saveOutcome: 'unconfirmed',
          next: 'Repeat this exact selection and destination with --transfer <transferId> --execute --confirm <exact confirm> and recent identity confirmation. No automatic retries.' })
        return
      }
      const retrieval = { ...input.data, transferId: execution.transferId }
      let archive: NonNullable<ReturnType<typeof transferStatusSchema.parse>['archive']> | undefined
      let saved = false
      let receipt = 'unconfirmed'
      try {
        const pending = transferStatusSchema.parse(await request(transferRoutes.status.path, retrieval))
        if (pending.transferId !== execution.transferId || pending.outcome !== 'preview' || pending.archive !== null) throw new ArtiumError('INVALID_RESPONSE')
        announce({ ...input.data.selection, destination, limits: transferLimits,
          expiresAt: pending.expiresAt, saveOutcome: 'unconfirmed' })
        const status = transferStatusSchema.parse(await request(transferRoutes.execute.path, execution))
        if (status.transferId !== execution.transferId || status.expiresAt !== pending.expiresAt
          || status.outcome !== 'ready' || !status.archive) throw new ArtiumError('INVALID_RESPONSE')
        archive = status.archive
        await client.artifact(transferRoutes.retrieve.path, retrieval, token, ticket, status.expiresAt,
          (response, signal) => local.save(response, archive!, signal))
        saved = true
        await local.close()
        try { await request(transferRoutes.receipt.path, { ...retrieval, archive, saveOutcome: 'verified-save' }); receipt = 'confirmed' }
        catch { /* Local publication succeeded; missing server receipt remains unconfirmed. */ }
      } catch (error) {
        if (archive && !saved) {
          try { await request(transferRoutes.receipt.path, { ...retrieval, archive, saveOutcome: 'save-failed' }) }
          catch { /* An interrupted service delivery cannot accept a save receipt. */ }
        }
        try { await request(transferRoutes.cancel.path, retrieval) } catch { /* Server disconnect/expiry also cleans up. */ }
        throw error
      } finally {
        output(encode({ ...input.data.selection, destination, archiveBytes: archive?.archiveBytes ?? null,
          archiveSha256: archive?.archiveSha256 ?? null, saveOutcome: saved ? 'verified-save' : 'save-failed', receipt }) + '\n')
      }
    })
  } catch (error) {
    if (error instanceof ZodError) throw new ArtiumError('INVALID_RESPONSE')
    throw error
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
    await local.close()
  }
}
