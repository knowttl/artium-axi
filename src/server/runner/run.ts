import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { validateFileInput } from '../../shared/file-input.js'
import { encode } from '@toon-format/toon'
import { runRequestSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import type { Adapter, PreparedCall } from '../adapters/types.js'
import { prepareRunJournal } from '../adapters/run-journal.js'
import type { Audit, AuditEvent } from '../audit/audit.js'
import { verifyAccessToken } from '../auth/tokens.js'
import type { IdentityResolver } from '../policy/identity-resolver.js'
import { checkToolPolicy } from '../policy/policy.js'
import { RunnerError } from './runner.js'
import type { Runner, RunnerResult } from './runner.js'
import { toolFailure, toolFailureCode } from '../health/diagnostic.js'
import { readCredentialTrust } from '../store/trusted-certificates.js'
import { hostedStatus } from '../adapters/hosted-status.js'
import { logRun } from './log.js'

export interface RunContext {
  requestId: string
  clientAddress: string | null
  signal?: AbortSignal
}

function unknownWriteResult(auditId: string, durationMs: number, outputBytes: RunnerResult['outputBytes']): RunnerResult {
  const stdout = encode({ error: { code: 'OUTCOME_UNKNOWN', auditId,
    message: 'Write outcome is unknown; do not replay the request' },
  help: ['Reconcile the durable intent and remote state before taking further action. The operation was not retried.'] }) + '\n'
  return { stdout, stderr: '', exitCode: 1, durationMs, outputBytes, timedOut: false, truncated: { stdout: false, stderr: false } }
}

// The HTTP owner supplies a unique request ID and verified client address.
export async function runTool<Credential>(
  db: Database.Database, audit: Audit, runner: Runner, token: string, request: unknown,
  adapter: Adapter<Credential>, resolver: IdentityResolver, context: RunContext,
  authenticate: (db: Database.Database, token: string) => string = verifyAccessToken,
): Promise<RunnerResult> {
  return logRun({ requestId: context.requestId, tool: adapter.name }, async observe => {
    let userId: string | null = null
    let args: string[]
    let input: { stdin?: string, files?: { name: string, contentBase64: string }[] }
    const started = Date.now()
    let result: RunnerResult
    try {
      userId = authenticate(db, token)
      checkToolPolicy(db, userId, adapter.name)
      const parsed = runRequestSchema.safeParse(request)
      if (!parsed.success) throw new ArtiumError('INVALID_INPUT')
      args = parsed.data.args
      input = { stdin: parsed.data.stdin, files: parsed.data.files }
      adapter.validateArgs(args, input)
      validateFileInput(adapter.name, args, input)
    } catch (error) {
      audit.record({ event: 'denial', userId, tool: adapter.name, requestId: context.requestId,
        clientAddress: context.clientAddress, outcome: error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR' })
      throw error
    }
    const identity = { userId, tool: adapter.name, requestId: context.requestId, clientAddress: context.clientAddress }
    for (const file of input.files ?? []) {
      const bytes = Buffer.from(file.contentBase64, 'base64')
      audit.record({ ...identity, event: 'upload', outcome: 'success', args, sensitive: adapter.sensitiveArguments(args),
        file: { name: file.name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } })
    }
    audit.record({ ...identity, event: 'run-start', outcome: 'started', args, sensitive: adapter.sensitiveArguments(args) })
    let write: PreparedCall['write']
    let journal: Awaited<ReturnType<typeof prepareRunJournal>> | undefined
    let failure: Extract<AuditEvent, { event: 'run-terminal' }>['failure']
    try {
      const reference = await resolver.resolve(userId, adapter.name)
      const prepared = await adapter.prepare(args, reference, input)
      write = prepared.write
      const preparedJournal = await prepareRunJournal(prepared.environment, adapter.name, prepared.effect, write)
      journal = preparedJournal
      result = await observe(async () => {
        if (prepared.preview) {
          const stdout = encode({ preview: prepared.preview, help: [
            'No operation was sent. Review the exact request, then repeat it with --confirm <confirm> using the value above.',
            'Confirmation applies only to this request, input, credential revision and write policy. Never retry an unknown outcome without checking current state.',
          ] }) + '\n'
          return { stdout, stderr: '', exitCode: 0, durationMs: Date.now() - started,
            outputBytes: { stdout: Buffer.byteLength(stdout), stderr: 0 }, timedOut: false, truncated: { stdout: false, stderr: false } }
        }
        return runner.run(identity.userId, prepared.executable, prepared.args, preparedJournal.environment,
          prepared.secrets, { ...prepared.limits, signal: context.signal, credentialTrust: readCredentialTrust(db, reference) },
          { ...input, fileArguments: prepared.fileArguments }, prepared.files, () => { authenticate(db, token) }, prepared.pathPrefix)
      })
      if (result.exitCode !== 0) failure = {
        diagnostic: toolFailure(result.stdout, result.stderr, result.exitCode, adapter.name).diagnostic,
        secrets: prepared.secrets,
      }
      result = hostedStatus(adapter.name, prepared.invocation, result)
      if (journal.auditId && result.exitCode !== 0 && !toolFailureCode(result.stdout, result.stderr)) {
        result = unknownWriteResult(await journal.auditId(), result.durationMs, result.outputBytes)
      }
    } catch (error) {
      const runnerError = error instanceof RunnerError ? error : undefined
      if (write && journal?.auditId && runnerError?.processStarted) {
        result = unknownWriteResult(await journal.auditId(), runnerError.durationMs ?? Date.now() - started,
          runnerError.outputBytes ?? { stdout: 0, stderr: 0 })
      } else {
        if (write && runnerError?.processStarted && ['TIMEOUT', 'CANCELLED', 'PROCESS_SIGNAL', 'SECRET_IN_OUTPUT', 'OUTPUT_LIMIT', 'UNKNOWN_OUTCOME'].includes(runnerError.code)) {
          const command = ['artium-axi', adapter.name, ...write.checkArgs].map(value =>
            /^[a-zA-Z0-9_./:=,+@%-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`).join(' ')
          error = Object.assign(new RunnerError('UNKNOWN_OUTCOME', `Unknown outcome for ${write.operation} ${write.target}.`,
            `The operation may have changed state and was not retried. Check current state before trying again: ${command}${write.afterCheck ? `. ${write.afterCheck}` : ''}`),
          { durationMs: runnerError.durationMs, outputBytes: runnerError.outputBytes, processStarted: runnerError.processStarted,
            truncated: runnerError.truncated })
        }
        audit.record({ ...identity, event: 'run-terminal', action: await journal?.action(false) ?? 'unknown',
          outcome: error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR', exitCode: null,
          durationMs: runnerError?.durationMs ?? Date.now() - started,
          outputBytes: runnerError?.outputBytes ?? { stdout: 0, stderr: 0 }, failure })
        throw error
      }
    }
    const errorCode = result.exitCode === 0 ? null : toolFailureCode(result.stdout, result.stderr) ?? null
    const outcome = errorCode === 'OUTCOME_UNKNOWN' ? 'UNKNOWN_OUTCOME' : 'completed'
    audit.record({ ...identity, event: 'run-terminal', action: await journal?.action(result.exitCode === 0, result.stdout) ?? 'unknown',
      outcome, exitCode: result.exitCode,
      nativeAuditId: await journal?.auditId?.(),
      errorCode,
      durationMs: result.durationMs, outputBytes: result.outputBytes, failure })
    return result
  })
}
