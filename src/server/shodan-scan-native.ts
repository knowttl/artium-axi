import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { ArtiumError } from '../shared/errors.js'
import type { Adapter } from './adapters/types.js'
import { toolPaths } from './config.js'
import { verifyShodanPackage } from './adapters/shodan-package.js'
import { runShodanNative } from './shodan-preview.js'
import type { CredentialReference } from './store/credential-store.js'
import type { z as Zod } from 'zod'
import type { shodanScanInput } from '../shared/shodan-stream.js'

type Input = Zod.infer<typeof shodanScanInput>
const nativePreview = z.object({ status: z.literal('preview'), token: z.uuid(), effects: z.array(z.object({ operation: z.string() })).length(1) }).passthrough()
const nativeResult = z.object({ status: z.string(), scanId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional() }).passthrough()

export async function inspectShodanScan(input: Input) {
  const operation = 'OP-009'
  verifyShodanPackage()
  const words = ['scan', 'submit', input.scope.targets]
  const flags = new Map<string, string | boolean>([['--allow-operation', operation], ['--scan-credit-budget', String(input.scanCreditBudget)],
    ['--max-requests', '1'], ['--accept-unknown-cost', true]])
  if (input.scope.force) flags.set('--force', true)
  try {
    const native = await import(pathToFileURL(resolve(dirname(toolPaths['shodan-axi']), '../dist/mutations.js')).href) as {
      draftMutation: (words: string[], flags: Map<string, string | boolean>) => Promise<{ context?: { targets?: string[], estimatedScanCredits?: number } }>
    }
    const draft = await native.draftMutation(words, flags)
    if (!draft.context?.targets || (draft.context.estimatedScanCredits ?? Infinity) > input.scanCreditBudget) throw new Error('Invalid scan scope')
    return { operation, words, targets: draft.context?.targets ?? [] }
  } catch { throw new ArtiumError('INVALID_INPUT') }
}

export async function shodanMutation(directory: string, adapter: Adapter<unknown>, credential: CredentialReference,
  words: string[], operation: string, budget: number, signal: AbortSignal, authorize: () => void, beforeExecute: () => void, extra: string[] = [], configuredCaPem?: string) {
  const args = [...words, '--json', '--allow-operation', operation, '--accept-unknown-cost',
    '--scan-credit-budget', String(budget), '--max-requests', '1', ...extra]
  const invoke = async (input: string[], beforeSpawn?: () => void) => {
    authorize()
    const profile = await adapter.prepare(['version'], credential)
    try {
      authorize()
      profile.environment.SHODAN_AXI_READ_ONLY = 'false'
      return await runShodanNative(directory, input, profile, signal, authorize, configuredCaPem, beforeSpawn)
    } finally {
      profile.secrets.fill(''); profile.files.length = 0
      for (const key of Object.keys(profile.environment)) delete profile.environment[key]
    }
  }
  const preview = nativePreview.safeParse(await invoke(args))
  if (!preview.success || preview.data.effects[0].operation !== operation) throw new ArtiumError('INVALID_RESPONSE')
  const result = nativeResult.safeParse(await invoke([...args, '--execute', '--confirm', preview.data.token], beforeExecute))
  if (!result.success) throw new ArtiumError('INVALID_RESPONSE')
  return result.data
}

export async function collectShodanEvents(scope: { kind: 'targets', networks: string[] }, events: unknown[]) {
  const path = resolve(dirname(toolPaths['shodan-axi']), '../dist/scan-results.js')
  const native = await import(pathToFileURL(path).href) as { collectScanEvents: (scope: unknown, input: unknown[]) => { events: unknown[], duplicates: number, outOfScope: number } }
  return native.collectScanEvents(scope, events)
}
