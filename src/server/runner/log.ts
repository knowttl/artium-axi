import { ArtiumError } from '../../shared/errors.js'
import { toolFailureCode } from '../health/diagnostic.js'
import { log } from '../log.js'
import { RunnerError, type RunnerResult } from './runner.js'

export async function logRun(context: { requestId: string, tool: string },
  execute: (observe: (call: () => Promise<RunnerResult>) => Promise<RunnerResult>) => Promise<RunnerResult>): Promise<RunnerResult> {
  const started = Date.now()
  let result: RunnerResult | undefined
  let observed: { exitCode: number | null, durationMs: number, stdoutBytes: number, stderrBytes: number, truncated: boolean } | undefined
  const observe = async (call: () => Promise<RunnerResult>): Promise<RunnerResult> => {
    try {
      const execution = await call()
      observed ??= { exitCode: execution.exitCode, durationMs: execution.durationMs,
        stdoutBytes: execution.outputBytes.stdout, stderrBytes: execution.outputBytes.stderr,
        truncated: execution.truncated.stdout || execution.truncated.stderr }
      return execution
    } catch (error) {
      const failure = error instanceof RunnerError ? error : undefined
      observed ??= { exitCode: null, durationMs: failure?.durationMs ?? Date.now() - started,
        stdoutBytes: failure?.outputBytes?.stdout ?? 0, stderrBytes: failure?.outputBytes?.stderr ?? 0,
        truncated: failure?.code === 'OUTPUT_LIMIT' }
      throw error
    }
  }
  let outcome = 'INTERNAL_ERROR'
  let errorCode: string | null = null
  try {
    result = await observe(() => execute(observe))
    errorCode = result.exitCode === 0 ? null : toolFailureCode(result.stdout, result.stderr) ?? null
    outcome = errorCode === 'OUTCOME_UNKNOWN' ? 'UNKNOWN_OUTCOME' : 'completed'
    return result
  } catch (error) {
    outcome = error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR'
    errorCode = outcome
    throw error
  } finally {
    log(outcome === 'completed' && result?.exitCode === 0 ? 'info' : 'warn', 'run', {
      ...context, outcome, errorCode, ...observed,
    })
  }
}
