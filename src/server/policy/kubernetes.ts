import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { FastifyRequest } from 'fastify'
import type { z } from 'zod'
import { nativeSettingsSchemas } from '../../shared/api.js'
import type { kubernetesSessionKind } from '../../shared/kubernetes.js'
import { ArtiumError } from '../../shared/errors.js'
import { hashToken, verifyAccessToken } from '../auth/tokens.js'
import { checkToolPolicy } from './policy.js'
import { readCredentialTrust } from '../store/trusted-certificates.js'

export interface KubernetesOwner { user: string, family: string }
export function kubernetesOwner(db: Database.Database, request: Pick<FastifyRequest, 'headers'>): KubernetesOwner {
  const token = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
  const user = verifyAccessToken(db, token)
  checkToolPolicy(db, user, 'kubernetes-axi')
  const { family_id: family } = db.prepare('SELECT family_id FROM tokens WHERE hash=?').get(hashToken(token)) as { family_id: string }
  return { user, family }
}
export function kubernetesBinding(db: Database.Database, owner: KubernetesOwner, operation?: z.infer<typeof kubernetesSessionKind>) {
  checkToolPolicy(db, owner.user, 'kubernetes-axi')
  if (!db.prepare('SELECT 1 FROM session_families WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>?')
    .get(owner.family, owner.user, Date.now())) throw new ArtiumError('TOKEN_INVALID')
  const tool = db.prepare("SELECT revision,native_settings FROM tools WHERE name='kubernetes-axi'").get() as { revision: number, native_settings: string }
  const settings = nativeSettingsSchemas['kubernetes-axi'].parse(JSON.parse(tool.native_settings))
  if (operation && !settings.sessions?.grants[owner.user]?.includes(operation)) throw new ArtiumError('TOOL_NOT_GRANTED')
  if (operation && !['watch', 'logs'].includes(operation) && settings.allowWrites !== true) throw new ArtiumError('FLAG_BLOCKED')
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
