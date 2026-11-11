import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { validateFileInput } from '../../shared/file-input.js'
import { decode, encode } from '@toon-format/toon'
import { runInputSchema, runRequestSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import type { Adapter, PreparedCall } from '../adapters/types.js'
import { prepareRunJournal } from '../adapters/run-journal.js'
import type { Audit, AuditEvent } from '../audit/audit.js'
import { verifyAccessFamily, verifyAccessToken, verifyPrincipal } from '../auth/tokens.js'
import { authorizeDelegatedCall, authorizeDelegatedOperation, credentialIssuingCommand, delegatedDiscovery, delegatedDiscoveryRequest, delegatedInstanceIds, delegationIncludesTool } from '../auth/delegations.js'
import type { CredentialReference } from '../store/credential-store.js'
import type { IdentityResolver } from '../policy/identity-resolver.js'
import { checkRawApiPolicy, checkToolPolicy } from '../policy/policy.js'
import { checkShodanQueryCredits } from '../policy/shodan-stream.js'
import { RunnerError } from './runner.js'
import type { Runner, RunnerResult, RunnerLimits } from './runner.js'
import { toolFailure, toolFailureCode } from '../health/diagnostic.js'
import { readCredentialTrust } from '../store/trusted-certificates.js'
import { hostedStatus } from '../adapters/hosted-status.js'
import { logRun } from './log.js'
import { readRawApiCall, upstreamStatus } from '../policy/raw-api.js'
import type { ProtectedResults } from '../protected-results.js'
import { kubernetesRequestCommand } from './kubernetes-requests.js'
import { proxmoxTrust, type ProxmoxAccess } from './proxmox.js'

export interface RunContext {
  requestId: string
  clientAddress: string | null
  signal?: AbortSignal
  protectedResults?: ProtectedResults
  proxmox?: ProxmoxAccess
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
): Promise<RunnerResult & { instance?: string }> {
  return logRun({ requestId: context.requestId, tool: adapter.name }, async observe => {
    let userId: string | null = null
    let delegationId: string | null = null
    let familyId: string | undefined
    let readOnly = false
    let instanceReadOnly = false
    let rawReadWrites = false
    let credentialCommands: string[] = []
    let reference: CredentialReference | undefined
    let resolutionFailure: { error: unknown, credentialId?: string, instance?: string } | undefined
    let continuation: ReturnType<NonNullable<Adapter<unknown>['kubernetesContinuation']>>
    let continuationCommand: string | undefined
    let args: string[]
    let instance: string | undefined
    const resolveReference = async (userId: string, delegation: { scopeJson: string } | null | undefined, command?: string) => {
      const selected = await resolver.resolveForRun(userId, adapter.name, instance, delegation, command)
      instanceReadOnly = selected.readOnly
      instance = (db.prepare('SELECT name FROM credentials WHERE id = ?').get(selected.reference.id) as { name: string } | undefined)?.name
      return selected.reference
    }
    let input: { stdin?: string, files?: { name: string, contentBase64: string }[] }
    const started = Date.now()
    let result: RunnerResult
    const apiArgs = request && typeof request === 'object' && 'args' in request && Array.isArray(request.args)
      && request.args.every((value: unknown) => typeof value === 'string') ? request.args as string[] : undefined
    const apiInput = runInputSchema.safeParse(request && typeof request === 'object'
      ? { stdin: 'stdin' in request ? request.stdin : undefined, files: 'files' in request ? request.files : undefined } : {})
    const apiCall = apiArgs && readRawApiCall(adapter, apiArgs, apiInput.success ? apiInput.data : {})
    const apiAudit = apiCall && /artd_[A-Za-z0-9_-]{43}/i.test(JSON.stringify(apiCall)) ? { ...apiCall, method: '', path: null, query: [] } : apiCall
    let apiDecisionRecorded = false
    let apiRoute: string | null = null
    const recordApiDecision = (outcome: 'allowed' | 'refused') => {
      if (!apiAudit || apiDecisionRecorded) return
      audit.record({ event: 'raw-api', userId, delegationId, tool: adapter.name, requestId: context.requestId,
        clientAddress: context.clientAddress, credentialId: reference?.id, instance: reference ? instance : undefined, outcome, route: outcome === 'allowed' ? apiRoute : null, ...apiAudit })
      apiDecisionRecorded = true
    }
    const writeRequested = () => {
      const operations = [adapter.classify(args, input), ...(adapter.nestedOperations?.(args, input) ?? []),
        ...(continuationCommand ? [{ command: continuationCommand, effect: 'write' as const }] : [])]
      const raw = adapter.rawApi?.commands.some(command => operations[0].command === command || args.slice(0, command.split(' ').length).join(' ') === command)
      return operations.some(operation => operation.effect === 'write' || credentialIssuingCommand(adapter.name, operation.command))
        || !!raw && adapter.rawApi?.effect?.(args, input) === 'write'
    }
    try {
      const principal = authenticate === verifyAccessToken ? verifyPrincipal(db, token) : null
      userId = principal?.userId ?? authenticate(db, token)
      delegationId = principal?.delegation?.id ?? null
      familyId = principal?.familyId
      readOnly = principal?.delegation?.readOnly ?? false
      checkToolPolicy(db, userId, adapter.name)
      const parsed = runRequestSchema.safeParse(request)
      if (!parsed.success || parsed.data.instance !== undefined && adapter.prepareForCaller) throw new ArtiumError('INVALID_INPUT')
      instance = parsed.data.instance
      args = parsed.data.args
      input = { stdin: parsed.data.stdin, files: parsed.data.files }
      if (/artd_[A-Za-z0-9_-]{43}/.test(JSON.stringify({ args, stdin: input.stdin, names: input.files?.map(file => file.name) }))
        || input.files?.some(file => /artd_[A-Za-z0-9_-]{43}/.test(Buffer.from(file.contentBase64, 'base64').toString('latin1')))) throw new ArtiumError('INVALID_INPUT')
      if (principal?.delegation && delegatedDiscoveryRequest(adapter, args, input)) {
        if (!delegationIncludesTool(principal.delegation.scopeJson, adapter.name)) throw new ArtiumError('DELEGATED_SCOPE_DENIED')
        adapter.validateArgs(args.length ? args : ['--help'], input)
        validateFileInput(adapter.name, args, input)
        if (!adapter.prepareForCaller && (instance !== undefined || resolver.hasInstances(adapter.name))) reference = await resolveReference(userId, principal?.delegation)
        const discovery = delegatedDiscovery(db, userId, principal.delegation, [adapter], resolver)[0]
        if (!discovery && (resolver.hasInstances(adapter.name) || delegatedInstanceIds(principal.delegation, adapter.name) !== undefined ||
          !delegatedDiscovery(db, userId, principal.delegation, [adapter])[0])) throw new ArtiumError('DELEGATED_SCOPE_DENIED')
        const json = args.includes('--json') || args.includes('--format=json') || args.some((arg, index) => arg === '--format' && args[index + 1] === 'json')
        const stdout = (json ? JSON.stringify : encode)({ tool: adapter.name, commands: discovery?.commands ?? [] }) + '\n'
        return { instance: reference && instance, stdout, stderr: '', exitCode: 0, durationMs: Date.now() - started,
          outputBytes: { stdout: Buffer.byteLength(stdout), stderr: 0 }, timedOut: false, truncated: { stdout: false, stderr: false } }
      }
      adapter.validateArgs(args, input)
      validateFileInput(adapter.name, args, input)
      apiRoute = checkRawApiPolicy(db, userId, adapter, args, input).route
      continuation = adapter.kubernetesContinuation?.(args, input)
      let selectionCommand: string | undefined
      if (principal?.delegation) {
        if (continuation && !continuation.help) {
          if (readOnly || !delegationIncludesTool(principal.delegation.scopeJson, adapter.name)) throw new ArtiumError('DELEGATED_SCOPE_DENIED')
          if (!continuation.root) throw new ArtiumError('TEMP_UNAVAILABLE')
          reference = await resolveReference(userId, principal?.delegation)
          const scope = createHash('sha256').update(JSON.stringify({ userId, family: familyId ?? verifyAccessFamily(db, token), reference })).digest('hex')
          continuationCommand = await kubernetesRequestCommand(continuation.root, scope, continuation.key)
          if (!continuationCommand) throw new ArtiumError('DELEGATED_SCOPE_DENIED')
        }
        const operations = authorizeDelegatedCall(db, userId, principal.delegation, adapter, args, input, continuationCommand, undefined, resolver)
        selectionCommand = operations[0]?.command
        credentialCommands = [...new Set(operations.filter(operation => credentialIssuingCommand(adapter.name, operation.command)).map(operation => operation.command))]
      }
      if (!adapter.prepareForCaller && !reference) {
        try { reference = await resolveReference(userId, principal?.delegation, selectionCommand) }
        catch (error) {
          const named = instance === undefined ? undefined : db.prepare('SELECT id, name FROM credentials WHERE tool = ? AND name = ?').get(adapter.name, instance) as { id: string, name: string } | undefined
          resolutionFailure = { error, credentialId: named?.id, instance: named?.name }
        }
      }
      if (reference) {
        const raw = checkRawApiPolicy(db, userId, adapter, args, input, reference.id)
        rawReadWrites = raw.readWrites
        apiRoute = raw.route
      }
      const executesWrite = (instanceReadOnly || adapter.authorizeOperation) && writeRequested() && (adapter.executesWrite?.(args, input)
        ?? (!args.includes('--help') && !args.includes('--dry-run') && args.some(arg => /^--(?:confirm|execute)(?:=|$)/.test(arg))))
      if (instanceReadOnly && executesWrite) throw new ArtiumError('FLAG_BLOCKED')
      if (executesWrite && adapter.authorizeOperation) {
        const settings = JSON.parse((db.prepare('SELECT native_settings FROM tools WHERE name = ?').get(adapter.name) as { native_settings: string }).native_settings)
        for (const operation of [adapter.classify(args, input), ...adapter.nestedOperations?.(args, input) ?? []]) {
          if (operation.effect === 'write') adapter.authorizeOperation(operation.command, settings)
        }
      }
      if (principal?.delegation && reference) authorizeDelegatedCall(db, userId, principal.delegation, adapter, args, input, continuationCommand, reference.id, resolver)
      if (adapter.name === 'shodan-axi') checkShodanQueryCredits(db, args)
    } catch (error) {
      recordApiDecision('refused')
      const requested = request && typeof request === 'object' && 'instance' in request && typeof request.instance === 'string' ? request.instance : undefined
      const hasInstance = !!request && typeof request === 'object' && 'instance' in request && request.instance !== undefined
      const candidates = userId ? (requested !== undefined
        ? db.prepare('SELECT id, name FROM credentials WHERE tool = ? AND name = ?').all(adapter.name, requested)
        : hasInstance || adapter.prepareForCaller ? [] : db.prepare('SELECT id, name FROM credentials WHERE tool = ? AND enabled = 1 LIMIT 2').all(adapter.name)) as { id: string, name: string }[] : []
      const named = candidates.length === 1 ? candidates[0] : undefined
      audit.record({ event: 'denial', userId, delegationId, tool: adapter.name, requestId: context.requestId,
        clientAddress: context.clientAddress, credentialId: reference?.id ?? named?.id, instance: reference ? instance : named?.name,
        outcome: error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR' })
      throw error
    }
    const identity = { userId, delegationId, tool: adapter.name, requestId: context.requestId, clientAddress: context.clientAddress,
      credentialId: reference?.id ?? resolutionFailure?.credentialId, instance: reference ? instance : resolutionFailure?.instance }
    const family = () => familyId ?? verifyAccessFamily(db, token)
    let apiResultRecorded = false
    const recordApiResult = (done: RunnerResult | undefined) => {
      if (!apiAudit || !done || apiResultRecorded) return
      apiResultRecorded = true
      audit.record({ ...identity, event: 'raw-api-result', outcome: done.exitCode === 0 ? 'success' : 'failure',
        upstreamStatus: upstreamStatus(done.stdout), exitCode: done.exitCode })
    }
    for (const command of credentialCommands) audit.record({ ...identity, event: 'credential-issue', targetId: command, outcome: 'attempt' })
    for (const file of adapter.sensitiveInput?.(args, input) ? [] : input.files ?? []) {
      const bytes = Buffer.from(file.contentBase64, 'base64')
      audit.record({ ...identity, event: 'upload', outcome: 'success', args, sensitive: adapter.sensitiveArguments(args),
        file: { name: file.name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } })
    }
    audit.record({ ...identity, event: 'run-start', outcome: 'started', args, sensitive: adapter.sensitiveArguments(args) })
    let write: PreparedCall['write']
    let journal: Awaited<ReturnType<typeof prepareRunJournal>> | undefined
    let reservation: ReturnType<ProtectedResults['reserve']> | undefined
    let failure: Extract<AuditEvent, { event: 'run-terminal' }>['failure']
    let privateBytes: Buffer | undefined
    let completed: RunnerResult | undefined
    const recordTerminal = (event: Extract<AuditEvent, { event: 'run-terminal' }> & { outputBytes: RunnerResult['outputBytes'] }, primary?: unknown) => {
      try { audit.record(event) }
      catch (error) {
        reservation?.cancel()
        if (primary instanceof Error) {
          Object.defineProperty(primary, 'auditFailure', { value: error })
          return
        }
        const failure = Object.assign(new RunnerError('AUDIT_UNAVAILABLE', undefined, event.completedMutation
          ? `Native audit ID ${event.completedMutation.receipt.auditId}; native status ${event.completedMutation.receipt.status}. Keep the original input and confirmation. Inspect the native journal and trusted state; never replay.` : undefined),
        { recovery: event.completedMutation, durationMs: event.durationMs, outputBytes: event.outputBytes,
          truncated: completed?.truncated ?? { stdout: false, stderr: false }, processStarted: !!completed || !!event.completedMutation })
        Object.defineProperty(failure, 'cause', { value: error })
        throw failure
      }
    }
    try {
      if (resolutionFailure) throw resolutionFailure.error
      const prepared = adapter.prepareForCaller ? await adapter.prepareForCaller(args, userId, input)
        : await adapter.prepare(args, reference!, input, { rawReadWrites })
      const preview = prepared.preview || prepared.effect === 'read' && !prepared.protectedResult
      const writes = () => !prepared.invocation?.help && (prepared.effect === 'write' || !!prepared.write || !preview && writeRequested())
      if (instanceReadOnly && writes()) {
        audit.record({ ...identity, event: 'denial', outcome: 'FLAG_BLOCKED' })
        throw new ArtiumError('FLAG_BLOCKED')
      }
      if ((readOnly || instanceReadOnly) && !(adapter.name === 'vectra-axi' && preview)
        && !(instanceReadOnly && !readOnly && prepared.nativeReadOnlyPreview)) {
        prepared.environment = { ...prepared.environment, [`${adapter.name.toUpperCase().replaceAll('-', '_')}_READ_ONLY`]: 'true' }
      }
      const kubernetesRequests = prepared.kubernetesWorkflowRoot && reference ? {
        root: prepared.kubernetesWorkflowRoot,
        scope: createHash('sha256').update(JSON.stringify({ userId, family: family(), reference })).digest('hex'),
      } : undefined
      const nativeScope = (adapter.name === 'unifi-axi' || adapter.name === 'technitium-axi') && reference
        ? createHash('sha256').update(JSON.stringify({ userId, family: family(), reference })).digest('hex') : undefined
      const credentialConfirmation = prepared.invocation?.command === 'confirm' && !prepared.invocation.help && kubernetesRequests
        && continuation && !continuation.help && credentialIssuingCommand(adapter.name,
          continuationCommand ?? await kubernetesRequestCommand(kubernetesRequests.root, kubernetesRequests.scope, continuation.key) ?? '')
      const protectedResult = prepared.protectedResult?.source === 'pipe' && kubernetesRequests
        && !credentialConfirmation
        ? undefined : prepared.protectedResult
      const recheck = (beforeSpawn = false) => {
        if (authenticate === verifyAccessToken) {
          const current = verifyPrincipal(db, token)
          if (current.delegation) {
            authorizeDelegatedCall(db, current.userId, current.delegation, adapter, args, input, continuationCommand, reference?.id, resolver)
            if (adapter.name === 'proxmox-axi' && protectedResult) {
              authorizeDelegatedOperation(db, current.userId, current.delegation, adapter, { command: 'result take', effect: 'write' }, reference?.id)
            }
          }
        } else authenticate(db, token)
        checkToolPolicy(db, userId, adapter.name, reference?.id)
        const stillReadWrites = checkRawApiPolicy(db, userId, adapter, args, input, reference?.id).readWrites
        if (rawReadWrites && !stillReadWrites) throw new ArtiumError('RAW_API_DENIED')
        if (reference) {
          const current = db.prepare('SELECT enabled, read_only, revision FROM credentials WHERE id = ? AND tool = ?').get(reference.id, adapter.name) as { enabled: number, read_only: number, revision: number } | undefined
          if (!current || current.enabled !== 1 || beforeSpawn && current.revision !== reference.revision) throw new ArtiumError('CREDENTIAL_INVALID')
          if (current.read_only === 1 && writes()) throw new ArtiumError('FLAG_BLOCKED')
        }
      }
      if (prepared.preview || prepared.invocation?.help || !protectedResult && prepared.effect === 'read') {
        for (const command of credentialCommands) audit.record({ ...identity, event: 'credential-issue', targetId: command, outcome: 'preview' })
      }
      if (protectedResult) {
        if (adapter.name === 'proxmox-axi') recheck()
        if (!context.protectedResults || !reference) throw new ArtiumError('UNSUPPORTED_INPUT')
        reservation = context.protectedResults.reserve({ userId, credential: reference, operation: protectedResult.operation,
          delegated: !!delegationId,
          ...(delegationId || ['pipe', 'proxmox'].includes(protectedResult.source) ? { familyId: family() } : {}),
          ...(protectedResult.source === 'proxmox' ? { trustRevision: proxmoxTrust(db, reference) } : {}) })
      }
      write = prepared.write
      const preparedJournal = await prepareRunJournal(prepared.environment, adapter.name, prepared.effect, write)
      journal = preparedJournal
      recordApiDecision('allowed')
      result = await observe(async () => {
        if (prepared.preview) {
          const stdout = encode({ preview: prepared.preview, help: [
            'No operation was sent. Review the exact request, then repeat it with --confirm <confirm> using the value above.',
            'Confirmation applies only to this request, input, credential revision and write policy. Never retry an unknown outcome without checking current state.',
          ] }) + '\n'
          return { stdout, stderr: '', exitCode: 0, durationMs: Date.now() - started,
            outputBytes: { stdout: Buffer.byteLength(stdout), stderr: 0 }, timedOut: false, truncated: { stdout: false, stderr: false } }
        }
        const invoke = (overrides: Partial<RunnerLimits> = {}) => runner.run(identity.userId, prepared.executable, prepared.args, preparedJournal.environment,
          prepared.secrets, { ...prepared.limits, delegated: !!delegationId, publicContent: prepared.publicContent, kubernetesRequests, mutationReceipt: prepared.mutationReceipt,
            unifiScope: adapter.name === 'unifi-axi' ? nativeScope : undefined, trustedIpc: prepared.trustedIpc, signal: context.signal,
            credentialTrust: reference ? readCredentialTrust(db, reference) : [],
            protectedResult: protectedResult?.source === 'file'
              ? { ...protectedResult, receive: bytes => { privateBytes = bytes } } : undefined,
            protectedPipe: protectedResult?.source === 'pipe'
              ? { ...protectedResult, receive: bytes => { privateBytes = Buffer.from(bytes) } } : undefined, ...overrides },
          { ...input, fileArguments: prepared.fileArguments }, prepared.files, () => {
            if (adapter.name === 'shodan-axi') {
              try { checkShodanQueryCredits(db, args) }
              catch (error) {
                audit.record({ ...identity, event: 'denial', outcome: error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR' })
                throw error
              }
            }
            recheck(true)
            if (prepared.beforeSpawn) {
              checkToolPolicy(db, identity.userId, adapter.name, reference?.id)
              prepared.beforeSpawn()
            }
            if ((kubernetesRequests || nativeScope) && reference) {
              recheck(true)
              checkToolPolicy(db, identity.userId, adapter.name, reference?.id)
            }
          }, prepared.pathPrefix)
        if (prepared.proxmox && reference && context.proxmox) {
          return context.proxmox.execute({ userId, familyId: family(), credential: reference,
            requestId: context.requestId, signal: context.signal, delegated: !!delegationId }, prepared, invoke, bytes => { privateBytes = bytes })
        }
        if (prepared.proxmox) throw new ArtiumError('UNSUPPORTED_INPUT')
        return invoke()
      })
      if (!prepared.preview) completed = { ...result, outputBytes: { ...result.outputBytes } }
      if (result.exitCode !== 0 && result.completedMutation) throw Object.assign(new RunnerError('UNKNOWN_OUTCOME'), {
        processStarted: true, durationMs: result.durationMs, outputBytes: result.outputBytes, truncated: result.truncated,
        recovery: result.completedMutation,
      })
      if (protectedResult?.source === 'projection' && result.exitCode === 0) privateBytes = Buffer.from(result.stdout)
      if (privateBytes && reservation && reference) {
        recheck()
        checkToolPolicy(db, userId, adapter.name, reference?.id)
        const current = db.prepare('SELECT revision FROM credentials WHERE id = ? AND tool = ? AND enabled = 1')
          .get(reference.id, adapter.name) as { revision: number } | undefined
        recheck()
        checkToolPolicy(db, userId, adapter.name, reference?.id)
        if (!current || current.revision !== reference.revision) throw new ArtiumError('NOT_FOUND')
        const json = result.stdout.trimStart().startsWith('{')
        const projection = (json ? JSON.parse(result.stdout) : decode(result.stdout)) as Record<string, unknown>
        const resultReference = reservation.commit(privateBytes)
        if (result.exitCode === 0) for (const command of credentialCommands) audit.record({ ...identity, event: 'credential-issue', targetId: command, outcome: 'success' })
        projection.result = resultReference
        result.stdout = (json ? JSON.stringify(projection) : encode(projection)) + '\n'
        result.outputBytes.stdout = Buffer.byteLength(result.stdout)
        audit.record({ ...identity, event: 'protected-result', outcome: 'success', result: resultReference })
      } else reservation?.cancel()
      if (result.exitCode !== 0) failure = {
        diagnostic: toolFailure(result.stdout, result.stderr, result.exitCode, adapter.name).diagnostic,
        secrets: prepared.secrets,
      }
      result = hostedStatus(adapter.name, prepared.invocation, result)
      if (adapter.name === 'awx-axi' && write && result.exitCode !== 0
        && ['CONTROLLER_UNREACHABLE', 'SERVER_BUSY'].includes(toolFailureCode(result.stdout, result.stderr) ?? '')) {
        throw Object.assign(new RunnerError('UNKNOWN_OUTCOME'), { processStarted: true,
          durationMs: result.durationMs, outputBytes: result.outputBytes, truncated: result.truncated })
      }
      if (journal.auditId && result.exitCode !== 0 && !toolFailureCode(result.stdout, result.stderr)) {
        result = unknownWriteResult(await journal.auditId(), result.durationMs, result.outputBytes)
      }
    } catch (error) {
      reservation?.cancel()
      recordApiDecision('refused')
      recordApiResult(completed)
      const runnerError = error instanceof RunnerError ? error : undefined
      const execution = completed ?? (runnerError?.processStarted ? runnerError : undefined)
      const recovery = completed?.completedMutation ?? runnerError?.recovery
      if (write && journal?.auditId && execution && !completed && !recovery) {
        result = unknownWriteResult(await journal.auditId(), execution.durationMs ?? Date.now() - started,
          execution.outputBytes ?? { stdout: 0, stderr: 0 })
      } else {
        const unknownOutcome = !!write && !!execution && (!!completed || !!runnerError
          && ['TIMEOUT', 'CANCELLED', 'PROCESS_SIGNAL', 'SECRET_IN_OUTPUT', 'OUTPUT_LIMIT', 'UNKNOWN_OUTCOME', 'TEMP_UNAVAILABLE'].includes(runnerError.code))
        if (write && unknownOutcome) {
          const command = write.checkArgs.length && ['artium-axi', adapter.name, ...write.checkArgs].map(value =>
            /^[a-zA-Z0-9_./:=,+@%-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`).join(' ')
          const failure = Object.assign(new RunnerError(completed && error instanceof ArtiumError ? error.code : 'UNKNOWN_OUTCOME',
            `Unknown outcome for ${write.operation} ${write.target}.`,
            recovery ? `Native audit ID ${recovery.receipt.auditId}; native status ${recovery.receipt.status}. Keep the original input and confirmation. Reconcile this audit ID with the original binding or inspect state with a trusted read; never replay.`
              : `The operation may have changed state and was not retried. ${command ? `Check current state before trying again: ${command}${write.afterCheck ? '. ' : ''}` : ''}${write.afterCheck ?? ''}`),
          { durationMs: execution.durationMs, outputBytes: execution.outputBytes, processStarted: true,
            truncated: execution.truncated, recovery })
          Object.defineProperty(failure, 'cause', { value: error })
          error = failure
        }
        recordTerminal({ ...identity, event: 'run-terminal', action: await journal?.action(false) ?? 'unknown',
          outcome: unknownOutcome ? 'UNKNOWN_OUTCOME' : error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR',
          errorCode: completed && error instanceof ArtiumError ? error.code : undefined, exitCode: recovery?.exitCode ?? completed?.exitCode ?? null,
          nativeAuditId: recovery?.receipt.auditId, completedMutation: recovery,
          durationMs: execution?.durationMs ?? Date.now() - started,
          outputBytes: execution?.outputBytes ?? { stdout: 0, stderr: 0 }, failure }, error)
        throw error
      }
    } finally { privateBytes?.fill(0) }
    recordApiResult(completed)
    const errorCode = result.exitCode === 0 ? null : toolFailureCode(result.stdout, result.stderr) ?? null
    const outcome = errorCode === 'OUTCOME_UNKNOWN' ? 'UNKNOWN_OUTCOME' : 'completed'
    recordTerminal({ ...identity, event: 'run-terminal', action: await journal?.action(result.exitCode === 0, result.stdout) ?? 'unknown',
      outcome, exitCode: result.exitCode,
      nativeAuditId: result.completedMutation?.receipt.auditId ?? await journal?.auditId?.(), completedMutation: result.completedMutation,
      errorCode,
      durationMs: result.durationMs, outputBytes: result.outputBytes, failure })
    return { ...result, instance: reference && instance }
  })
}
