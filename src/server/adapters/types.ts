import type { z } from 'zod'
import type { CredentialReference, ToolName } from '../store/credential-store.js'

// Leaf names are resolved under the runner's private call directory, with mode 0600.
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
  validateArgs(args: readonly string[]): void
  prepare(args: readonly string[], reference: CredentialReference): Promise<PreparedCall>
}
