import { createHash, randomUUID } from 'node:crypto'
import { ArtiumError } from '../shared/errors.js'
import type { CredentialReference } from './store/credential-store.js'
import { protectedResultLimits } from './config.js'

export interface ResultScope { userId: string, credential: CredentialReference, operation: string, familyId?: string, familyOnly?: boolean, delegated?: boolean, trustRevision?: string }
type ResultOwner = Pick<ResultScope, 'userId' | 'operation' | 'familyId' | 'familyOnly'> & { tool: CredentialReference['tool'] }

// Confidential bytes stay in bounded process memory and require current access on retrieval.
export class ProtectedResults {
  private readonly entries = new Map<string, { scope: ResultScope, bytes?: Buffer, expires: number, timer: NodeJS.Timeout }>()

  private remove(id: string): void {
    const entry = this.entries.get(id)
    if (entry) {
      clearTimeout(entry.timer)
      entry.bytes = undefined
      this.entries.delete(id)
    }
  }

  clear(): void { for (const id of this.entries.keys()) this.remove(id) }

  invalidate(refused: (scope: ResultScope) => boolean): void {
    for (const [id, entry] of this.entries) if (refused(entry.scope)) this.remove(id)
  }

  reserve(scope: ResultScope) {
    for (const [id, entry] of this.entries) if (entry.expires <= Date.now()) this.remove(id)
    if (this.entries.size >= protectedResultLimits.total || [...this.entries.values()].filter(entry => entry.scope.userId === scope.userId).length >= protectedResultLimits.perUser) {
      throw new ArtiumError('TOO_MANY_CALLS')
    }
    if (scope.delegated && [...this.entries.values()].filter(entry => entry.scope.userId === scope.userId && entry.scope.delegated).length >= 2) throw new ArtiumError('TOO_MANY_CALLS')
    const id = randomUUID()
    const entry: { scope: ResultScope, bytes?: Buffer, expires: number, timer: NodeJS.Timeout } = {
      scope: { ...scope, credential: { ...scope.credential } }, expires: Date.now() + protectedResultLimits.lifetimeMs,
      timer: setTimeout(() => this.remove(id), protectedResultLimits.lifetimeMs).unref(),
    }
    this.entries.set(id, entry)
    return {
      commit: (bytes: Buffer) => {
        if (bytes.length > protectedResultLimits.bytes) throw new ArtiumError('OUTPUT_LIMIT')
        if (this.entries.get(id) !== entry || entry.expires <= Date.now() || entry.bytes) throw new ArtiumError('NOT_FOUND')
        entry.bytes = Buffer.from(bytes)
        return { id, operation: scope.operation, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
          path: `/v1/results/${scope.credential.tool}/${encodeURIComponent(scope.operation)}/${id}` }
      },
      cancel: () => { this.remove(id) },
    }
  }

  private owned(id: string, owner: ResultOwner) {
    const entry = this.entries.get(id)
    if (entry && entry.expires <= Date.now()) this.remove(id)
    if (!entry?.bytes || entry.expires <= Date.now() || entry.scope.userId !== owner.userId
      || owner.familyOnly && entry.scope.familyId !== owner.familyId
      || entry.scope.familyId !== undefined && entry.scope.familyId !== owner.familyId
      || entry.scope.operation !== owner.operation || entry.scope.credential.tool !== owner.tool) throw new ArtiumError('NOT_FOUND')
    return entry
  }

  credential(id: string, owner: ResultOwner): CredentialReference {
    return { ...this.owned(id, owner).scope.credential }
  }

  take(id: string, scope: ResultScope, beforeTake?: () => void): Buffer {
    const entry = this.owned(id, { ...scope, tool: scope.credential.tool })
    if (entry.scope.trustRevision !== undefined && entry.scope.trustRevision !== scope.trustRevision
      || entry.scope.credential.id !== scope.credential.id || entry.scope.credential.revision !== scope.credential.revision) {
      throw new ArtiumError('NOT_FOUND')
    }
    const bytes = entry.bytes!
    beforeTake?.()
    this.remove(id)
    return bytes
  }
}
