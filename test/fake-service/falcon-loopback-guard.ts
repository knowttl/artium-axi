import http from 'node:http'
import https from 'node:https'
import childProcess from 'node:child_process'
import { isIP } from 'node:net'
import { syncBuiltinESMExports } from 'node:module'
import { urlToHttpOptions } from 'node:url'
import type { SpawnOptions } from 'node:child_process'

// RTR accepts only Falcon-domain origins. These fixture identities never use DNS.
export const falconTestHosts = ['falcon.synthetic.crowdstrike.com', 'other-falcon.synthetic.crowdstrike.com'] as const
const preload = `--import=${import.meta.url}`
const nodeOptions = (value = '') => value.includes(preload) ? value : `${value} ${preload}`.trim()
process.env.NODE_OPTIONS = nodeOptions(process.env.NODE_OPTIONS)

function checkHost(value: string): string {
  const host = value === '::1' ? value : new URL(`https://${value}`).hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '::1' || isIP(host) === 4 && host.startsWith('127.')
    || falconTestHosts.some(alias => alias === host)) return host
  throw Object.assign(new Error('Falcon test request refused: only loopback endpoints are permitted'), { code: 'FALCON_TEST_NON_LOOPBACK' })
}

function guardedArguments(args: unknown[]): unknown[] {
  const [input, extra, callback] = args
  const url = typeof input === 'string' || input instanceof URL ? new URL(input) : undefined
  if (url) checkHost(url.hostname)
  const options = { ...(url ? urlToHttpOptions(url) : input as http.RequestOptions),
    ...(url && extra && typeof extra === 'object' ? extra : {}) } as https.RequestOptions
  for (const value of [options.hostname, options.host, options.servername]) if (value) checkHost(value)
  if (options.method === 'CONNECT') checkHost(String(options.path))
  const host = checkHost(options.hostname ?? options.host ?? 'localhost')
  if (falconTestHosts.some(alias => alias === host)) {
    options.hostname = '127.0.0.1'
    delete options.host
    delete options.lookup
    options.servername = host
    options.headers = { ...options.headers, host }
  }
  return [options, url ? typeof extra === 'function' ? extra : callback : extra]
}

for (const transport of [http, https]) for (const method of ['request', 'get'] as const) {
  const original = transport[method]
  transport[method] = ((...args: unknown[]) => Reflect.apply(original, transport, guardedArguments(args))) as typeof original
}
const fetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  const host = checkHost(url.hostname)
  // Fetch has no per-request SNI/lookup seam; synthetic aliases use HTTPS above.
  if (falconTestHosts.some(alias => alias === host)) throw new Error('Synthetic Falcon aliases require the guarded HTTPS transport')
  return fetch(input, init)
}
const spawn = childProcess.spawn
childProcess.spawn = ((...args: unknown[]) => {
  if (args[0] === process.execPath) {
    const index = Array.isArray(args[1]) ? 2 : 1
    const options = args[index] as SpawnOptions | undefined
    const environment = options?.env ?? process.env
    args[index] = { ...options, env: { ...environment, NODE_OPTIONS: nodeOptions(environment.NODE_OPTIONS) } }
  }
  return Reflect.apply(spawn, childProcess, args)
}) as typeof spawn
syncBuiltinESMExports()
