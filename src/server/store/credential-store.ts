import type { z } from 'zod'
import type { toolSchema } from '../../shared/api.js'

export type ToolName = z.infer<typeof toolSchema>

export interface CredentialReference {
  id: string
  tool: ToolName
}

export interface CredentialStore {
  findCredential(tool: ToolName): CredentialReference | undefined
  readCredential(reference: CredentialReference): unknown
}
