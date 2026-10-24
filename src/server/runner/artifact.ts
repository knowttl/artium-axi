import { readFile } from 'node:fs/promises'
import { decode } from '@toon-format/toon'
import { z } from 'zod'
import type { TransferScope } from '../../shared/api.js'
import { transferPreviewSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import type { PreparedCall } from '../adapters/types.js'
import type { ArtifactReservation, NativeArtifactEvidence, NativeArtifactIdentity } from '../artifacts.js'
import { ArtifactGenerationFailure } from '../artifacts.js'
import type { RunContext } from './run.js'
import { RunnerError } from './runner.js'
import type { Runner, RunnerResult } from './runner.js'

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
  return [scope.selection.operation === 'hash-download-bin' ? 'hash' : 'report', 'file', scope.selection.selector,
    ...(scope.selection.operation === 'hash-download-bin' ? [] : ['--type', scope.selection.type]), '--output', output]
}

export async function previewNativeArtifact(reservation: ArtifactReservation, runner: Runner,
  prepare: (args: string[]) => Promise<PreparedCall>, authorize: () => void,
  context: Pick<RunContext, 'signal'> = {}) {
  return reservation.preview(async (output, signal) => {
    const profile = await prepare(nativeArguments(reservation.scope, output))
    const result = await runner.run(reservation.scope.userId, profile.executable, profile.args, profile.environment,
      profile.secrets, { ...profile.limits, signal }, {}, profile.files, authorize)
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
  context: Pick<RunContext, 'signal'> = {}) {
  const scope = reservation.scope
  return reservation.execute(async (output, signal): Promise<NativeArtifactEvidence> => {
    let launched = false
    let result: RunnerResult | undefined
    let profile: PreparedCall | undefined
    try {
      const args = [...nativeArguments(scope, output), '--execute', '--confirm', confirm]
      profile = await prepare(args)
      result = await runner.run(scope.userId, profile.executable, profile.args, profile.environment, profile.secrets,
        { ...profile.limits, signal }, {}, profile.files, () => { authorize(); launched = true })
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
          const failure = z.object({ error: z.object({ auditId: z.uuid() }) }).parse(decode(result.stdout))
          const native = await nativeJournal(profile.environment.HYBRID_AXI_WRITE_LOG, scope, output, confirm, failure.error.auditId)
          if (native.result === 'FAILED' && native.status !== undefined && native.status >= 300 && native.status <= 599) outcome = 'upstream-failure'
          if (native.result === 'NOT_SENT' && native.status === undefined) outcome = 'denied-not-sent'
          if (native.result) evidence = { nativeAuditId: failure.error.auditId, nativeJournalResult: native.result }
        } catch { /* Missing or contradictory evidence stays unknown. */ }
      }
      throw new ArtifactGenerationFailure(outcome, error instanceof ArtiumError ? error : new ArtiumError('UNKNOWN_OUTCOME'), evidence)
    }
  }, context.signal)
}
