import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { validateFileInput } from '../../shared/file-input.js'
import { decode, encode } from '@toon-format/toon'
import { runRequestSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import type { Adapter, PreparedCall } from '../adapters/types.js'
import { prepareRunJournal } from '../adapters/run-journal.js'
import type { Audit, AuditEvent } from '../audit/audit.js'
import { verifyAccessFamily, verifyAccessToken, verifyPrincipal } from '../auth/tokens.js'
import { checkDelegation, credentialIssuingCommand, delegatedDiscovery } from '../auth/delegations.js'
import type { IdentityResolver } from '../policy/identity-resolver.js'
import { checkToolPolicy } from '../policy/policy.js'
import { RunnerError } from './runner.js'
import type { Runner, RunnerResult, RunnerLimits } from './runner.js'
import { toolFailure, toolFailureCode } from '../health/diagnostic.js'
import { readCredentialTrust } from '../store/trusted-certificates.js'
import { hostedStatus } from '../adapters/hosted-status.js'
import { logRun } from './log.js'
import { adoApiAudit } from '../adapters/ado-api.js'
import type { ProtectedResults } from '../protected-results.js'
import { kubernetesCredentialRequest } from './kubernetes-requests.js'
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
): Promise<RunnerResult> {
  return logRun({ requestId: context.requestId, tool: adapter.name }, async observe => {
    let userId: string | null = null
    let delegationId: string | null = null
    let familyId: string | undefined
    let readOnly = false
    let credentialCommand: string | undefined
    let args: string[]
    let input: { stdin?: string, files?: { name: string, contentBase64: string }[] }
    const started = Date.now()
    let result: RunnerResult
    // Audit identifiable mutations even when request limits reject their arguments.
    const apiArgs = request && typeof request === 'object' && 'args' in request && Array.isArray(request.args)
      && request.args.every((value: unknown) => typeof value === 'string') ? request.args as string[] : undefined
    const apiAudit = adapter.name === 'ado-axi' && apiArgs && !/artd_[A-Za-z0-9_-]{43}/.test(JSON.stringify(apiArgs)) ? adoApiAudit(apiArgs) : undefined
    let apiDecisionRecorded = false
    const recordApiDecision = (outcome: 'allowed' | 'refused') => {
      if (!apiAudit || apiDecisionRecorded) return
      audit.record({ event: 'ado-api', userId, delegationId, tool: adapter.name, requestId: context.requestId,
        clientAddress: context.clientAddress, outcome, ...apiAudit })
      apiDecisionRecorded = true
    }
    try {
      const principal = authenticate === verifyAccessToken ? verifyPrincipal(db, token) : null
      userId = principal?.userId ?? authenticate(db, token)
      delegationId = principal?.delegation?.id ?? null
      familyId = principal?.familyId
      readOnly = principal?.delegation?.readOnly ?? false
      checkToolPolicy(db, userId, adapter.name)
      const parsed = runRequestSchema.safeParse(request)
      if (!parsed.success) throw new ArtiumError('INVALID_INPUT')
      args = parsed.data.args
      input = { stdin: parsed.data.stdin, files: parsed.data.files }
      if (/artd_[A-Za-z0-9_-]{43}/.test(JSON.stringify({ args, stdin: input.stdin, names: input.files?.map(file => file.name) }))
        || input.files?.some(file => /artd_[A-Za-z0-9_-]{43}/.test(Buffer.from(file.contentBase64, 'base64').toString('latin1')))) throw new ArtiumError('INVALID_INPUT')
      if (principal?.delegation) {
        const discovery = delegatedDiscovery(db, userId, principal.delegation, [adapter])[0]
        if (!discovery) throw new ArtiumError('DELEGATED_SCOPE_DENIED')
        if (args.length === 0 || args.length === 1 && ['--help', '-h'].includes(args[0])) {
          adapter.validateArgs(args.length ? args : ['--help'], input)
          validateFileInput(adapter.name, args, input)
          const stdout = encode({ tool: adapter.name, commands: discovery.commands }) + '\n'
          return { stdout, stderr: '', exitCode: 0, durationMs: Date.now() - started,
            outputBytes: { stdout: Buffer.byteLength(stdout), stderr: 0 }, timedOut: false, truncated: { stdout: false, stderr: false } }
        }
      }
      adapter.validateArgs(args, input)
      validateFileInput(adapter.name, args, input)
      if (principal?.delegation) {
        const classification = adapter.classify(args, input)
        checkDelegation(principal.delegation.scopeJson, readOnly, adapter.name, classification.command, classification.effect)
        if (credentialIssuingCommand(adapter.name, classification.command)) credentialCommand = classification.command
      }
    } catch (error) {
      recordApiDecision('refused')
      audit.record({ event: 'denial', userId, delegationId, tool: adapter.name, requestId: context.requestId,
        clientAddress: context.clientAddress, outcome: error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR' })
      throw error
    }
    const identity = { userId, delegationId, tool: adapter.name, requestId: context.requestId, clientAddress: context.clientAddress }
    const family = () => familyId ?? verifyAccessFamily(db, token)
    if (credentialCommand) audit.record({ ...identity, event: 'credential-issue', targetId: credentialCommand, outcome: 'attempt' })
    let confirmedCredentialCommand: string | undefined
    const recheck = () => {
      if (authenticate === verifyAccessToken) {
        const current = verifyPrincipal(db, token)
        if (current.delegation) {
          const classification = adapter.classify(args, input)
          checkDelegation(current.delegation.scopeJson, current.delegation.readOnly, adapter.name, classification.command, classification.effect)
          if (confirmedCredentialCommand) checkDelegation(current.delegation.scopeJson, current.delegation.readOnly,
            adapter.name, confirmedCredentialCommand, 'write')
        }
      } else authenticate(db, token)
      checkToolPolicy(db, userId, adapter.name)
    }
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
      const reference = adapter.prepareForCaller ? undefined : await resolver.resolve(userId, adapter.name)
      const prepared = adapter.prepareForCaller ? await adapter.prepareForCaller(args, userId, input)
        : await adapter.prepare(args, reference!, input)
      if (readOnly) prepared.environment = { ...prepared.environment, [`${adapter.name.toUpperCase().replaceAll('-', '_')}_READ_ONLY`]: 'true' }
      const kubernetesRequests = prepared.kubernetesWorkflowRoot && reference ? {
        root: prepared.kubernetesWorkflowRoot,
        scope: createHash('sha256').update(JSON.stringify({ userId, family: family(), reference })).digest('hex'),
      } : undefined
      const nativeScope = (adapter.name === 'unifi-axi' || adapter.name === 'technitium-axi') && reference
        ? createHash('sha256').update(JSON.stringify({ userId, family: family(), reference })).digest('hex') : undefined
      const credentialConfirmation = prepared.invocation?.command === 'confirm' && !prepared.invocation.help && kubernetesRequests
        && await kubernetesCredentialRequest(kubernetesRequests.root, kubernetesRequests.scope, args[1])
      if (delegationId && credentialConfirmation) {
        confirmedCredentialCommand = credentialCommand = 'create token'
        recheck()
        audit.record({ ...identity, event: 'credential-issue', targetId: credentialCommand, outcome: 'attempt' })
      }
      const protectedResult = prepared.protectedResult?.source === 'pipe' && kubernetesRequests
        && !credentialConfirmation
        ? undefined : prepared.protectedResult
      if (credentialCommand && (prepared.preview || prepared.invocation?.help || !protectedResult && prepared.effect === 'read')) {
        audit.record({ ...identity, event: 'credential-issue', targetId: credentialCommand, outcome: 'preview' })
      }
      if (protectedResult) {
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
            recheck()
            if (prepared.beforeSpawn) {
              checkToolPolicy(db, identity.userId, adapter.name)
              prepared.beforeSpawn()
            }
            if ((kubernetesRequests || nativeScope) && reference) {
              recheck()
              checkToolPolicy(db, identity.userId, adapter.name)
              const current = db.prepare('SELECT revision FROM credentials WHERE id = ? AND tool = ?').get(reference.id, adapter.name) as { revision: number } | undefined
              if (current?.revision !== reference.revision) throw new ArtiumError('CREDENTIAL_INVALID')
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
        checkToolPolicy(db, userId, adapter.name)
        const current = await resolver.resolve(userId, adapter.name)
        recheck()
        checkToolPolicy(db, userId, adapter.name)
        if (current.id !== reference.id || current.revision !== reference.revision) throw new ArtiumError('NOT_FOUND')
        const json = result.stdout.trimStart().startsWith('{')
        const projection = (json ? JSON.parse(result.stdout) : decode(result.stdout)) as Record<string, unknown>
        const resultReference = reservation.commit(privateBytes)
        if (credentialCommand && result.exitCode === 0) audit.record({ ...identity, event: 'credential-issue', targetId: credentialCommand, outcome: 'success' })
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
          const command = ['artium-axi', adapter.name, ...write.checkArgs].map(value =>
            /^[a-zA-Z0-9_./:=,+@%-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`).join(' ')
          const failure = Object.assign(new RunnerError(completed && error instanceof ArtiumError ? error.code : 'UNKNOWN_OUTCOME',
            `Unknown outcome for ${write.operation} ${write.target}.`,
            recovery ? `Native audit ID ${recovery.receipt.auditId}; native status ${recovery.receipt.status}. Keep the original input and confirmation. Reconcile this audit ID with the original binding or inspect state with a trusted read; never replay.`
              : `The operation may have changed state and was not retried. Check current state before trying again: ${command}${write.afterCheck ? `. ${write.afterCheck}` : ''}`),
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
    const errorCode = result.exitCode === 0 ? null : toolFailureCode(result.stdout, result.stderr) ?? null
    const outcome = errorCode === 'OUTCOME_UNKNOWN' ? 'UNKNOWN_OUTCOME' : 'completed'
    recordTerminal({ ...identity, event: 'run-terminal', action: await journal?.action(result.exitCode === 0, result.stdout) ?? 'unknown',
      outcome, exitCode: result.exitCode,
      nativeAuditId: result.completedMutation?.receipt.auditId ?? await journal?.auditId?.(), completedMutation: result.completedMutation,
      errorCode,
      durationMs: result.durationMs, outputBytes: result.outputBytes, failure })
    return result
  })
}
