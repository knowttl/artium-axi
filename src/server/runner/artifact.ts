import { readFile } from 'node:fs/promises'
import { decode } from '@toon-format/toon'
import { z } from 'zod'
import type { TransferScope } from '../../shared/api.js'
import { transferPreviewSchema, transferTool, transferWarningFor } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import type { PreparedCall } from '../adapters/types.js'
import type { ArtifactReservation, NativeArtifactEvidence, NativeArtifactIdentity } from '../artifacts.js'
import { ArtifactGenerationFailure } from '../artifacts.js'
import type { RunContext } from './run.js'
import { RunnerError } from './runner.js'
import type { Runner, RunnerResult } from './runner.js'
import { logRun } from './log.js'

const completionSchema = z.object({ id: z.string(), type: z.string(), output: z.string(),
  bytes: z.number().int().nonnegative(), auditId: z.uuid() })
const recordSchema = z.object({ kind: z.enum(['intent', 'outcome']), time: z.iso.datetime(),
  auditId: z.uuid(), intentKey: z.string().regex(/^[a-f0-9]{64}$/), profile: z.string(),
  operation: z.string(), target: z.string().regex(/^[a-f0-9]{64}$/), effect: z.literal('write'),
  result: z.enum(['SUCCESS', 'FAILED', 'NOT_SENT', 'OUTCOME_UNKNOWN']).optional(), status: z.number().int().optional() })

function nativeConfirmation(scope: TransferScope, output: string, confirm: string) {
  // Native confirmation is canonical JSON, including its destination-bound
  // target digest. Never generate, normalize or replace the original string.
  const confirmation = z.tuple([z.string(), z.string(), z.record(z.string(), z.string()),
    z.string().regex(/^[a-f0-9]{64}$/)]).parse(JSON.parse(confirm))
  if (confirmation[1] !== scope.selection.operation || confirmation[2].output !== output
    || confirmation[2].type !== scope.selection.type
    || confirmation[2][scope.selection.operation === 'hash-download-bin' ? 'sha256' : 'id'] !== scope.selection.selector) {
    throw new Error('Mismatched confirmation')
  }
  return confirmation
}

async function nativeJournal(path: string | undefined, scope: TransferScope, output: string, confirm: string, auditId: string) {
  const confirmation = nativeConfirmation(scope, output, confirm)
  if (!path) throw new Error('Missing journal')
  const content = await readFile(path, 'utf8')
  if (!content.endsWith('\n')) throw new Error('Incomplete journal')
  const records = content.trim().split('\n').map(line => recordSchema.parse(JSON.parse(line)))
    .filter(record => record.auditId === auditId)
  const [intent, outcome] = records
  if (records.length !== 2 || intent.kind !== 'intent' || intent.result !== undefined || intent.status !== undefined
    || outcome.kind !== 'outcome' || intent.intentKey !== outcome.intentKey
    || records.some(record => record.operation !== scope.selection.operation || record.profile !== confirmation[0]
      || record.target !== confirmation[3])) throw new Error('Missing native evidence')
  return outcome
}

function nativeArguments(scope: TransferScope, output: string): string[] {
  if (transferTool(scope.selection.operation) === 'beyondtrust-axi') return [
    ...scope.selection.operation.split('.'), ...(scope.selection.operation === 'api-definition.download' ? [] : [scope.selection.selector]), '--out', output]

  if (transferTool(scope.selection.operation) === 'mg-axi') {
    const [mailbox, message, attachment] = scope.selection.selector.split('/')
    return ['mail', attachment ? 'attachment' : 'message', attachment ? 'save' : 'export',
      '--mailbox', mailbox, '--id', message, ...(attachment ? ['--attachment', attachment] : []), '--out', output]
  }
  if (transferTool(scope.selection.operation) === 'checkpoint-axi') {
    const selection = scope.selection
    const [entity, attachment] = selection.selector.split('/')
    return [selection.operation === 'email.download' ? 'email' : 'attachment',
      selection.operation === 'attachment.download-all' ? 'download-all' : 'download', entity,
      ...(selection.operation === 'attachment.download' ? [attachment] : []),
      ...(selection.type === 'original' ? ['--original'] : []), '--out', output]
  }
  return [scope.selection.operation === 'hash-download-bin' ? 'hash' : 'report', 'file', scope.selection.selector,
    ...(scope.selection.operation === 'hash-download-bin' ? [] : ['--type', scope.selection.type]), '--output', output]
}

function hostedConfirmation(scope: TransferScope): string {
  return JSON.stringify([scope.transferId, scope.targetDigest, scope.credentialRevision, scope.selection, scope.expiresAt])
}

export async function previewNativeArtifact(reservation: ArtifactReservation, runner: Runner,
  prepare: (args: string[]) => Promise<PreparedCall>, authorize: () => void,
  context: Pick<RunContext, 'signal' | 'requestId'>) {
  return reservation.preview(async (output, signal) => {
    const profile = await prepare(nativeArguments(reservation.scope, output))
    if (transferTool(reservation.scope.selection.operation) !== 'hybrid-axi') {
      // Preparation resolves credentials and policy but never launches the native
      // downloader. The host binds the full selection and destination because
      // native confirmation alone does not bind both for these tools.
      authorize()
      return transferPreviewSchema.parse({ transferId: reservation.scope.transferId,
        expiresAt: reservation.scope.expiresAt, targetDigest: reservation.scope.targetDigest,
        confirm: hostedConfirmation(reservation.scope), warnings: ['mg-axi', 'beyondtrust-axi'].includes(transferTool(reservation.scope.selection.operation))
          ? [transferWarningFor(reservation.scope.selection.operation)] : [
          'Host-owned confirmation. Download once, save only; do not extract or execute. Native SHA-256 verification is mandatory; live scopes and email/ZIP hash availability remain unverified. ZIP responses may contain only some attachments.',
        ] })
    }
    const result = await logRun({ requestId: context.requestId, tool: transferTool(reservation.scope.selection.operation) }, () =>
      runner.run(reservation.scope.userId, profile.executable, profile.args, profile.environment,
        profile.secrets, { ...profile.limits, signal }, {}, profile.files, authorize))
    if (result.exitCode !== 0 || result.truncated.stdout || result.truncated.stderr) throw new ArtiumError('UNKNOWN_OUTCOME')
    try {
      const preview = z.object({ kind: z.literal('dry-run'), preview: z.object({ confirm: z.string(), warnings: z.array(z.string()) }) })
        .parse(decode(result.stdout)).preview
      nativeConfirmation(reservation.scope, output, preview.confirm)
      return transferPreviewSchema.parse({ ...preview, transferId: reservation.scope.transferId,
        expiresAt: reservation.scope.expiresAt, targetDigest: reservation.scope.targetDigest })
    } catch { throw new ArtiumError('UNKNOWN_OUTCOME') }
  }, context.signal)
}

// Internal handoff only. The public adapter still refuses every download route.
// Authorization/profile construction remains with the authenticated request owner.
export async function executeNativeArtifact(reservation: ArtifactReservation, runner: Runner,
  prepare: (args: string[]) => Promise<PreparedCall>, confirm: string, authorize: () => void,
  context: Pick<RunContext, 'signal' | 'requestId'>) {
  const scope = reservation.scope
  return reservation.execute(async (output, signal): Promise<NativeArtifactEvidence> => {
    let launched = false
    let result: RunnerResult | undefined
    let profile: PreparedCall | undefined
    const run = (prepared: PreparedCall) => logRun({ requestId: context.requestId, tool: transferTool(scope.selection.operation) }, () =>
      runner.run(scope.userId, prepared.executable, prepared.args, prepared.environment, prepared.secrets,
        { ...prepared.limits, signal }, {}, prepared.files, () => { authorize(); launched = true }))
    try {
      if (transferTool(scope.selection.operation) === 'mg-axi') {
        if (confirm !== hostedConfirmation(scope)) throw new ArtiumError('INVALID_INPUT')
        const target = scope.selection.selector.split('/').at(-1)!
        profile = await prepare([...nativeArguments(scope, output), '--execute', '--confirm', target])
        result = await run(profile)
        if (result.exitCode !== 0 || result.timedOut || result.truncated.stdout || result.truncated.stderr) throw new ArtiumError('UNKNOWN_OUTCOME')
        const completion = z.strictObject({ path: z.literal(output), size: z.number().int().nonnegative().max(50 * 1024 * 1024),
          sha256: z.string().regex(/^[a-f0-9]{64}$/), contentType: z.string(), kind: z.literal(scope.selection.type) }).parse(decode(result.stdout))
        const journal = await readFile(profile.environment.MG_AXI_WRITE_LOG, 'utf8')
        if (!journal.endsWith('\n')) throw new Error('Incomplete journal')
        const records = journal.trim().split('\n').map(line => z.object({ id: z.uuid(), intentKey: z.string(),
          operation: z.literal(scope.selection.operation), target: z.literal('[mail resource]'),
          method: z.literal('GET'), effect: z.literal('disruptive'), kind: z.enum(['intent', 'outcome']),
          outcome: z.literal('SUCCESS').optional() }).parse(JSON.parse(line)))
        const [intent, outcome] = records
        if (records.length !== 2 || intent.kind !== 'intent' || intent.outcome !== undefined || outcome.kind !== 'outcome'
          || outcome.outcome !== 'SUCCESS' || intent.id !== outcome.id || intent.intentKey !== outcome.intentKey) throw new Error('Missing native evidence')
        return { archiveBytes: completion.size, verifiedSha256: completion.sha256,
          nativeAuditId: intent.id, nativeJournalResult: 'SUCCESS' }
      }
      if (['checkpoint-axi', 'beyondtrust-axi'].includes(transferTool(scope.selection.operation))) {
        if (confirm !== hostedConfirmation(scope)) throw new ArtiumError('INVALID_INPUT')
        profile = await prepare(nativeArguments(scope, output))
        result = await run(profile)
        if (result.exitCode !== 0 || result.timedOut || result.truncated.stdout || result.truncated.stderr) throw new ArtiumError('UNKNOWN_OUTCOME')
        const completion = z.strictObject({ path: z.literal(output), size: z.number().int().nonnegative().max(50 * 1024 * 1024),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          ...(transferTool(scope.selection.operation) === 'beyondtrust-axi' ? { contentType: z.string() } : {}) }).parse(decode(result.stdout))
        // The shared store independently hashes and checks the private file.
        // Null native fields explicitly distinguish host evidence from a journal.
        return { archiveBytes: completion.size, verifiedSha256: completion.sha256,
          nativeAuditId: null, nativeJournalResult: null }
      }
      const args = [...nativeArguments(scope, output), '--execute', '--confirm', confirm]
      profile = await prepare(args)
      result = await run(profile)
      if (result.exitCode !== 0 || result.timedOut || result.truncated.stdout || result.truncated.stderr) {
        throw new ArtiumError('UNKNOWN_OUTCOME')
      }
      const completion = completionSchema.parse(decode(result.stdout))
      if (completion.id !== scope.selection.selector || completion.type !== scope.selection.type || completion.output !== output) {
        throw new Error('Mismatched native completion')
      }
      const outcome = await nativeJournal(profile.environment.HYBRID_AXI_WRITE_LOG, scope, output, confirm, completion.auditId)
      if (outcome.result !== 'SUCCESS' || outcome.status === undefined || outcome.status < 200 || outcome.status >= 300) {
        throw new Error('Missing successful native evidence')
      }
      return { archiveBytes: completion.bytes, nativeAuditId: completion.auditId, nativeJournalResult: 'SUCCESS' }
    } catch (error) {
      const notSent = error instanceof RunnerError ? !error.processStarted : !launched
      let outcome: ArtifactGenerationFailure['outcome'] = notSent ? 'denied-not-sent' : 'native-outcome-unknown'
      let evidence: NativeArtifactIdentity | undefined
      if (profile && result && result.exitCode !== 0 && !result.truncated.stdout) {
        try {
          const failure = z.object({ error: z.object({ auditId: z.uuid(), code: z.string().optional(),
            status: z.number().optional(), keyLevel: z.string().optional() }) }).parse(decode(result.stdout))
          const native = await nativeJournal(profile.environment.HYBRID_AXI_WRITE_LOG, scope, output, confirm, failure.error.auditId)
          if (native.result === 'FAILED' && native.status !== undefined && native.status >= 300 && native.status <= 599) outcome = 'upstream-failure'
          if (native.result === 'NOT_SENT' && native.status === undefined) outcome = 'denied-not-sent'
          if (native.result) evidence = { nativeAuditId: failure.error.auditId, nativeJournalResult: native.result }
          if (native.result === 'FAILED' && native.status === 403 && failure.error.status === 403) {
            error = new ArtiumError(failure.error.code === 'KEY_LEVEL_RESTRICTED'
              && failure.error.keyLevel === 'restricted' ? 'KEY_LEVEL_RESTRICTED' : 'PERMISSION_DENIED')
          }
        } catch { /* Missing or contradictory evidence stays unknown. */ }
      }
      throw new ArtifactGenerationFailure(outcome, error instanceof ArtiumError ? error : new ArtiumError('UNKNOWN_OUTCOME'), evidence)
    }
  }, context.signal)
}
