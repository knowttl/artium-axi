import { ArtiumError } from '../../shared/errors.js'
import { toolFailureCode } from '../health/diagnostic.js'
import { log } from '../log.js'
import { RunnerError, type RunnerResult } from './runner.js'

export async function logRun(context: { requestId: string, tool: string }, execute: () => Promise<RunnerResult>): Promise<RunnerResult> {
  const started = Date.now()
  let result: RunnerResult | undefined
  let failure: RunnerError | undefined
  let outcome = 'INTERNAL_ERROR'
  let errorCode: string | null = null
  try {
    result = await execute()
    errorCode = result.exitCode === 0 ? null : toolFailureCode(result.stdout, result.stderr) ?? null
    outcome = errorCode === 'OUTCOME_UNKNOWN' ? 'UNKNOWN_OUTCOME' : 'completed'
    return result
  } catch (error) {
    failure = error instanceof RunnerError ? error : undefined
    outcome = error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR'
    errorCode = outcome
    throw error
  } finally {
    log(outcome === 'completed' && result?.exitCode === 0 ? 'info' : 'warn', 'run', {
      ...context, outcome, errorCode, exitCode: result?.exitCode ?? null,
      durationMs: result?.durationMs ?? failure?.durationMs ?? Date.now() - started,
      stdoutBytes: result?.outputBytes.stdout ?? failure?.outputBytes?.stdout ?? 0,
      stderrBytes: result?.outputBytes.stderr ?? failure?.outputBytes?.stderr ?? 0,
      truncated: result ? result.truncated.stdout || result.truncated.stderr : outcome === 'OUTPUT_LIMIT',
    })
  }
}
