import type { z } from 'zod'
import type { CredentialReference, ToolName } from '../store/credential-store.js'
import type { SensitiveArguments } from '../audit/redact.js'
import type { RunnerInput } from '../runner/input.js'
import type { CredentialProfile } from './credential-profile.js'
import type { TransferScope } from '../../shared/api.js'
import type { PrivateOutput } from '../runner/scan.js'
import type { Serializable } from 'node:child_process'

// The runner materializes adapter-owned relative paths privately, including XDG profiles.
export interface TemporaryFile {
  name: string
  content: string | Uint8Array
  appendTrustedCa?: boolean
  appendTrustedCaAt?: readonly string[]
}

export interface PreparedCall {
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
  protectedResult?: { operation: string } & ({ source: 'projection' } | { source: 'file', name: string, flag: string })
  write?: { operation: string, target: string, checkArgs: string[], afterCheck?: string }
  preview?: { operation: string, target: string, confirm: string }
  limits: { timeoutMs: number, terminationGraceMs?: number, runtime?: 'python', nodeHeapMiB?: number, systemCaBundle?: boolean | { endpoint: string }, privateOutput?: PrivateOutput }
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
  validateArgs(args: readonly string[], input?: RunnerInput): void
  prepare(args: readonly string[], reference: CredentialReference, input?: RunnerInput): Promise<PreparedCall>
  prepareForCaller?(args: readonly string[], userId: string, input?: RunnerInput): Promise<PreparedCall>
  prepareArtifact?(args: string[], reference: CredentialReference, scope: TransferScope): Promise<PreparedCall>
  invalidateCredential?(reference: CredentialReference): void
}
