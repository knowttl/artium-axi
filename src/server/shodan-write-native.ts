import { join } from 'node:path'
import { z } from 'zod'
import inventory from '../../tools/inventories/shodan-axi.json' with { type: 'json' }
import type { shodanWriteInput } from '../shared/shodan-stream.js'
import { ArtiumError } from '../shared/errors.js'
import type { Adapter } from './adapters/types.js'
import { runShodanNative } from './shodan-preview.js'
import type { CredentialReference } from './store/credential-store.js'

type Input = z.infer<typeof shodanWriteInput>
const nativePreview = z.object({ status: z.literal('preview'), token: z.uuid(), effects: z.array(z.object({
  operation: z.string(), method: z.string(), target: z.string(), networks: z.array(z.string()).optional(),
  notify: z.boolean().optional(), downgrade: z.boolean().optional(),
})).length(1) })
const nativeFailure = z.object({ error: z.string() }).passthrough()
const nativeOutcome = z.object({ status: z.string() }).passthrough()
const invalidInput = ['INVALID_INPUT', 'CREDIT_BUDGET_REQUIRED', 'WRITE_GRANT_REQUIRED']
const bodyFileName = 'artium-write-body.json'

export function shodanWriteOperation(input: Input) {
  if (input.command === 'alert ignore' && input.vulns) return 'OP-070'
  const operation = inventory.confirmedWrites.find(entry => entry.kind === 'write' && entry.command === input.command)?.grants[0]
  if (!operation) throw new ArtiumError('INVALID_INPUT')
  return operation
}

async function invokeShodanWrite(directory: string, adapter: Adapter<unknown>, credential: CredentialReference, input: Input, operation: string,
  confirmation: string | undefined, signal: AbortSignal, authorize: () => void, beforeSpawn: (() => void) | undefined, configuredCaPem?: string) {
  authorize()
  const profile = await adapter.prepare(['version'], credential)
  try {
    authorize()
    profile.environment.SHODAN_AXI_READ_ONLY = 'false'
    if (input.body) profile.files.push({ name: bodyFileName, content: JSON.stringify(input.body) })
    const args = [...input.command.split(' '), ...input.arguments, '--json', '--allow-operation', operation, '--accept-unknown-cost',
      '--query-credit-budget', String(input.queryCreditBudget), '--max-requests', String(input.maxRequests),
      ...input.expires === undefined ? [] : ['--expires', String(input.expires)],
      ...input.vulns ? ['--vulns', input.vulns] : [], ...input.silent ? ['--silent'] : [],
      ...input.body ? ['--body-file', join(directory, 'preview', 'config', bodyFileName)] : [],
      ...confirmation ? ['--execute', '--confirm', confirmation] : []]
    return await runShodanNative(directory, args, profile, signal, authorize, configuredCaPem, beforeSpawn, true)
  } finally {
    profile.secrets.fill(''); profile.files.length = 0
    for (const key of Object.keys(profile.environment)) delete profile.environment[key]
  }
}

function checkedOutcome(value: unknown) {
  const failure = nativeFailure.safeParse(value)
  if (failure.success) {
    if (invalidInput.includes(failure.data.error)) throw new ArtiumError('INVALID_INPUT')
    throw new ArtiumError(['PLAN_STALE', 'PLAN_NOT_FOUND'].includes(failure.data.error) ? 'REVISION_CONFLICT' : 'TOOL_FAILED')
  }
  const outcome = nativeOutcome.safeParse(value)
  if (!outcome.success) throw new ArtiumError('INVALID_RESPONSE')
  return outcome.data
}

export async function previewShodanWrite(directory: string, adapter: Adapter<unknown>, credential: CredentialReference, input: Input,
  operation: string, signal: AbortSignal, authorize: () => void, configuredCaPem?: string) {
  const value = await invokeShodanWrite(directory, adapter, credential, input, operation, undefined, signal, authorize, undefined, configuredCaPem)
  checkedOutcome(value)
  const preview = nativePreview.safeParse(value)
  if (!preview.success || preview.data.effects[0].operation !== operation) throw new ArtiumError('INVALID_RESPONSE')
  return preview.data
}

export async function executeShodanWrite(directory: string, adapter: Adapter<unknown>, credential: CredentialReference, input: Input,
  operation: string, token: string, signal: AbortSignal, authorize: () => void, configuredCaPem?: string) {
  let spawned = false, value: unknown
  try {
    value = await invokeShodanWrite(directory, adapter, credential, input, operation, token, signal, authorize,
      () => { spawned = true }, configuredCaPem)
  } catch (error) {
    throw spawned ? new ArtiumError('UNKNOWN_OUTCOME') : error
  }
  return checkedOutcome(value)
}
