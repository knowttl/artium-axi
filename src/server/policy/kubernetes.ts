import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { FastifyRequest } from 'fastify'
import type { z } from 'zod'
import { nativeSettingsSchemas } from '../../shared/api.js'
import { kubernetesSessionKind } from '../../shared/kubernetes.js'
import { ArtiumError } from '../../shared/errors.js'
import { delegationPaused, verifyPrincipal } from '../auth/tokens.js'
import { checkDelegation } from '../auth/delegations.js'
import type { Adapter } from '../adapters/types.js'
import { kubernetesHostedRoutes } from '../../shared/kubernetes.js'
import { checkToolPolicy } from './policy.js'
import { readCredentialTrust } from '../store/trusted-certificates.js'

export interface KubernetesOwner { user: string, family: string, delegation?: { id: string, scopeJson: string, readOnly: boolean, expiresAt: number } }
export function kubernetesOwner(db: Database.Database, request: Pick<FastifyRequest, 'headers'>): KubernetesOwner {
  const token = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
  const { userId: user, familyId: family, delegation } = verifyPrincipal(db, token)
  checkToolPolicy(db, user, 'kubernetes-axi')
  return { user, family, ...(delegation ? { delegation } : {}) }
}
export function authorizeKubernetesOwner(db: Database.Database, owner: { user: string, delegation?: { scopeJson: string, readOnly: boolean } }, adapter: Adapter<unknown>, command: string) {
  checkToolPolicy(db, owner.user, 'kubernetes-axi')
  const route = kubernetesHostedRoutes.find(route => route.command === command)
  if (!route) throw new ArtiumError('DELEGATED_SCOPE_DENIED')
  if (owner.delegation) checkDelegation(owner.delegation.scopeJson, owner.delegation.readOnly, adapter, command, route.effect === 'read' ? 'read' : 'write')
  if (command.startsWith('session start ')) {
    const operation = kubernetesSessionKind.parse(command.slice('session start '.length))
    const row = db.prepare("SELECT native_settings FROM tools WHERE name='kubernetes-axi'").get() as { native_settings: string }
    authorizeSessionKind(nativeSettingsSchemas['kubernetes-axi'].parse(JSON.parse(row.native_settings)), owner.user, operation)
  }
}
function authorizeSessionKind(settings: z.infer<typeof nativeSettingsSchemas['kubernetes-axi']>, user: string, operation: z.infer<typeof kubernetesSessionKind>) {
  if (!settings.sessions?.grants[user]?.includes(operation)) throw new ArtiumError('TOOL_NOT_GRANTED')
  if (!['watch', 'logs'].includes(operation) && settings.allowWrites !== true) throw new ArtiumError('FLAG_BLOCKED')
}
export function kubernetesBinding(db: Database.Database, owner: KubernetesOwner, operation?: z.infer<typeof kubernetesSessionKind>) {
  checkToolPolicy(db, owner.user, 'kubernetes-axi')
  if (!db.prepare('SELECT 1 FROM session_families WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>?')
    .get(owner.family, owner.user, Date.now())) throw new ArtiumError('TOKEN_INVALID')
  if (owner.delegation && (owner.delegation.expiresAt <= Date.now() || delegationPaused(db, owner.user) ||
    !db.prepare('SELECT 1 FROM delegations WHERE id=? AND creator_id=? AND revoked_at IS NULL AND expires_at>?')
      .get(owner.delegation.id, owner.user, Date.now()))) throw new ArtiumError('TOKEN_INVALID')
  const tool = db.prepare("SELECT revision,native_settings FROM tools WHERE name='kubernetes-axi'").get() as { revision: number, native_settings: string }
  const settings = nativeSettingsSchemas['kubernetes-axi'].parse(JSON.parse(tool.native_settings))
  if (operation) authorizeSessionKind(settings, owner.user, operation)
  const credential = db.prepare("SELECT id,revision FROM credentials WHERE tool='kubernetes-axi'").get() as { id: string, revision: number } | undefined
  if (!credential) throw new ArtiumError('CREDENTIAL_NOT_CONFIGURED')
  const writing = operation !== undefined && !['watch', 'logs'].includes(operation)
  const reference = { ...credential, tool: 'kubernetes-axi' as const }
  return { settings, credential: { ...credential, tool: 'kubernetes-axi' as const },
    hash: createHash('sha256').update(JSON.stringify({ credential, trust: readCredentialTrust(db, reference), policy: operation ? {
      granted: settings.sessions?.grants[owner.user]?.includes(operation), allowWrites: writing ? settings.allowWrites : undefined,
      collectionDelete: writing ? settings.collectionDelete : undefined,
      lifetimeSeconds: settings.sessions?.lifetimeSeconds, outputBytes: settings.sessions?.outputBytes,
    } : undefined })).digest('hex') }
}
