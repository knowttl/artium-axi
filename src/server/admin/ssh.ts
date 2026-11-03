import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import { sshBindingInput, sshCredentialInput, sshDeleteInput, sshGrantInput, sshHostInput, type SshAdminHost } from '../../shared/ssh-admin.js'
import { ArtiumError } from '../../shared/errors.js'
import type { Audit } from '../audit/audit.js'
import { nextSshRevision, type SshHosts } from '../store/ssh-hosts.js'
import { registerSshPages } from './ssh-pages.js'

export function registerSshAdmin(app: FastifyInstance, db: Database.Database, audit: Audit,
  authorize: (request: FastifyRequest) => string, credentials?: SshHosts): void {
  function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value)
    if (!result.success) throw new ArtiumError('INVALID_INPUT')
    return result.data
  }
  const expected = (table: 'ssh_hosts' | 'ssh_credentials', id: string, revision: number, create = false) => nextSshRevision(db, table, id, revision, create)
  function change(request: FastifyRequest, action: string, targetId: string, mutation: (actor: string) => unknown) {
    const actor = authorize(request)
    return audit.change({ event: 'admin-change', action, targetId, userId: actor, tool: 'ssh-axi',
      outcome: 'success', requestId: request.id, clientAddress: request.ip }, () => {
      authorize(request)
      return mutation(actor)
    }).value
  }
  const readHosts = () => {
    const rows = db.prepare(`SELECT id, address, port, approved_host_keys AS approvedHostKeys, allowed_addresses AS allowedAddresses,
      enabled, read_only AS readOnly, command_seconds AS commandSeconds, output_bytes AS outputBytes,
      idle_minutes AS idleMinutes, trust_verification AS independentVerification, revision FROM ssh_hosts ORDER BY id`).all() as
      (Omit<SshAdminHost, 'enabled' | 'readOnly' | 'approvedHostKeys' | 'allowedAddresses'> &
        { enabled: number, readOnly: number, approvedHostKeys: string, allowedAddresses: string })[]
    return { hosts: rows.map(row => ({ ...row, enabled: Boolean(row.enabled), readOnly: Boolean(row.readOnly),
      approvedHostKeys: JSON.parse(row.approvedHostKeys) as string[], allowedAddresses: JSON.parse(row.allowedAddresses) as string[] })),
      bindings: db.prepare('SELECT host_id AS host, username, credential_id AS credential, revision, sudo FROM ssh_bindings ORDER BY host_id, sudo').all(),
      grants: db.prepare('SELECT user_id AS user, host_id AS host, shell, sudo FROM ssh_grants ORDER BY host_id, user_id').all() }
  }
  const readCredentials = () => ({ credentials: db.prepare('SELECT id, revision, updated_at AS updatedAt, updated_by AS updatedBy FROM ssh_credentials ORDER BY id').all() })
  app.get('/v1/admin/ssh/hosts', async request => { authorize(request); return readHosts() })
  app.get('/v1/admin/ssh/credentials', async request => { authorize(request); return readCredentials() })
  app.post('/v1/admin/ssh/hosts', async request => {
    authorize(request)
    const input = parse(sshHostInput, request.body)
    return change(request, 'ssh-host-save', input.id, () => {
      const revision = expected('ssh_hosts', input.id, input.expectedRevision, true)
      db.prepare(`INSERT INTO ssh_hosts (id, address, port, approved_host_keys, allowed_addresses, enabled, revision,
        read_only, command_seconds, output_bytes, idle_minutes, trust_verification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET address=excluded.address, port=excluded.port, approved_host_keys=excluded.approved_host_keys,
        allowed_addresses=excluded.allowed_addresses, enabled=excluded.enabled, revision=excluded.revision, read_only=excluded.read_only,
        command_seconds=excluded.command_seconds, output_bytes=excluded.output_bytes, idle_minutes=excluded.idle_minutes,
        trust_verification=excluded.trust_verification`)
        .run(input.id, input.address, input.port, JSON.stringify(input.approvedHostKeys), JSON.stringify(input.allowedAddresses),
          Number(input.enabled), revision, Number(input.readOnly), input.commandSeconds, input.outputBytes, input.idleMinutes, input.independentVerification)
      return { id: input.id, revision }
    })
  })
  app.post('/v1/admin/ssh/binding', async request => {
    authorize(request)
    const input = parse(sshBindingInput, request.body)
    return change(request, 'ssh-binding-save', input.host, () => {
      expected('ssh_hosts', input.host, input.expectedRevision)
      if (!db.prepare('SELECT 1 FROM ssh_credentials WHERE id = ?').get(input.credential)) throw new ArtiumError('NOT_FOUND')
      const other = db.prepare('SELECT username, credential_id FROM ssh_bindings WHERE host_id = ? AND sudo != ?')
        .get(input.host, Number(input.sudo)) as { username: string, credential_id: string } | undefined
      if (other && (other.username === input.username || other.credential_id === input.credential)) throw new ArtiumError('INVALID_INPUT', 'Ordinary and sudo bindings require distinct accounts and credentials.')
      db.prepare(`INSERT INTO ssh_bindings (host_id, sudo, username, credential_id) VALUES (?, ?, ?, ?)
        ON CONFLICT(host_id, sudo) DO UPDATE SET username=excluded.username, credential_id=excluded.credential_id, revision=ssh_bindings.revision+1`)
        .run(input.host, Number(input.sudo), input.username, input.credential)
      db.prepare('UPDATE ssh_hosts SET revision=revision+1 WHERE id=?').run(input.host)
      return { id: input.host, revision: input.expectedRevision + 1 }
    })
  })
  app.post('/v1/admin/ssh/grant', async request => {
    authorize(request)
    const input = parse(sshGrantInput, request.body)
    return change(request, 'ssh-grant-save', input.host, () => {
      expected('ssh_hosts', input.host, input.expectedRevision)
      if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(input.user)) throw new ArtiumError('NOT_FOUND')
      db.prepare(`INSERT INTO ssh_grants (user_id, host_id, shell, sudo) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, host_id) DO UPDATE SET shell=excluded.shell, sudo=excluded.sudo`)
        .run(input.user, input.host, Number(input.shell), Number(input.sudo))
      db.prepare('UPDATE ssh_hosts SET revision=revision+1 WHERE id=?').run(input.host)
      return { id: input.host, revision: input.expectedRevision + 1 }
    })
  })
  app.post('/v1/admin/ssh/credential', async request => {
    authorize(request)
    const { id, expectedRevision, privateKey, passphrase } = parse(sshCredentialInput, request.body)
    return change(request, 'ssh-credential-save', id, actor => {
      if (!credentials) throw new ArtiumError('CREDENTIAL_NOT_CONFIGURED')
      const revision = credentials.replaceCredential(id, { privateKey, ...(passphrase === undefined ? {} : { passphrase }) }, expectedRevision, actor)
      return { id, revision }
    })
  })
  for (const kind of ['host', 'credential'] as const) app.post(`/v1/admin/ssh/${kind}-delete`, async request => {
    authorize(request)
    const input = parse(sshDeleteInput, request.body)
    return change(request, `ssh-${kind}-delete`, input.id, () => {
      expected(kind === 'host' ? 'ssh_hosts' : 'ssh_credentials', input.id, input.expectedRevision)
      if (kind === 'host') {
        db.prepare('DELETE FROM ssh_grants WHERE host_id=?').run(input.id)
        db.prepare('DELETE FROM ssh_bindings WHERE host_id=?').run(input.id)
        db.prepare('DELETE FROM ssh_hosts WHERE id=?').run(input.id)
      } else {
        db.prepare('UPDATE ssh_hosts SET revision=revision+1 WHERE id IN (SELECT host_id FROM ssh_bindings WHERE credential_id=?)').run(input.id)
        db.prepare('DELETE FROM ssh_bindings WHERE credential_id=?').run(input.id)
        db.prepare('DELETE FROM ssh_credentials WHERE id=?').run(input.id)
      }
      return { deleted: true }
    })
  })
  registerSshPages(app, db, authorize, readHosts, readCredentials)
}
