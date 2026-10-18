import type { z } from 'zod'
import type { CredentialReference, ToolName } from '../store/credential-store.js'
import type { SensitiveArguments } from '../audit/redact.js'
import type { RunnerInput } from '../runner/input.js'
import type { CredentialProfile } from './credential-profile.js'

// The runner materializes adapter-owned relative paths privately, including XDG profiles.
export interface TemporaryFile {
  name: string
  content: string | Uint8Array
  appendTrustedCa?: boolean
}

export interface PreparedCall {
  executable: string
  args: string[]
  environment: Record<string, string>
  files: TemporaryFile[]
  secrets: string[]
  fileArguments?: readonly number[]
  effect?: 'read' | 'write'
  write?: { operation: string, target: string, checkArgs: string[], afterCheck?: string }
  limits: { timeoutMs: number, runtime?: 'python', nodeHeapMiB?: number }
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
  validateArgs(args: readonly string[], input?: RunnerInput): void
  prepare(args: readonly string[], reference: CredentialReference, input?: RunnerInput): Promise<PreparedCall>
  invalidateCredential?(reference: CredentialReference): void
}
