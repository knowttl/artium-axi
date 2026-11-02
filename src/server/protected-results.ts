import { createHash, randomUUID } from 'node:crypto'
import { ArtiumError } from '../shared/errors.js'
import type { CredentialReference } from './store/credential-store.js'

export interface ResultScope { userId: string, credential: CredentialReference, operation: string }

// Confidential bytes stay in bounded process memory and require current access on retrieval.
export class ProtectedResults {
  private readonly entries = new Map<string, { scope: ResultScope, bytes?: Buffer, expires: number }>()

  clear(): void { this.entries.clear() }

  reserve(scope: ResultScope) {
    for (const [id, entry] of this.entries) if (entry.expires <= Date.now()) this.entries.delete(id)
    if (this.entries.size >= 64 || [...this.entries.values()].filter(entry => entry.scope.userId === scope.userId).length >= 4) {
      throw new ArtiumError('TOO_MANY_CALLS')
    }
    const id = randomUUID()
    const entry: { scope: ResultScope, bytes?: Buffer, expires: number } = {
      scope: { ...scope, credential: { ...scope.credential } }, expires: Date.now() + 5 * 60 * 1000,
    }
    this.entries.set(id, entry)
    setTimeout(() => this.entries.delete(id), 5 * 60 * 1000).unref()
    return {
      commit: (bytes: Buffer) => {
        if (bytes.length > 1024 * 1024) throw new ArtiumError('OUTPUT_LIMIT')
        if (this.entries.get(id) !== entry || entry.expires <= Date.now() || entry.bytes) throw new ArtiumError('NOT_FOUND')
        entry.bytes = Buffer.from(bytes)
        return { id, operation: scope.operation, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
          path: `/v1/results/${scope.credential.tool}/${encodeURIComponent(scope.operation)}/${id}` }
      },
      cancel: () => { this.entries.delete(id) },
    }
  }

  take(id: string, scope: ResultScope): Buffer {
    const entry = this.entries.get(id)
    if (!entry?.bytes || entry.expires <= Date.now() || entry.scope.userId !== scope.userId
      || entry.scope.operation !== scope.operation || entry.scope.credential.tool !== scope.credential.tool
      || entry.scope.credential.id !== scope.credential.id || entry.scope.credential.revision !== scope.credential.revision) {
      throw new ArtiumError('NOT_FOUND')
    }
    this.entries.delete(id)
    return entry.bytes
  }
}
