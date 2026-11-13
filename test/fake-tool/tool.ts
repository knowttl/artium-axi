import { fileURLToPath } from 'node:url'
import { createFalconAdapter, falconManifest } from '../../src/server/adapters/falcon.js'
import { ArtiumError } from '../../src/shared/errors.js'
import type { SecretSource } from '../../src/server/store/secret-source.js'
import type { RunnerInput } from '../../src/server/runner/input.js'
import type { Adapter } from '../../src/server/adapters/types.js'

// Tests register this descriptor explicitly. Production has no fake registry entry.
export const fakeTool = {
  executable: process.execPath,
  args: [fileURLToPath(new URL('./fake-axi.mjs', import.meta.url))],
}

// Generic runner/API scenarios use the fixture's commands, with the real profile writer.
// Published Falcon command admission is tested by the adapter and isolated service probes.
export function createRunnerTestAdapter(source: SecretSource, runFake: boolean | { readyFile: string } = false): Adapter<unknown> {
  const adapter = createFalconAdapter(source)
  const validateArgs = (args: readonly string[], input: RunnerInput = {}) => {
    if (input.files?.length) throw new ArtiumError('UNSUPPORTED_INPUT')
    if (falconManifest.blockedCommands.includes(args[0]) || falconManifest.blockedCommands.includes(args.slice(0, 2).join(' '))
      || args.some(token => token === '--' || token.startsWith('--') && falconManifest.unsafeOverrides.includes(token.slice(2).split('=')[0]))) {
      throw new ArtiumError('FLAG_BLOCKED')
    }
  }
  return { ...adapter, validateArgs, executesWrite: () => false,
    sensitiveArguments: () => ({ flags: ['--client-id', '--client-secret'], positions: [] }),
    async prepare(args: readonly string[], reference: Parameters<typeof adapter.prepare>[1], input?: RunnerInput) {
    validateArgs(args, input)
    const prepared = await adapter.prepare(['detection', 'list'], reference)
    const fake = typeof runFake === 'object' ? { executable: fakeTool.executable, args: [...fakeTool.args, 'sleep', '60000'],
      environment: { ...prepared.environment, ARTIUM_TEST_READY_FILE: runFake.readyFile } }
      : runFake ? { executable: fakeTool.executable, args: [...fakeTool.args, 'print', 'synthetic result'] } : { args: [...args] }
    return { ...prepared, ...fake, invocation: undefined }
  } }
}
