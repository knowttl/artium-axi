import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeTokenTransport, azureTestTenant as tenantId } from '../../../test/fixtures/azure-token-transport.js'
import { azureCommandResources, AzureTokenCache } from './azure-token-cache.js'
import type { AzureTokenIdentity } from './azure-token-cache.js'
import type { AzureResource } from './azure-tokens.js'

const identity = { id: 'synthetic-azure', revision: 1,
  credential: { tenantId, clientId: '22222222-2222-4222-8222-222222222222',
    auth: 'secret', clientSecret: 'CANARY-AZURE-CACHE-SECRET' } } satisfies AzureTokenIdentity

describe('Azure resource token cache', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')) })
  afterEach(() => { vi.useRealTimers() })

  it('coalesces simultaneous ARM reads and reuses their token inside one lifetime', async () => {
    const network = new FakeTokenTransport()
    const cache = new AzureTokenCache(network)
    const plan = azureCommandResources('group list')
    const calls = await Promise.all(Array.from({ length: 8 }, () => cache.acquire(identity, plan)))
    expect(calls.every(tokens => tokens.arm?.accessToken === 'CANARY-AZURE-ACCESS-TOKEN')).toBe(true)
    await cache.acquire(identity, plan)
    expect(network.requests.map(request => request.form.get('scope'))).toEqual(['https://management.azure.com//.default'])
  })

  it.each([
    ['graph query', 'https://management.azure.com//.default'],
    ['rg query', 'https://management.azure.com//.default'],
    ['logs query', 'https://api.loganalytics.io/.default'],
    ['monitor log-analytics query', 'https://api.loganalytics.io/.default'],
    ['storage blob list', 'https://storage.azure.com//.default'],
    ['keyvault secret list', 'https://vault.azure.net//.default'],
    ['acr repository list', 'https://containerregistry.azure.net/.default'],
  ])('acquires only the reviewed audience for %s', async (command, scope) => {
    const network = new FakeTokenTransport()
    await new AzureTokenCache(network).acquire(identity, azureCommandResources(command))
    expect(network.requests.map(request => request.form.get('scope'))).toEqual([scope])
  })

  it('acquires the reviewed RBAC secondary resource', async () => {
    const network = new FakeTokenTransport()
    const cache = new AzureTokenCache(network)
    const result = await cache.acquire(identity, azureCommandResources('role assignment list'))
    expect(Object.keys(result).sort()).toEqual(['arm', 'graph'])
    expect(network.requests.map(request => request.form.get('scope')).sort()).toEqual([
      'https://graph.microsoft.com/.default', 'https://management.azure.com//.default',
    ])
  })

  it('allows ARM RBAC results when optional Graph minting fails', async () => {
    const network = new FakeTokenTransport()
    const post = network.sendPostRequestAsync.bind(network)
    network.sendPostRequestAsync = async (url, options) => {
      if (new URLSearchParams(options?.body).get('scope') === 'https://graph.microsoft.com/.default') throw new Error('CANARY-GRAPH-DENIED')
      return post(url, options)
    }
    const result = new AzureTokenCache(network).acquire(identity, azureCommandResources('rbac list'))
    await vi.advanceTimersByTimeAsync(750)
    expect(Object.keys(await result)).toEqual(['arm'])
  })

  it('requires Graph for RBAC principal name lookup', async () => {
    expect(azureCommandResources('rbac list', { principal: 'synthetic@example.invalid' })).toEqual({
      required: ['arm', 'graph'], optional: [],
    })
    expect(azureCommandResources('rbac list', { principal: tenantId, 'show-query': 'true' })).toEqual({ required: [], optional: [] })
    expect(azureCommandResources('rbac list', { principal: 'synthetic@example.invalid', 'show-query': 'true' })).toEqual({ required: ['graph'], optional: [] })
  })

  it('does not mint tokens for local home or help', async () => {
    const network = new FakeTokenTransport()
    const cache = new AzureTokenCache(network)
    expect(await cache.acquire(identity, azureCommandResources('home'))).toEqual({})
    expect(await cache.acquire(identity, azureCommandResources('group list', { help: 'true' }))).toEqual({})
    expect(network.requests).toHaveLength(0)
  })

  it.each(['unknown command', 'az group show', 'config list'])('reports an adapter gap for %s', command => {
    expect(() => azureCommandResources(command)).toThrow(expect.objectContaining({ code: 'FLAG_BLOCKED' }))
  })

  it.each(['arm', 'logs', 'graph'] as const)('uses the parsed dynamic API resource %s', resource => {
    expect(azureCommandResources('api', { resource })).toEqual({ required: [resource], optional: [] })
  })

  it('rejects unknown resources before any minting', async () => {
    const network = new FakeTokenTransport()
    expect(() => azureCommandResources('api', { resource: 'custom' })).toThrow()
    await expect(new AzureTokenCache(network).acquire(identity, { required: ['arm', 'custom' as AzureResource], optional: [] }))
      .rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' })
    expect(network.requests).toHaveLength(0)
  })

  it('reuses at five minutes remaining and coalesces refresh below the margin', async () => {
    const network = new FakeTokenTransport()
    const cache = new AzureTokenCache(network)
    const plan = azureCommandResources('group list')
    await cache.acquire(identity, plan)
    await vi.advanceTimersByTimeAsync(3300_000)
    await cache.acquire(identity, plan)
    expect(network.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    network.response = { ...network.response, access_token: 'CANARY-REFRESHED' }
    const result = await Promise.all([cache.acquire(identity, plan), cache.acquire(identity, plan)])
    expect(result.map(tokens => tokens.arm?.accessToken)).toEqual(['CANARY-REFRESHED', 'CANARY-REFRESHED'])
    expect(network.requests).toHaveLength(2)
  })

  it('evicts all old-revision resources and refuses an old caller after replacement', async () => {
    const network = new FakeTokenTransport()
    const cache = new AzureTokenCache(network)
    const plan = azureCommandResources('rbac list')
    await cache.acquire(identity, plan)
    cache.replace(identity.id, 2)
    network.response = { ...network.response, access_token: 'CANARY-REPLACED' }
    const result = await cache.acquire({ ...identity, revision: 2 }, plan)
    expect(result.arm?.accessToken).toBe('CANARY-REPLACED')
    expect(result.graph?.accessToken).toBe('CANARY-REPLACED')
    await expect(cache.acquire(identity, plan)).rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' })
    expect(network.requests).toHaveLength(4)
  })

  it('does not return or cache an old acquisition that completes after replacement', async () => {
    const network = new FakeTokenTransport()
    const post = network.sendPostRequestAsync.bind(network)
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    network.sendPostRequestAsync = async (url, options) => {
      if (new URLSearchParams(options?.body).get('client_secret') === identity.credential.clientSecret) await held
      return post(url, options)
    }
    const cache = new AzureTokenCache(network)
    const plan = azureCommandResources('group list')
    const old = cache.acquire(identity, plan)
    const rejected = expect(old).rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' })
    cache.replace(identity.id, 2)
    const replacement: AzureTokenIdentity = { ...identity, revision: 2,
      credential: { ...identity.credential, auth: 'secret', clientSecret: 'CANARY-REPLACEMENT-SECRET' } }
    await cache.acquire(replacement, plan)
    release()
    await rejected
    await cache.acquire(replacement, plan)
    expect(network.requests).toHaveLength(2)
  })

  it('separates credential IDs and clients in the cache', async () => {
    const network = new FakeTokenTransport()
    const cache = new AzureTokenCache(network)
    const plan = azureCommandResources('group list')
    await cache.acquire(identity, plan)
    await cache.acquire({ ...identity, id: 'synthetic-other' }, plan)
    await cache.acquire({ ...identity, credential: { ...identity.credential,
      clientId: '33333333-3333-4333-8333-333333333333' } }, plan)
    expect(network.requests).toHaveLength(3)
  })

  it('bounds a stalled acquisition and discards its late token', async () => {
    const network = new FakeTokenTransport()
    const post = network.sendPostRequestAsync.bind(network)
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    network.sendPostRequestAsync = async (url, options) => { await held; return post(url, options) }
    const cache = new AzureTokenCache(network)
    const plan = azureCommandResources('group list')
    const result = cache.acquire(identity, plan)
    const rejected = expect(result).rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' })
    await vi.advanceTimersByTimeAsync(10_000)
    await rejected
    release()
    await vi.advanceTimersByTimeAsync(0)
    network.sendPostRequestAsync = post
    await cache.acquire(identity, plan)
    expect(network.requests).toHaveLength(2)
  })

  it('aborts the production transport at the acquisition deadline', async () => {
    const network = new FakeTokenTransport()
    let aborted = false
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      if (options?.method === 'GET') {
        const response = await network.sendGetRequestAsync(String(input))
        return new Response(JSON.stringify(response.body), { status: response.status })
      }
      return new Promise((_, reject) => {
        options!.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('CANARY-ABORTED')) }, { once: true })
      })
    })
    try {
      const result = new AzureTokenCache().acquire(identity, azureCommandResources('group list'))
      const rejected = expect(result).rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' })
      await vi.advanceTimersByTimeAsync(10_000)
      await rejected
      expect(aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally { fetch.mockRestore() }
  })

  it('backs off two retries, coalesces failure and permits a later acquisition', async () => {
    const network = new FakeTokenTransport()
    network.failure = 'CANARY-TRANSPORT-FAILURE'
    const cache = new AzureTokenCache(network)
    const plan = azureCommandResources('group list')
    const result = Promise.allSettled([cache.acquire(identity, plan), cache.acquire(identity, plan)])
    await vi.advanceTimersByTimeAsync(0)
    expect(network.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(249)
    expect(network.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(network.requests).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(500)
    expect((await result).map(call => call.status)).toEqual(['rejected', 'rejected'])
    expect(network.requests).toHaveLength(3)
    network.failure = undefined
    await cache.acquire(identity, plan)
    expect(network.requests).toHaveLength(4)
  })
})
