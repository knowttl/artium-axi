import type Database from 'better-sqlite3'
import { runRequestSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import type { Adapter } from '../adapters/types.js'
import type { Audit } from '../audit/audit.js'
import { verifyAccessToken } from '../auth/tokens.js'
import type { IdentityResolver } from '../policy/identity-resolver.js'
import { checkToolPolicy } from '../policy/policy.js'
import { RunnerError } from './runner.js'
import type { Runner, RunnerResult } from './runner.js'

export interface RunContext {
  requestId: string
  clientAddress: string | null
  signal?: AbortSignal
}

// The HTTP owner supplies a unique request ID and verified client address.
export async function runTool<Credential>(
  db: Database.Database, audit: Audit, runner: Runner, token: string, request: unknown,
  adapter: Adapter<Credential>, resolver: IdentityResolver, context: RunContext,
): Promise<RunnerResult> {
  let userId: string | null = null
  let args: string[]
  let input: { stdin?: string, files?: { name: string, contentBase64: string }[] }
  try {
    userId = verifyAccessToken(db, token)
    checkToolPolicy(db, userId, adapter.name)
    const parsed = runRequestSchema.safeParse(request)
    if (!parsed.success) throw new ArtiumError('INVALID_INPUT')
    args = parsed.data.args
    input = { stdin: parsed.data.stdin, files: parsed.data.files }
    adapter.validateArgs(args)
  } catch (error) {
    audit.record({ event: 'denial', userId, tool: adapter.name, requestId: context.requestId,
      clientAddress: context.clientAddress, outcome: error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR' })
    throw error
  }
  const identity = { userId, tool: adapter.name, requestId: context.requestId, clientAddress: context.clientAddress }
  audit.record({ ...identity, event: 'run-start', outcome: 'started', args, sensitive: adapter.sensitiveArguments(args) })
  const started = Date.now()
  let result: RunnerResult
  try {
    const reference = await resolver.resolve(userId, adapter.name)
    const prepared = await adapter.prepare(args, reference)
    if (prepared.files.length) throw new ArtiumError('UNSUPPORTED_INPUT')
    result = await runner.run(userId, prepared.executable, prepared.args, prepared.environment,
      prepared.secrets, { ...prepared.limits, signal: context.signal }, input)
  } catch (error) {
    const runnerError = error instanceof RunnerError ? error : undefined
    audit.record({ ...identity, event: 'run-terminal',
      outcome: error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR', exitCode: null,
      durationMs: runnerError?.durationMs ?? Date.now() - started,
      outputBytes: runnerError?.outputBytes ?? { stdout: 0, stderr: 0 } })
    throw error
  }
  audit.record({ ...identity, event: 'run-terminal', outcome: 'completed', exitCode: result.exitCode,
    durationMs: result.durationMs, outputBytes: result.outputBytes })
  return result
}
