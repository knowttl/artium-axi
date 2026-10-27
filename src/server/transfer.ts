import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { z } from 'zod'
import { transferLimits, transferPrepareSchema, transferScopeSchema, transferTool } from '../shared/api.js'
import type { TransferScope } from '../shared/api.js'
import { ArtiumError } from '../shared/errors.js'
import { hybridWritePolicy } from './adapters/hybrid.js'
import { checkpointWritePolicy } from './adapters/checkpoint.js'
import { authDefaults } from './config.js'
import { checkToolPolicy } from './policy/policy.js'

export interface TransferOwner {
  userId: string
  sessionFamilyId: string
  reauthenticatedAt: number | null
}

// Hash the exact destination spelling; never normalize it into a different target
// or retain the absolute client destination in server metadata.
export function transferTargetDigest(destination: string): string {
  return createHash('sha256').update(destination, 'utf8').digest('hex')
}

export function createTransferScope(owner: TransferOwner, credentialRevision: number,
  request: z.infer<typeof transferPrepareSchema>, now = Date.now()): TransferScope {
  const input = transferPrepareSchema.parse(request)
  const scope = transferScopeSchema.parse({ transferId: randomUUID(), userId: owner.userId,
    sessionFamilyId: owner.sessionFamilyId, credentialRevision, ...input,
    preparedAt: now, expiresAt: now + transferLimits.lifetimeMs })
  return Object.freeze({ ...scope, selection: Object.freeze(scope.selection) })
}

// These are metadata checks for the later dedicated bounded temporary store.
// Admission must serialize this check with reservation creation.
// The store must count every reservation, including partial files, until cleanup
// succeeds. Expiry alone must not free capacity or permit a disk fallback.
export function checkTransferCapacity(userId: string, reservations: readonly TransferScope[]): void {
  if (reservations.filter(scope => scope.userId === userId).length >= transferLimits.reservationsPerUser
    || reservations.length >= transferLimits.reservations
    || (reservations.length + 1) * transferLimits.artifactBytes > transferLimits.reservedBytes) {
    throw new ArtiumError('TOO_MANY_CALLS')
  }
}

export function checkTransferScope(scope: TransferScope, owner: TransferOwner, credentialRevision: number,
  request: z.infer<typeof transferPrepareSchema>, now = Date.now()): void {
  if (scope.expiresAt <= now) throw new ArtiumError('TOKEN_EXPIRED')
  if (scope.userId !== owner.userId || scope.sessionFamilyId !== owner.sessionFamilyId) throw new ArtiumError('TOKEN_INVALID')
  if (scope.credentialRevision !== credentialRevision) throw new ArtiumError('REVISION_CONFLICT')
  const input = transferPrepareSchema.parse(request)
  if (scope.targetDigest !== input.targetDigest || scope.selection.operation !== input.selection.operation
    || scope.selection.selector !== input.selection.selector || scope.selection.type !== input.selection.type) {
    throw new ArtiumError('INVALID_INPUT')
  }
}

// Call only with an authenticated owner, on preparation and again immediately
// before native execution/retrieval. This never grants upstream entitlement.
export function checkTransferAccess(db: Database.Database, owner: TransferOwner,
  operation: TransferScope['selection']['operation'], now = Date.now()): void {
  const family = db.prepare(`SELECT 1 FROM session_families WHERE id = ? AND user_id = ?
    AND revoked_at IS NULL AND expires_at > ?`).get(owner.sessionFamilyId, owner.userId, now)
  if (!family) throw new ArtiumError('TOKEN_INVALID')
  if (owner.reauthenticatedAt === null || owner.reauthenticatedAt > now
    || owner.reauthenticatedAt + authDefaults.recentAuthMs <= now) throw new ArtiumError('REAUTH_REQUIRED')
  const name = transferTool(operation)
  checkToolPolicy(db, owner.userId, name)
  const tool = db.prepare('SELECT native_settings FROM tools WHERE name = ?').get(name) as { native_settings: string }
  const state = (name === 'checkpoint-axi' ? checkpointWritePolicy : hybridWritePolicy).read(JSON.parse(tool.native_settings))
  // A global write switch never enables an unselected download operation.
  if (!state.enabled || !state.supportedOperations?.includes(operation) || !state.allowedOperations.includes(operation)) {
    throw new ArtiumError('FLAG_BLOCKED')
  }
}
