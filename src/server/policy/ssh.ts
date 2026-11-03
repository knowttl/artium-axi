import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { ArtiumError } from '../../shared/errors.js'
import type { SshHosts } from '../store/ssh-hosts.js'
import { checkToolPolicy } from './policy.js'

export interface SshOwner { user: string, family: string }
export function sshBinding(db: Database.Database, hosts: SshHosts, owner: SshOwner, host: string, sudo = false) {
  checkToolPolicy(db, owner.user, 'ssh-axi')
  if (!db.prepare('SELECT 1 FROM session_families WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>?')
    .get(owner.family, owner.user, Date.now())) throw new ArtiumError('TOKEN_INVALID')
  const tool = db.prepare("SELECT revision, native_settings FROM tools WHERE name='ssh-axi'").get() as { revision: number, native_settings: string }
  const selected = hosts.executionBinding(owner.user, host, sudo)
  return { selected, tool, hash: createHash('sha256').update(JSON.stringify({ selected, tool })).digest('hex') }
}
