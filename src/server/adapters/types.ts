import type { z } from 'zod'
import type { CredentialReference, ToolName } from '../store/credential-store.js'
import type { SensitiveArguments } from '../audit/redact.js'

// The owning server flow must materialize these leaf names in the private call directory with mode 0600.
// RunnerInput currently supports uploads only; adapter-file materialization is not wired yet.
export interface TemporaryFile {
  name: string
  content: string | Uint8Array
}

export interface PreparedCall {
  executable: string
  args: string[]
  environment: Record<string, string>
  files: TemporaryFile[]
  secrets: string[]
  limits: { timeoutMs: number, runtime?: 'python' }
}

export interface Adapter<Credential> {
  name: ToolName
  executable: string
  credentialSchema: z.ZodType<Credential>
  timeoutMs: number
  blockedFlags: readonly string[]
  allowedFlagValues: Readonly<Record<string, readonly string[]>>
  sensitiveArguments(args: readonly string[]): SensitiveArguments
  validateArgs(args: readonly string[]): void
  prepare(args: readonly string[], reference: CredentialReference): Promise<PreparedCall>
}
