import type { z } from 'zod'
import type { CredentialReference, ToolName } from '../store/credential-store.js'
import type { SensitiveArguments } from '../audit/redact.js'
import type { RunnerInput } from '../runner/input.js'
import type { CredentialProfile } from './credential-profile.js'
import type { TransferScope } from '../../shared/api.js'
import type { PrivateOutput, PublicContent } from '../runner/scan.js'
import type { Serializable } from 'node:child_process'

// The runner materializes adapter-owned relative paths privately, including XDG profiles.
export interface TemporaryFile {
  name: string
  content: string | Uint8Array
  appendTrustedCa?: boolean
  appendTrustedCaAt?: readonly string[]
}

export interface PreparedCall {
  proxmox?: { origin: string, identity: string, password: boolean, authenticate: boolean,
    stream?: { duplex: boolean, spice: boolean, upload: boolean, preview: boolean, operation: string } }
  // Native-generated protocol metadata stays intact; every selected provider value is still scanned.
  publicContent?: PublicContent
  mutationReceipt?: import('../runner/runner.js').RunnerLimits['mutationReceipt']
  // Dedicated identities can change while the call queues or its private files are materialized.
  beforeSpawn?: () => void
  kubernetesWorkflowRoot?: string
  executable: string
  args: string[]
  invocation?: { command: string, help: boolean, credentialAuth?: 'device', nativeGh?: boolean, checkArgs?: string[] }
  environment: Record<string, string>
  pathPrefix?: string
  trustedIpc?: Serializable
  files: TemporaryFile[]
  secrets: string[]
  fileArguments?: readonly number[]
  effect?: 'read' | 'write'
  protectedResult?: { operation: string } & ({ source: 'projection' } | { source: 'file', name: string, flag: string }
    | { source: 'pipe', flag: string, argumentIndex: number } | { source: 'proxmox' })
  write?: { operation: string, target: string, checkArgs: string[], afterCheck?: string }
  preview?: { operation: string, target: string, confirm: string }
  limits: { timeoutMs: number, directoryScope?: string, terminationGraceMs?: number, runtime?: 'python', nodeHeapMiB?: number, systemCaBundle?: boolean | { endpoint: string }, privateOutput?: PrivateOutput }
}

export interface Adapter<Credential> {
  name: ToolName
  executable: string
  credentialSchema: z.ZodType<Credential>
  credentialProfile?: CredentialProfile
  timeoutMs: number
  blockedFlags: readonly string[]
  allowedFlagValues: Readonly<Record<string, readonly string[]>>
  sensitiveArguments(args: readonly string[]): SensitiveArguments
  sensitiveInput?(args: readonly string[], input?: RunnerInput): boolean
  classify(args: readonly string[], input?: RunnerInput): { command: string, effect: 'read' | 'write' }
  nestedOperations?(args: readonly string[], input?: RunnerInput): { command: string, effect: 'read' | 'write' }[]
  authorizeOperation?(command: string, settings: Record<string, unknown>): void
  validateArgs(args: readonly string[], input?: RunnerInput): void
  prepare(args: readonly string[], reference: CredentialReference, input?: RunnerInput): Promise<PreparedCall>
  prepareForCaller?(args: readonly string[], userId: string, input?: RunnerInput): Promise<PreparedCall>
  prepareArtifact?(args: string[], reference: CredentialReference, scope: TransferScope): Promise<PreparedCall>
  invalidateCredential?(reference: CredentialReference): void
}
