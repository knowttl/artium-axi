import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import inventory from '../../../tools/inventories/technitium-axi.json' with { type: 'json' }
import { classifyCommand } from './classify.js'
import { ArtiumError } from '../../shared/errors.js'
import { runnerLimits, toolPaths } from '../config.js'
import type { SecretSource } from '../store/secret-source.js'
import type { RunnerInput } from '../runner/input.js'
import type { Adapter } from './types.js'
import { CredentialProfile } from './credential-profile.js'
import { invalidCommand, unknownFlag } from './input-diagnostics.js'
import { writePolicy } from './write-policy.js'
import { technitiumInput, technitiumObject } from '../../shared/technitium-input.js'
import { inputLimits } from '../../shared/api.js'
import { RunnerError } from '../runner/runner.js'
import { decode } from '@toon-format/toon'
import { mutationReceiptSchema, type MutationReceipt } from '../../shared/mutation-outcome.js'

export const technitiumProfile = new CredentialProfile(inventory.credentialSchema, 'technitium-axi')
const nativePolicy = writePolicy({ supportedOperations: inventory.writeOperations,
  unlocks: 'Native preview, exact confirmation and reconciliation with independent host and native operation grants.',
  blocked: 'Login acquisition, explicit create-token acquisition, alternate reconciliation profiles and caller state overrides are unavailable.' })
export const technitiumWritePolicy = {
  read: (settings: Record<string, unknown>) => nativePolicy.read({ ...settings, writes: settings.hostWrites }),
  authorize(settings: Record<string, unknown>, operation: string | undefined) {
    nativePolicy.authorize({ ...settings, writes: settings.hostWrites }, allowed => allowed === operation)
    const native = settings.writes as { allowWrites?: boolean, operations?: string[] } | undefined
    if (native?.allowWrites !== true || !native.operations?.includes(operation!)) throw new ArtiumError('FLAG_BLOCKED')
  },
  update(settings: Record<string, unknown>, input: Parameters<typeof nativePolicy.update>[1]) {
    const { writes: profileWrites, ...rest } = settings
    const { writes, ...updated } = nativePolicy.update({ ...rest, writes: settings.hostWrites }, input)
    return { ...updated, ...(profileWrites ? { writes: profileWrites } : {}), hostWrites: writes ?? { allowWrites: false, operations: [] } }
  },
}

// Native private-file validation requires direct absolute paths, so nested uploads
// are resolved inside the fresh call directory before loading the unchanged CLI.
const inputLauncher = `import {readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
const [native,...args]=process.argv.slice(2);
const index=args.indexOf('--input-file');
const source=args[index+1];
const body=JSON.parse(await readFile(source,'utf8'));
delete body.secrets;
if(body.upload) body.upload.file=resolve(dirname(source),body.upload.file);
if(body.parameters.config?.file) body.parameters.config.file=resolve(dirname(source),body.parameters.config.file);
const target=resolve('technitium-native-input.json');
await writeFile(target,JSON.stringify(body),{mode:0o600,flag:'wx'});
args[index+1]=target;
process.argv=[process.execPath,native,...args];
await import(pathToFileURL(native).href);
`

function argumentsForCall(args: readonly string[], input: RunnerInput = {}) {
  if (input.stdin !== undefined) throw new ArtiumError('UNSUPPORTED_INPUT')
  if (args.some(arg => arg.startsWith('--') && inventory.adapterBoundary.unsafeOverrides.includes(arg.slice(2).split('=')[0]))) throw new ArtiumError('FLAG_BLOCKED')
  if (args.length === 1 && ['--version', '-v', '-V'].includes(args[0])) {
    if (input.files?.length) throw new ArtiumError('UNSUPPORTED_INPUT')
    return { args: [...args], invocation: { command: 'version', help: false }, operation: undefined, resultSource: undefined,
      write: false, executing: false, body: undefined, confirm: undefined, effect: 'read' as const }
  }
  const firstFlag = args.findIndex(arg => arg.startsWith('-'))
  const words = firstFlag < 0 ? args : args.slice(0, firstFlag)
  const command = words.join(' ')
  if (['user login', 'auth login'].includes(command)) throw new ArtiumError('FLAG_BLOCKED')
  const route = inventory.commands.find(entry => entry.command === command)
  if (!route) throw invalidCommand('technitium-axi', args, inventory.discovery.commands)
  const flags = route.flags as Record<string, string | undefined>
  const seen = new Set<string>()
  const normalized = [...words]
  const values = new Map<string, string>()
  for (let index = firstFlag < 0 ? args.length : firstFlag; index < args.length; index++) {
    const token = args[index]
    const match = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/s.exec(token)
    if (match && inventory.adapterBoundary.unsafeOverrides.includes(match[1])) throw new ArtiumError('FLAG_BLOCKED')
    if (!match || !Object.hasOwn(flags, match[1])) throw unknownFlag('technitium-axi', command, token, Object.keys(flags))
    const [, name, inline] = match
    if (seen.has(name)) throw new ArtiumError('INVALID_INPUT')
    seen.add(name)
    normalized.push(`--${name}`)
    if (flags[name] === 'boolean') {
      if (inline !== undefined) throw new ArtiumError('INVALID_INPUT')
    } else {
      const value = inline ?? args[++index]
      if (value === undefined || (value === '' && name !== 'include-zones') || value.startsWith('-')) throw new ArtiumError('INVALID_INPUT')
      normalized.push(value)
      values.set(name, value)
    }
  }
  const help = seen.has('help')
  const nativeInput = 'nativeInput' in route && route.nativeInput && !help
  const inputName = nativeInput ? values.get('input-file') : undefined
  if (nativeInput && !inputName) throw new ArtiumError('INVALID_INPUT')
  if (!nativeInput && input.files?.length) throw new ArtiumError('UNSUPPORTED_INPUT')
  const body = inputName ? technitiumInput(route.operation!, inputName, input).body : undefined
  const operation = help ? undefined : route.operation === 'OP-077' ? body?.parameters.import === true ? 'OP-077.import' : 'OP-077.resolve' : route.operation
  const write = !!nativeInput && operation !== 'OP-077.resolve'
  const executing = !!nativeInput && (seen.has('execute') || seen.has('reconcile'))
  if (seen.has('execute') && seen.has('reconcile') || seen.has('confirm') && !executing) throw new ArtiumError('INVALID_INPUT')
  if (executing && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.[a-f0-9]{64}$/.test(values.get('confirm') ?? '')) throw new ArtiumError('INVALID_INPUT')
  if (seen.has('reconcile') && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(values.get('reconcile') ?? '')) throw new ArtiumError('INVALID_INPUT')
  return { args: normalized, invocation: { command: command || 'home', help }, operation,
    resultSource: route.resultSource, write, executing, body, confirm: values.get('confirm'),
    effect: write && seen.has('execute') ? 'write' as const : 'read' as const }
}

function authorizeOperation(command: string, settings: Record<string, unknown>, args?: readonly string[], input?: RunnerInput) {
  const call = args && argumentsForCall(args, input)
  const route = inventory.commands.find(route => route.command === command)
  if (call ? call.write : !route || route.effect === 'write' || route.effect === 'conditional')
    technitiumWritePolicy.authorize(settings, call ? call.operation : route?.operation === 'OP-077' ? 'OP-077.import' : route?.operation)
}

async function journalReceipt(call: ReturnType<typeof argumentsForCall>, writeLog: string, tokenKind: unknown, capture: (receipt: MutationReceipt) => void) {
  const handle = await open(join(`${writeLog}.d`, `${call.confirm}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let bytes: Buffer | undefined
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > inputLimits.requestBytes) throw new RunnerError('UNKNOWN_OUTCOME')
    bytes = await handle.readFile()
    if (bytes.length > inputLimits.requestBytes) throw new RunnerError('UNKNOWN_OUTCOME')
    const receiptFields = mutationReceiptSchema.unwrap().shape
    const entry = receiptFields.journal.unwrap().unwrap().extend({
      auditId: receiptFields.auditId,
      operation: z.literal(call.operation!), digest: z.literal(call.confirm!),
      localRemoved: z.boolean().optional(),
      clusterBefore: z.object({ clusterNodes: z.array(z.unknown()) }).optional(),
    }).parse(JSON.parse(bytes.toString('utf8')))
    const cluster = entry.clusterBefore
      ? (await import(pathToFileURL(join(dirname(toolPaths['technitium-axi']), '../dist/cluster.js')).href))
        .clusterPreview(call.operation, call.body!.parameters, { clusterNodes: [] }) : undefined
    const receipt = mutationReceiptSchema.parse({ auditId: entry.auditId, operation: entry.operation,
      status: entry.state === 'completed' ? 'ok' : entry.state,
      ...(tokenKind === 'single-use' && ['completed', 'partial'].includes(entry.state) ? { credential: 'consumed' } : {}),
      ...(entry.state === 'revoke-failed' ? { revoked: false, localRemoved: entry.localRemoved } : {}), cluster,
      journal: { digest: entry.digest, state: entry.state, postconditionHash: entry.postconditionHash, resyncSerial: entry.resyncSerial } })
    capture(receipt)
  } finally { bytes?.fill(0); await handle.close() }
}

export function createTechnitiumAdapter(source: SecretSource, writeLog?: string): Adapter<unknown> {
  return { name: 'technitium-axi', executable: toolPaths['technitium-axi'], credentialProfile: technitiumProfile,
    credentialSchema: technitiumProfile.credentialSchema, timeoutMs: runnerLimits.timeoutMs,
    blockedFlags: inventory.adapterBoundary.unsafeOverrides.map(name => `--${name}`), allowedFlagValues: {},
    sensitiveArguments: args => ({ flags: args.filter(arg => arg.startsWith('--')).map(arg => arg.split('=')[0]), positions: [] }),
    sensitiveInput: () => true,
    validateArgs: (args, input) => { argumentsForCall(args, input) },
    executesWrite: (args, input) => argumentsForCall(args, input).effect === 'write',
    authorizeOperation,
    classify(args, input) {
      const classification = classifyCommand(inventory.commands, (a, i) => argumentsForCall(a, i).invocation, args, input)
      if (classification.command === 'dns-client resolve' && (args.length === 2 || !argumentsForCall(args, input).write))
        return { ...classification, effect: 'read' }
      return classification
    },
    async prepare(args, reference, input) {
      const call = argumentsForCall(args, input)
      if (reference.tool !== 'technitium-axi') throw new ArtiumError('CREDENTIAL_INVALID')
      const settings = source.getSettings?.(reference) ?? {}
      const state = technitiumWritePolicy.read(settings)
      authorizeOperation(call.invocation.command, settings, args, input)
      if (call.body && (!writeLog || !isAbsolute(writeLog))) throw new ArtiumError('TEMP_UNAVAILABLE')
      const credential = await source.getCredential(reference)
      const prepared = technitiumProfile.prepare('technitium-axi', credential, writeLog, !state.enabled)
      const nativeArgs = [toolPaths['technitium-axi'], ...call.args]
      const childArgs = call.body ? ['technitium-input.mjs', ...nativeArgs] : nativeArgs
      if (call.body) {
        prepared.files.push({ name: 'technitium-input.mjs', content: inputLauncher })
        Object.assign(prepared.environment, call.body.secrets)
        prepared.secrets.push(...Object.values(call.body.secrets ?? {}).filter(value => value.length > 0))
      }
      return { ...prepared, executable: process.execPath, args: childArgs, invocation: call.invocation,
        beforeSpawn: () => {
          if (JSON.stringify(source.getSettings?.(reference) ?? {}) !== JSON.stringify(settings)) throw new ArtiumError('FLAG_BLOCKED')
        },
        fileArguments: call.body ? [childArgs.indexOf('--input-file') + 1] : undefined,
        effect: call.effect, protectedResult: call.body
          ? call.executing ? { source: 'file', name: 'technitium-result.bin', flag: '--result-file', operation: call.operation! } : undefined
          : call.operation && call.operation !== 'OP-001'
          ? call.resultSource === 'file'
            ? { source: 'file', name: 'technitium-result.bin', flag: '--result-file', operation: call.operation }
            : { source: 'projection', operation: call.operation } : undefined,
        mutationReceipt: call.effect === 'write' ? async (stdout, capture) => {
          let document: unknown
          try { document = stdout.trimStart().startsWith('{') ? JSON.parse(stdout) : decode(stdout) } catch { return }
          const receipt = mutationReceiptSchema.safeParse(document)
          if (receipt.success && receipt.data.operation === call.operation) return capture(receipt.data)
          if (technitiumObject(document) && technitiumObject(document.error)
            && ['CONFIG_INVALID', 'CONFIG_INSECURE'].includes(String(document.error.code))) {
            try { await journalReceipt(call, writeLog!, technitiumObject(credential) ? credential.tokenKind : undefined, capture) }
            catch (error) {
              const failure = new RunnerError('UNKNOWN_OUTCOME')
              Object.defineProperty(failure, 'cause', { value: error })
              throw failure
            }
          }
        } : undefined,
        ...(call.effect === 'write' ? { write: { operation: call.operation!,
          target: inventory.writeContracts.find(contract => contract.id === call.operation?.split('.')[0])!.path,
          checkArgs: [...call.invocation.command.split(' '), '--help'],
          afterCheck: 'Keep the original input and confirmation. Reconcile with the native audit ID. If credential binding changed, inspect state with a trusted read; never replay.' } } : {}),
        limits: { timeoutMs: runnerLimits.timeoutMs, ...(call.body ? {
          directoryScope: createHash('sha256').update(JSON.stringify({ tool: 'technitium-axi', reference, settings })).digest('hex'),
        } : {}) } }
    } }
}
