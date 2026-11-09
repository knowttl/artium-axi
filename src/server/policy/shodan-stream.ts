import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { FastifyRequest } from 'fastify'
import { nativeSettingsSchemas } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { verifyAccessFamily, verifyAccessToken } from '../auth/tokens.js'
import type { CredentialReference } from '../store/credential-store.js'
import { readCredentialTrust } from '../store/trusted-certificates.js'
import { checkToolPolicy } from './policy.js'

export interface ShodanOwner { user: string, family: string }

export function shodanOwner(db: Database.Database, request: Pick<FastifyRequest, 'headers'>): ShodanOwner {
  const token = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
  const user = verifyAccessToken(db, token)
  checkToolPolicy(db, user, 'shodan-axi')
  return { user, family: verifyAccessFamily(db, token) }
}

function binding(db: Database.Database, owner: ShodanOwner, credential: CredentialReference) {
  checkToolPolicy(db, owner.user, 'shodan-axi', credential.id)
  if (!db.prepare('SELECT 1 FROM session_families WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>?')
    .get(owner.family, owner.user, Date.now())) throw new ArtiumError('TOKEN_INVALID')
  const tool = db.prepare("SELECT enabled,pinned_version,native_settings FROM tools WHERE name='shodan-axi'").get() as
    { enabled: number, pinned_version: string, native_settings: string }
  const settings = nativeSettingsSchemas['shodan-axi'].parse(JSON.parse(tool.native_settings))
  const current = db.prepare("SELECT id,revision,name,read_only FROM credentials WHERE tool='shodan-axi' AND id=?").get(credential.id) as
    { id: string, revision: number, name: string, read_only: number } | undefined
  if (credential.tool !== 'shodan-axi' || !current || current.revision !== credential.revision) throw new ArtiumError('REVISION_CONFLICT')
  return { settings, instance: current.name, readOnly: current.read_only === 1, hash: createHash('sha256').update(JSON.stringify({ credential: { id: current.id, revision: current.revision },
    enabled: tool.enabled, pinnedVersion: tool.pinned_version, trust: readCredentialTrust(db, credential), settings })).digest('hex') }
}

export function shodanBinding(db: Database.Database, owner: ShodanOwner, credential: CredentialReference, operation: string) {
  const result = binding(db, owner, credential), settings = result.settings.sessions
  if (!settings?.grants[owner.user]?.includes(operation)) throw new ArtiumError('TOOL_NOT_GRANTED')
  return { settings, instance: result.instance, hash: result.hash }
}

export function shodanScanBinding(db: Database.Database, owner: ShodanOwner, credential: CredentialReference,
  operations: readonly string[], streamOperation?: string) {
  const result = binding(db, owner, credential), settings = result.settings.scans
  if (result.readOnly) throw new ArtiumError('FLAG_BLOCKED')
  if (!settings || operations.some(operation => !settings.grants[owner.user]?.includes(operation))
    || streamOperation && !result.settings.sessions?.grants[owner.user]?.includes(streamOperation)) throw new ArtiumError('TOOL_NOT_GRANTED')
  return { settings, instance: result.instance, hash: result.hash }
}

