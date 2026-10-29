import type Database from 'better-sqlite3'
import { encode } from '@toon-format/toon'
import { runRequestSchema } from '../../shared/api.js'
import { ArtiumError, type ErrorCode } from '../../shared/errors.js'
import type { Adapter, PreparedCall } from '../adapters/types.js'
import { prepareRunJournal } from '../adapters/run-journal.js'
import type { Audit } from '../audit/audit.js'
import { verifyAccessToken } from '../auth/tokens.js'
import type { IdentityResolver } from '../policy/identity-resolver.js'
import { checkToolPolicy } from '../policy/policy.js'
import { RunnerError } from './runner.js'
import type { Runner, RunnerResult } from './runner.js'
import { toolFailureCode } from '../health/diagnostic.js'
import { readCredentialTrust } from '../store/trusted-certificates.js'
import { hostedStatus } from '../adapters/hosted-status.js'
import { log } from '../log.js'

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
  let userId: string | null = null
  let args: string[]
  let input: { stdin?: string, files?: { name: string, contentBase64: string }[] }
  const started = Date.now()
  let result: RunnerResult | undefined
  let runnerFailure: RunnerError | undefined
  let outcome: 'completed' | ErrorCode = 'INTERNAL_ERROR'
  let errorCode: string | null = null
  try {
    try {
      userId = authenticate(db, token)
      checkToolPolicy(db, userId, adapter.name)
      const parsed = runRequestSchema.safeParse(request)
      if (!parsed.success) throw new ArtiumError('INVALID_INPUT')
      args = parsed.data.args
      input = { stdin: parsed.data.stdin, files: parsed.data.files }
      adapter.validateArgs(args, input)
    } catch (error) {
      audit.record({ event: 'denial', userId, tool: adapter.name, requestId: context.requestId,
        clientAddress: context.clientAddress, outcome: error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR' })
      throw error
    }
    const identity = { userId, tool: adapter.name, requestId: context.requestId, clientAddress: context.clientAddress }
    audit.record({ ...identity, event: 'run-start', outcome: 'started', args, sensitive: adapter.sensitiveArguments(args) })
    let write: PreparedCall['write']
    let journal: Awaited<ReturnType<typeof prepareRunJournal>> | undefined
    try {
      const reference = await resolver.resolve(userId, adapter.name)
      const prepared = await adapter.prepare(args, reference, input)
      write = prepared.write
      journal = await prepareRunJournal(prepared.environment, adapter.name, prepared.effect, write)
      if (prepared.preview) {
        const stdout = encode({ preview: prepared.preview, help: [
          'No operation was sent. Review the exact request, then repeat it with --confirm <confirm> using the value above.',
          'Confirmation applies only to this request, input, credential revision and write policy. Never retry an unknown outcome without checking current state.',
        ] }) + '\n'
        result = { stdout, stderr: '', exitCode: 0, durationMs: Date.now() - started,
          outputBytes: { stdout: Buffer.byteLength(stdout), stderr: 0 }, timedOut: false, truncated: { stdout: false, stderr: false } }
      } else result = await runner.run(userId, prepared.executable, prepared.args, journal.environment,
        prepared.secrets, { ...prepared.limits, signal: context.signal, credentialTrust: readCredentialTrust(db, reference) },
        { ...input, fileArguments: prepared.fileArguments }, prepared.files, () => { authenticate(db, token) }, prepared.pathPrefix)
      result = hostedStatus(adapter.name, prepared.invocation, result)
      if (journal.auditId && result.exitCode !== 0 && !toolFailureCode(result.stdout, result.stderr)) {
        result = unknownWriteResult(await journal.auditId(), result.durationMs, result.outputBytes)
      }
    } catch (error) {
      const runnerError = error instanceof RunnerError ? error : undefined
      runnerFailure = runnerError
      if (write && journal?.auditId && runnerError?.processStarted) {
        result = unknownWriteResult(await journal.auditId(), runnerError.durationMs ?? Date.now() - started,
          runnerError.outputBytes ?? { stdout: 0, stderr: 0 })
      } else {
        if (write && runnerError?.processStarted && ['TIMEOUT', 'CANCELLED', 'PROCESS_SIGNAL', 'SECRET_IN_OUTPUT', 'OUTPUT_LIMIT', 'UNKNOWN_OUTCOME'].includes(runnerError.code)) {
          const command = ['artium-axi', adapter.name, ...write.checkArgs].map(value =>
            /^[a-zA-Z0-9_./:=,+@%-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`).join(' ')
          error = new ArtiumError('UNKNOWN_OUTCOME', `Unknown outcome for ${write.operation} ${write.target}.`,
            `The operation may have changed state and was not retried. Check current state before trying again: ${command}${write.afterCheck ? `. ${write.afterCheck}` : ''}`)
        }
        audit.record({ ...identity, event: 'run-terminal', action: await journal?.action(false) ?? 'unknown',
          outcome: error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR', exitCode: null,
          durationMs: runnerError?.durationMs ?? Date.now() - started,
          outputBytes: runnerError?.outputBytes ?? { stdout: 0, stderr: 0 } })
        throw error
      }
    }
    errorCode = result.exitCode === 0 ? null : toolFailureCode(result.stdout, result.stderr) ?? null
    outcome = errorCode === 'OUTCOME_UNKNOWN' ? 'UNKNOWN_OUTCOME' : 'completed'
    audit.record({ ...identity, event: 'run-terminal', action: await journal?.action(result.exitCode === 0, result.stdout) ?? 'unknown',
      outcome, exitCode: result.exitCode,
      nativeAuditId: await journal?.auditId?.(),
      errorCode,
      durationMs: result.durationMs, outputBytes: result.outputBytes })
    return result
  } catch (error) {
    outcome = error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR'
    errorCode = outcome
    throw error
  } finally {
    log(outcome === 'completed' && result?.exitCode === 0 ? 'info' : 'warn', 'run', {
      requestId: context.requestId, tool: adapter.name, outcome, errorCode,
      exitCode: result?.exitCode ?? null, durationMs: result?.durationMs ?? runnerFailure?.durationMs ?? Date.now() - started,
      stdoutBytes: result?.outputBytes.stdout ?? runnerFailure?.outputBytes?.stdout ?? 0,
      stderrBytes: result?.outputBytes.stderr ?? runnerFailure?.outputBytes?.stderr ?? 0,
      truncated: result ? result.truncated.stdout || result.truncated.stderr : outcome === 'OUTPUT_LIMIT',
    })
  }
}
