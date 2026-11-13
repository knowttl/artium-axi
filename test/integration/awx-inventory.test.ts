import { configurationTests } from './awx-configuration-cases.js'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { decode } from '@toon-format/toon'
import { createApp } from '../../src/server/app.js'
import { createAwxAdapter } from '../../src/server/adapters/awx.js'
import { Audit } from '../../src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { withFakeService } from '../fake-service/fixture.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'
import { FakeCredentialStore } from '../fixtures/credential-store.js'
import type { RunInput } from '../../src/shared/api.js'

const upload = (name: string, content: string) => ({ name, size: Buffer.byteLength(content), contentBase64: Buffer.from(content).toString('base64') })

test.each([
  { format: 'json', initial: '{"mode":"initial","ansible_password":"CANARY-create"}', updated: '{"mode":"updated","ansible_password":"CANARY-edit"}' },
  { format: 'yml', initial: 'mode: initial\nansible_password: CANARY-create\n', updated: 'mode: updated\nansible_password: CANARY-edit\n' },
])('AWX host and group $format changes persist through inventory and membership reads with writes disabled', async ({ format, initial, updated }) => {
  await withFakeService(async ({ directory, port }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    await seedToolUser(db)
    db.exec("UPDATE tools SET enabled = 1 WHERE name = 'awx-axi'")
    let allowWrites = true
    const reference = { id: 'synthetic-credential', tool: 'awx-axi' as const }
    const adapter = createAwxAdapter({ getCredential: async () => ({ origin: `https://localhost:${port}`,
      token: 'CANARY-awx-token', allowWrites, allowDeletes: true }) })
    const prepare = adapter.prepare.bind(adapter)
    adapter.prepare = async (...input) => {
      const call = await prepare(...input)
      if (call.executable === process.execPath) call.args[3] = join(process.cwd(), 'tools/node_modules/.bin/awx-axi')
      else return { ...call, executable: process.execPath, args: [join(process.cwd(), 'tools/node_modules/@knowttl/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
      return call
    }
    const runner = await Runner.create(join(directory, 'calls'), { pem: readFileSync(join(directory, 'ca.crt'), 'utf8'), certificates: [] })
    const app = createApp({ db, runner, audit: new Audit(db, Date.now, () => {}), adapters: [adapter], environment: {},
      resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]).seed(db), db) })
    const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
    const run = async (args: string[], input: RunInput = {}) => {
      const response = await app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args, ...input } })
      expect(response.json(), response.body).toMatchObject({ exitCode: 0 })
      expect(response.body).not.toContain('CANARY-')
      return decode(response.json().stdout)
    }
    try {
      await run(['inventory', 'host-create', 'synthetic-host', '--inventory', '7', '--enabled', '--variables', initial, '--confirm'])
      await run(['inventory', 'host-create', 'synthetic-sibling', '--inventory', '7', '--confirm'])
      await run(['inventory', 'group-create', 'synthetic-parent', '--inventory', '7', '--variables', initial, '--confirm'])
      await run(['inventory', 'group-create', 'synthetic-child', '--inventory', '7', '--confirm'])
      await run(['inventory', 'group-create', 'synthetic-other-child', '--inventory', '7', '--confirm'])
      allowWrites = false
      expect(await run(['host', 'show', 'synthetic-host'])).toMatchObject({ host: {
        id: 42, name: 'synthetic-host', inventory: '7', enabled: true, variables: { mode: 'initial', ansible_password: '***' },
      } })
      expect(await run(['group', 'show', 'synthetic-parent'])).toMatchObject({ group: {
        id: 42, inventory: '7', variables: { mode: 'initial', ansible_password: '***' }, total_hosts: 0, total_children: 0,
      } })
      allowWrites = true
      await run(['inventory', 'host-edit', 'synthetic-host', '--name', 'synthetic-updated', '--description', 'Updated host', '--disabled', '--variables', `host.${format}`, '--confirm'],
        { files: [upload(`host.${format}`, updated)] })
      await run(['inventory', 'group-edit', 'synthetic-parent', '--description', 'Updated group', '--variables', `group.${format}`, '--confirm'],
        { files: [upload(`group.${format}`, updated)] })
      await run(['inventory', 'group-add-host', 'synthetic-parent', '--host', 'synthetic-updated', '--confirm'])
      await run(['inventory', 'group-add-host', 'synthetic-parent', '--host', 'synthetic-sibling', '--confirm'])
      await run(['inventory', 'group-add-child', 'synthetic-parent', '--child', 'synthetic-child', '--confirm'])
      await run(['inventory', 'group-add-child', 'synthetic-parent', '--child', 'synthetic-other-child', '--confirm'])
      allowWrites = false
      expect(await run(['inventory', 'hosts', '7'])).toMatchObject({ hosts: [{ id: 42, name: 'synthetic-updated', enabled: false }, { id: 43, name: 'synthetic-sibling' }] })
      expect(await run(['inventory', 'groups', '7'])).toMatchObject({ groups: [{ id: 42, name: 'synthetic-parent' }, { id: 43, name: 'synthetic-child' }, { id: 44, name: 'synthetic-other-child' }] })
      expect(await run(['host', 'show', '42'])).toMatchObject({ host: {
        name: 'synthetic-updated', description: 'Updated host', enabled: false,
        variables: { mode: 'updated', ansible_password: '***' }, groups: [{ id: 42, name: 'synthetic-parent' }],
      } })
      expect(await run(['group', 'show', '42'])).toMatchObject({ group: {
        description: 'Updated group', variables: { mode: 'updated', ansible_password: '***' }, total_hosts: 2, total_children: 2,
        hosts: [{ id: 42, name: 'synthetic-updated' }, { id: 43, name: 'synthetic-sibling' }],
        children: [{ id: 43, name: 'synthetic-child' }, { id: 44, name: 'synthetic-other-child' }],
      } })
      allowWrites = true
      await run(['inventory', 'group-remove-host', '42', '--host', '42', '--confirm'])
      await run(['inventory', 'group-remove-child', '42', '--child', '43', '--confirm'])
      allowWrites = false
      expect(await run(['group', 'show', '42'])).toMatchObject({ group: { total_hosts: 1, total_children: 1,
        hosts: [{ id: 43, name: 'synthetic-sibling' }], children: [{ id: 44, name: 'synthetic-other-child' }],
      } })
      expect(await run(['host', 'show', '42'])).toMatchObject({ host: { name: 'synthetic-updated', groups: [] } })
      expect(await run(['group', 'show', '43'])).toMatchObject({ group: { name: 'synthetic-child', inventory: '7' } })
      expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY-')
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
    } finally { await app.close(); db.close() }
  })
}, 60_000)

test.each([
  { kind: 'inventory', create: ['create', 'synthetic-inventory', '--organization', '7'], remove: 'delete',
    list: ['inventory', 'list'], field: 'inventories', empty: '0 inventories found', path: '/api/v2/inventories/42/' },
  { kind: 'source', create: ['source-create', 'synthetic-source', '--inventory', '7', '--source', 'scm'], remove: 'source-delete',
    list: ['inventory-source', 'list'], field: 'inventory_sources', empty: '0 inventory sources found', path: '/api/v2/inventory_sources/42/' },
].flatMap(resource => [
  { outcome: 'removes the resource', allowWrites: true, permission: true, result: { exitCode: 0 }, remaining: resource.empty, count: '0 total', mutations: 2, deletes: 1 },
  { outcome: 'refuses disabled writes', allowWrites: false, permission: true, result: { error: { code: 'FLAG_BLOCKED' } }, remaining: [{ id: 42 }], count: '1 total', mutations: 1, deletes: 0 },
  { outcome: 'preserves the resource on permission denial', allowWrites: true, permission: false,
    result: { exitCode: 1, stdout: expect.stringContaining('FORBIDDEN') }, remaining: [{ id: 42 }], count: '1 total', mutations: 1, deletes: 1 },
].map(scenario => ({ ...resource, ...scenario }))))(
  'AWX $kind deletion $outcome (S4-001)', async ({ create, remove, list, field, path, allowWrites: enabled, permission, result, remaining, count, mutations, deletes }) => {
    await withFakeService(async ({ directory, port, send }) => {
      const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
      const db = openStore(join(directory, 'artium.db'), provider)
      await seedToolUser(db)
      db.exec("UPDATE tools SET enabled = 1 WHERE name = 'awx-axi'")
      let allowWrites = true
      const reference = { id: 'synthetic-credential', tool: 'awx-axi' as const }
      const adapter = createAwxAdapter({ getCredential: async () => ({ origin: `https://localhost:${port}`,
        token: 'CANARY-awx-token', allowWrites, allowDeletes: true }) })
      const prepare = adapter.prepare.bind(adapter)
      adapter.prepare = async (...input) => {
        const call = await prepare(...input)
        return { ...call, executable: process.execPath,
          args: [join(process.cwd(), 'tools/node_modules/@knowttl/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
      }
      const runner = await Runner.create(join(directory, 'calls'), { pem: readFileSync(join(directory, 'ca.crt'), 'utf8'), certificates: [] })
      const app = createApp({ db, runner, audit: new Audit(db, Date.now, () => {}), adapters: [adapter], environment: {},
        resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]).seed(db), db) })
      const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
      const run = (args: string[]) => app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args } })
      try {
        const created = await run(['inventory', ...create, '--confirm'])
        expect(created.json(), created.body).toMatchObject({ exitCode: 0 })
        allowWrites = enabled
        await send(`/__awx/configuration-permission?enabled=${permission}`, 'POST')
        if (enabled) expect((await run(['inventory', remove, '42', '--dry-run'])).json()).toMatchObject({ exitCode: 0 })
        const before = JSON.parse(await send('/__evidence'))
        const removed = await run(['inventory', remove, '42', '--confirm'])
        expect(removed.json(), removed.body).toMatchObject(result)
        const evidence = JSON.parse(await send('/__evidence'))
        expect(evidence.mutations).toBe(mutations)
        expect(evidence.requests.slice(before.requests.length)).toHaveLength(deletes)
        expect(evidence.requests.filter((request: { method: string }) => request.method === 'DELETE')).toEqual(
          Array.from({ length: deletes }, () => ({ method: 'DELETE', path, auth: 'Bearer', canaryReceived: true })))
        const listed = await run(list)
        expect(listed.json(), listed.body).toMatchObject({ exitCode: 0 })
        expect(decode(listed.json().stdout)).toMatchObject({ count, [field]: remaining })
      } finally { await app.close(); db.close() }
    })
  }, 60_000,
)

test('AWX inventory variables remain private on later reads with writes disabled (S4)', async () => {
  await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    await seedToolUser(db)
    db.exec("UPDATE tools SET enabled = 1 WHERE name = 'awx-axi'")
    let allowWrites = true
    const reference = { id: 'synthetic-credential', tool: 'awx-axi' as const }
    const adapter = createAwxAdapter({ getCredential: async () => ({ origin: `https://localhost:${port}`,
      token: 'CANARY-awx-token', allowWrites, allowDeletes: true }) })
    const prepare = adapter.prepare.bind(adapter)
    adapter.prepare = async (...input) => {
      const call = await prepare(...input)
      if (call.executable === process.execPath) call.args[3] = join(process.cwd(), 'tools/node_modules/.bin/awx-axi')
      else return { ...call, executable: process.execPath, args: [join(process.cwd(), 'tools/node_modules/@knowttl/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
      return call
    }
    const runner = await Runner.create(join(directory, 'calls'), { pem: readFileSync(join(directory, 'ca.crt'), 'utf8'), certificates: [] })
    const app = createApp({ db, runner, audit: new Audit(db, Date.now, () => {}), adapters: [adapter], environment: {},
      resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]).seed(db), db) })
    const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
    const run = async (args: string[], input: RunInput = {}) => {
      const response = await app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args, ...input } })
      expect(response.json(), response.body).toMatchObject({ exitCode: 0 })
      expect(response.body).not.toContain('CANARY-')
      return decode(response.json().stdout)
    }
    try {
      await run(['inventory', 'create', 'synthetic-inventory', '--organization', '7', '--variables', '{"password":"CANARY-inventory"}', '--confirm'])
      allowWrites = false
      expect(await run(['inventory', 'show', 'synthetic-inventory'])).toMatchObject({ inventory: { id: 42, name: 'synthetic-inventory', variables: { password: '***' } } })
      allowWrites = true
      await run(['inventory', 'edit', '42', '--variables', 'inventory.yml', '--confirm'], { files: [upload('inventory.yml', 'password: CANARY-inventory-edit\n')] })
      await run(['inventory', 'source-create', 'synthetic-source', '--inventory', 'synthetic-inventory', '--source', 'scm', '--credential', '9',
        '--source-project', '8', '--source-vars', '{"region":"synthetic","password":"CANARY-source"}', '--update-on-launch', '--confirm'])
      await run(['inventory', 'source-edit', 'synthetic-source', '--name', 'synthetic-updated', '--credential', '10', '--no-update-on-launch',
        '--source-vars', 'source.json', '--confirm'], { files: [upload('source.json', '{"region":"updated","password":"CANARY-source-edit"}')] })
      await run(['inventory', 'source-credential-add', 'synthetic-updated', '--credential', '11', '--confirm'])
      await run(['inventory', 'source-credential-remove', 'synthetic-updated', '--credential', '11', '--confirm'])
      await run(['inventory', 'source-notification-add', 'synthetic-updated', '--event', 'success', '--notification-template', '12', '--confirm'])
      await run(['inventory', 'source-notification-remove', 'synthetic-updated', '--event', 'success', '--notification-template', '12', '--confirm'])
      expect(await run(['inventory', 'sync', 'synthetic-updated', '--confirm', '--wait'])).toMatchObject({ inventory_update: { id: 42, inventory_source: 42, status: 'successful' } })
      allowWrites = false
      expect(await run(['inventory', 'show', '42'])).toMatchObject({ inventory: { name: 'synthetic-inventory', variables: { password: '***' } } })
      expect(await run(['inventory', 'sources', '42'])).toMatchObject({ inventory_sources: [{ id: 42, name: 'synthetic-updated', source: 'scm', source_vars: 'configured' }] })
      expect(await run(['inventory-source', 'list', '--inventory', '42'])).toMatchObject({ inventory_sources: [{ id: 42, name: 'synthetic-updated', inventory: '42' }] })
      expect(await run(['inventory-source', 'show', 'synthetic-updated'])).toMatchObject({ inventory_source: {
        inventory: '42', credential: '10', source_project: '8', update_on_launch: false,
        source_vars: { region: 'updated', password: '***' }, total_updates: 1, updates: [{ id: 42, status: 'successful' }],
      } })
      expect(await run(['inventory', 'updates', '42'])).toMatchObject({ inventory_updates: [{ id: 42, source: '42 (synthetic-updated)', status: 'successful' }] })
      expect(await run(['inventory', 'constructed-show', '71'])).toMatchObject({ inventory: {
        name: 'Synthetic constructed inventory', variables: { mode: 'synthetic', password: '***' }, source_vars: { region: 'synthetic', token: '***' },
      } })
      allowWrites = true
      await run(['inventory', 'edit', '42', '--variables', 'password: CANARY-awx-token\n', '--confirm'])
      allowWrites = false
      expect(await run(['inventory', 'show', '42'])).toMatchObject({ inventory: { variables: '***' } })
      expect(JSON.parse(await send('/__evidence')).requests).toContainEqual(expect.objectContaining({
        method: 'POST', path: '/api/v2/inventory_sources/42/credentials/', body: { id: 11, disassociate: true },
      }))
      expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY-')
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
    } finally { await app.close(); db.close() }
  })
}, 60_000)

test('AWX bulk host create and delete report mixed and uncertain outcomes without trusting limited reads (S12)', async () => {
  await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    await seedToolUser(db)
    db.exec("UPDATE tools SET enabled = 1 WHERE name = 'awx-axi'")
    let allowWrites = false
    let allowDeletes = false
    const reference = { id: 'synthetic-credential', tool: 'awx-axi' as const }
    const adapter = createAwxAdapter({ getCredential: async () => ({ origin: `https://localhost:${port}`,
      token: 'CANARY-awx-token', allowWrites, allowDeletes }) })
    const prepare = adapter.prepare.bind(adapter)
    adapter.prepare = async (...input) => {
      const call = await prepare(...input)
      if (call.executable === process.execPath) {
        call.args[3] = join(process.cwd(), 'tools/node_modules/.bin/awx-axi')
        return call
      }
      return { ...call, executable: process.execPath, args: [join(process.cwd(), 'tools/node_modules/@knowttl/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
    }
    const runner = await Runner.create(join(directory, 'calls'), { pem: readFileSync(join(directory, 'ca.crt'), 'utf8'), certificates: [] })
    const app = createApp({ db, runner, audit: new Audit(db, Date.now, () => {}), adapters: [adapter], environment: {},
      resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]).seed(db), db) })
    const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
    const run = (args: string[], files: ReturnType<typeof upload>[] = []) =>
      app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args, ...(files.length ? { files } : {}) } })
    const evidence = async () => JSON.parse(await send('/__evidence'))
    const hostIds = async (...args: string[]) => {
      const listed = decode((await run(['host', 'list', ...args])).json().stdout) as { count: string, hosts: string | { id: number }[] }
      return { count: listed.count, ids: Array.isArray(listed.hosts) ? listed.hosts.map(host => host.id) : [] }
    }
    const create = ['inventory', 'host-bulk-create', '--inventory', '7', '--hosts-file', 'hosts.json']
    const remove = ['inventory', 'host-bulk-delete', '--hosts-file', 'ids.json']
    const names = upload('hosts.json', JSON.stringify([
      { name: 'not-ready', variables: '{"password":"CANARY-bulk-secret"}' }, { name: 'failed' }, { name: 'access-denied' }]))
    try {
      // Reads stay available and bulk previews and confirmations are refused while writes are off.
      for (const [args, files] of [[create, [names]], [remove, [upload('ids.json', '[42]')]]] as const) {
        for (const flag of ['--dry-run', '--confirm']) {
          expect((await run([...args, flag], [...files])).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
        }
      }
      expect((await hostIds()).ids).toEqual([])
      expect((await evidence()).mutations).toBe(0)

      allowWrites = true
      for (const [args, files] of [[create, [names]], [remove, [upload('ids.json', '[42]')]]] as const) {
        for (const flag of ['--dry-run', '--confirm']) {
          expect((await run([...args, flag], [...files])).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED',
            next: expect.stringContaining('Allow destructive deletes') } })
        }
      }
      expect((await evidence()).mutations).toBe(0)
      allowDeletes = true
      expect((await run(['inventory', 'delete', '42', '--confirm'])).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED', message: expect.stringContaining('matching successful dry-run') } })
      const preview = await run([...create, '--dry-run'], [names])
      expect(preview.json(), preview.body).toMatchObject({ exitCode: 0 })
      expect(decode(preview.json().stdout)).toMatchObject({ dry_run: { action: 'create', type: 'hosts', would_send: 'POST bulk/host_create/' } })
      expect(preview.body).not.toContain('CANARY-bulk-secret')
      const idsPreview = await run([...remove, '--dry-run'], [upload('ids.json', '[42,43,99]')])
      expect(decode(idsPreview.json().stdout)).toMatchObject({ dry_run: { action: 'delete', type: 'hosts', would_send: 'POST bulk/host_delete/' } })
      expect((await run([...remove, '--confirm'], [upload('ids.json', '[42,43,44]')])).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED', message: expect.stringContaining('matching successful dry-run') } })
      expect((await evidence()).mutations).toBe(0)

      await send('/__awx/configuration-permission?enabled=false', 'POST')
      expect((await run([...create, '--confirm'], [names])).json()).toMatchObject({ exitCode: 1, stdout: expect.stringContaining('FORBIDDEN') })
      expect((await evidence()).mutations).toBe(0)
      await send('/__awx/configuration-permission?enabled=true', 'POST')

      const created = await run([...create, '--confirm'], [names])
      expect(created.json(), created.body).toMatchObject({ exitCode: 0 })
      expect(created.body).not.toContain('CANARY-bulk-secret')
      expect((await evidence()).requests).toContainEqual(expect.objectContaining({ method: 'POST', path: '/api/v2/bulk/host_create/',
        body: { inventory: 7, hosts: [{ name: 'not-ready', variables: '{"password":"CANARY-bulk-secret"}' },
          { name: 'failed' }, { name: 'access-denied' }] } }))
      // A one-row page proves nothing about the other hosts.
      expect(await hostIds('--limit', '1')).toEqual({ count: '1 of 3 total', ids: [42] })
      expect((await hostIds('--limit', '100')).ids).toEqual([42, 43, 44])

      // A duplicate batch is rejected atomically by the controller.
      const duplicate = await run([...create, '--confirm'], [names])
      expect(duplicate.json(), duplicate.body).toMatchObject({ exitCode: 2, stdout: expect.stringContaining('VALIDATION_ERROR') })
      expect((await hostIds('--limit', '100')).ids).toEqual([42, 43, 44])

      const freshDuplicate = await run([...create, '--confirm'], [upload('hosts.json', '[{"name":"fresh"},{"name":"fresh"}]')])
      expect(freshDuplicate.json(), freshDuplicate.body).toMatchObject({ exitCode: 2, stdout: expect.stringContaining('VALIDATION_ERROR') })
      expect((await hostIds('--limit', '100')).ids).toEqual([42, 43, 44])

      for (const variables of [{ password: 'CANARY-bulk-secret' }, ['CANARY-bulk-secret']]) {
        const invalidVariables = await run([...create, '--confirm'], [upload('hosts.json', JSON.stringify([
          { name: 'fresh-valid', variables: '{}' }, { name: 'fresh-invalid', variables },
        ]))])
        expect(invalidVariables.json(), invalidVariables.body).toMatchObject({ exitCode: 2, stdout: expect.stringContaining('VALIDATION_ERROR') })
        expect((await hostIds('--limit', '100')).ids).toEqual([42, 43, 44])
      }

      const invalidBatch = await run([...remove, '--confirm'], [upload('ids.json', '[42,43,99]')])
      expect(invalidBatch.json(), invalidBatch.body).toMatchObject({ exitCode: 2, stdout: expect.stringContaining('VALIDATION_ERROR') })
      expect((await hostIds('--limit', '100')).ids).toEqual([42, 43, 44])

      const deletePreview = await run([...remove, '--dry-run'], [upload('ids.json', '[42,43,44]')])
      expect(deletePreview.json(), deletePreview.body).toMatchObject({ exitCode: 0 })
      expect(decode(deletePreview.json().stdout)).toMatchObject({ dry_run: { action: 'delete', type: 'hosts', would_send: 'POST bulk/host_delete/' } })
      const deleted = await run([...remove, '--confirm'], [upload('ids.json', '[42,43,44]')])
      expect(deleted.json(), deleted.body).toMatchObject({ exitCode: 0 })
      expect((await hostIds('--limit', '100')).ids).toEqual([])
      expect((await run([...remove, '--confirm'], [upload('ids.json', '[42,43,44]')])).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED', message: expect.stringContaining('matching successful dry-run') } })

      for (const { mode, unconfirmed } of [
        { mode: 'missing', unconfirmed: [42, 43, 44] },
        { mode: 'null', unconfirmed: [42, 43, 44] },
        { mode: 'array', unconfirmed: [42, 43, 44] },
        { mode: 'no-content', unconfirmed: [42, 43, 44] },
        { mode: 'empty', unconfirmed: [42, 43, 44] },
        { mode: 'mixed', unconfirmed: [44] },
        { mode: 'invalid-message', unconfirmed: [44] },
      ]) {
        expect((await run([...create, '--confirm'], [names])).json()).toMatchObject({ exitCode: 0 })
        await send(`/__awx/bulk-delete-response?mode=${mode}`, 'POST')
        expect((await run([...remove, '--dry-run'], [upload('ids.json', '[42,43,44]')])).json()).toMatchObject({ exitCode: 0 })
        const result = await run([...remove, '--confirm'], [upload('ids.json', '[42,43,44]')])
        expect(result.json(), result.body).toMatchObject({ exitCode: 1 })
        expect(decode(result.json().stdout)).toMatchObject({ code: 'PARTIAL_OUTCOME', requested: 3, unconfirmed_hosts: unconfirmed })
        expect(result.json().stdout).not.toContain('status: deleted')
        expect((await hostIds('--limit', '100')).ids).toEqual([])
      }
      await send('/__awx/bulk-delete-response?mode=valid', 'POST')
      expect(db.prepare("SELECT DISTINCT action, outcome, exit_code FROM audit WHERE tool = 'awx-axi' AND error_code = 'PARTIAL_OUTCOME'").all())
        .toEqual([{ action: 'unknown', outcome: 'completed', exit_code: 1 }])

      // Malformed host files are refused by the pinned CLI before any request.
      const before = (await evidence()).mutations
      for (const content of ['{"name":"x"}', '["not-an-id"]', '[0]']) {
        expect((await run([...remove, '--dry-run'], [upload('ids.json', content)])).json()).toMatchObject({ exitCode: 2 })
      }
      expect((await evidence()).mutations).toBe(before)

      // A dropped connection leaves the outcome unknown; the recovery read is a limited page.
      expect((await run([...create, '--confirm'], [names])).json()).toMatchObject({ exitCode: 0 })
      await send('/__awx/write-outcome?drop=true', 'POST')
      expect((await run([...remove, '--dry-run'], [upload('ids.json', '[44]')])).json()).toMatchObject({ exitCode: 0 })
      const interrupted = await run([...remove, '--confirm'], [upload('ids.json', '[44]')])
      expect(interrupted.json(), interrupted.body).toMatchObject({ error: { code: 'UNKNOWN_OUTCOME',
        next: expect.stringMatching(/awx-axi host list --limit 100.*absence from this limited read does not prove failure/) } })
      await send('/__awx/write-outcome?drop=false', 'POST')
      expect((await hostIds('--limit', '100')).ids).toEqual([42, 43])
      const everything = JSON.stringify(db.prepare("SELECT * FROM audit WHERE tool = 'awx-axi'").all())
      expect(everything).not.toContain('CANARY-')
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
    } finally { await app.close(); db.close() }
  })
}, 60_000)
configurationTests(['inventory'])
