import type { z } from 'zod'
import type { toolSchema } from '../../shared/api.js'
import type { CredentialTrust } from './trusted-certificates.js'

export type ToolName = z.infer<typeof toolSchema>

export interface CredentialReference {
  id: string
  tool: ToolName
  revision?: number
}

export interface CredentialStore {
  findCredential(tool: ToolName): CredentialReference | undefined
  readCredential(reference: CredentialReference): unknown
  readToolSettings?(tool: ToolName): Record<string, unknown>
  readCredentialTrust?(reference: CredentialReference): readonly CredentialTrust[]
}

export interface MutableCredentialStore extends CredentialStore {
  replaceCredential(tool: ToolName, value: unknown, expectedRevision: number, actor: string, now: number): CredentialReference
}
