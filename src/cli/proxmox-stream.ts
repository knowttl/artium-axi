import { createHash, randomBytes } from 'node:crypto'
import { constants, fstatSync, readFileSync } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { Socket } from 'node:net'
import { isAbsolute } from 'node:path'
import type { Duplex } from 'node:stream'
import { rootCertificates } from 'node:tls'
import { encode, decode } from '@toon-format/toon'
import { z } from 'zod'
import { ArtiumError, errors } from '../shared/errors.js'
import { cliVersion } from '../shared/version.js'
import { ProxmoxFrameMeter, ProxmoxStreamWire } from '../shared/proxmox-stream.js'
import { resolveProxmoxStream } from '../shared/proxmox-commands.js'
import { privateDescriptor, deliverPrivateResult } from './private-result.js'
import { toolInput } from './input.js'
import type { Client } from './http.js'

const limitSchema = z.object({ bytes: z.number().int().positive().max(8 * 1024 ** 3), streamMs: z.number().int().positive().max(1800000),
  duplexBytes: z.number().int().positive().max(64 * 1024 ** 2), uploadBytes: z.number().int().positive().max(250 * 1024 ** 2),
  spiceBytes: z.number().int().positive().max(4 * 1024 ** 2), idleMs: z.number().int().positive(), perUser: z.literal(1), total: z.literal(16), frameBytes: z.literal(1048576) })
const leaseSchema = z.object({ id: z.uuid(), expiresAt: z.number().int(), limits: limitSchema,
  selection: z.object({ duplex: z.boolean(), spice: z.boolean(), upload: z.boolean(), preview: z.boolean(), write: z.boolean(), operation: z.string() }) })

export async function openProxmoxStream(client: Client, id: string, token: string, signal: AbortSignal) {
  const url = new URL(`${client.serverUrl}/v1/tools/proxmox-axi/streams/${id}/pipe`)
  const key = randomBytes(16).toString('base64')
  return await new Promise<{ socket: Duplex, head: Buffer }>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { signal, rejectUnauthorized: true,
      ca: client.caFile ? [...rootCertificates, readFileSync(client.caFile, 'utf8')] : undefined,
      headers: { authorization: `Bearer ${token}`, connection: 'Upgrade', upgrade: 'websocket',
        'sec-websocket-version': '13', 'sec-websocket-key': key, 'x-artium-cli-version': cliVersion } })
    const deadline = setTimeout(() => request.destroy(new ArtiumError('SERVER_UNAVAILABLE')), 10000)
    request.once('upgrade', (response, socket, head) => {
      clearTimeout(deadline)
      if (response.statusCode !== 101 || response.headers.upgrade?.toLowerCase() !== 'websocket'
        || response.headers['sec-websocket-accept'] !== createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
        || response.headers['sec-websocket-extensions']) { socket.destroy(); reject(new ArtiumError('INVALID_RESPONSE')); return }
      resolve({ socket, head })
    })
    request.once('response', response => { clearTimeout(deadline); response.resume(); reject(new ArtiumError('TOOL_NOT_GRANTED')) })
    request.once('error', () => { clearTimeout(deadline); reject(new ArtiumError('SERVER_UNAVAILABLE')) })
    request.end()
  })
}

export async function proxmoxStream(createClient: () => Client, supplied: string[], output: (stream: 'stdout' | 'stderr', text: string) => void): Promise<boolean> {
  if (supplied[0] !== 'stream') return false
  const usage = 'artium-axi proxmox-axi stream -- transfer|duplex <native arguments>'
  const { separator, json, options, args, route } = resolveProxmoxStream(supplied)
  const print = (value: unknown) => output('stdout', (json ? JSON.stringify(value) : encode(value)) + '\n')
  if (separator < 0 && options.length === 1 && options[0] === '--help') {
    print({ usage, help: ['Use stream limits for authenticated host bounds.',
      'Execution requires PROXMOX_AXI_STREAM_FD on a private descriptor of at least 5. Duplex also requires a distinct PROXMOX_AXI_RESULT_FD.',
      'Upload --input-file is local only. Preview and confirm identical sources and native inputs; interrupted operations never reconnect or resend.',
      'Keep partial download bytes only when completion, count and SHA-256 are verified.'] })
    return true
  }
  if (separator < 0 && options.length === 1 && options[0] === 'limits') {
    const value = limitSchema.safeParse(await createClient().authenticated('/v1/tools/proxmox-axi/streams/limits', 'GET'))
    if (!value.success) throw new ArtiumError('INVALID_RESPONSE')
    print(value.data)
    return true
  }
  if (separator < 0 || options.length) throw new ArtiumError('INVALID_INPUT', 'Use stream -- before native transfer or duplex arguments.', usage)
  if (!route) throw new ArtiumError('INVALID_INPUT', 'Select a reviewed managed transfer or duplex route.', usage)
  if (args.includes('--help')) { print({ usage, command: route.command, operation: route.operationId,
    flags: { ...route.flags, ...(route.path.endsWith('/upload') ? { 'input-file': 'absolute local source' } : {}) } }); return true }
  const preview = args.includes('--preview'), duplex = args[0] === 'duplex', spice = /\/(spiceproxy|spiceshell)$/.test(route.path), upload = route.path.endsWith('/upload')
  const byteFd = preview ? undefined : privateDescriptor(process.env.PROXMOX_AXI_STREAM_FD, duplex)
  if (duplex && !preview) {
    const resultFd = privateDescriptor(process.env.PROXMOX_AXI_RESULT_FD), a = fstatSync(byteFd!), b = fstatSync(resultFd)
    if (a.dev === b.dev && a.ino === b.ino) throw new ArtiumError('INVALID_INPUT', 'Byte and setup destinations must be distinct private channels.')
  }
  let path: string | undefined
  for (let index = 0; index < args.length; index++) if (args[index] === '--input-file' || args[index].startsWith('--input-file=')) {
    if (path !== undefined || !upload) throw new ArtiumError('INVALID_INPUT')
    const inline = args[index].slice('--input-file='.length)
    path = args[index].includes('=') ? inline : args[index + 1]
    if (!path || !isAbsolute(path)) throw new ArtiumError('INVALID_INPUT', 'Upload sources must be absolute local file paths.')
    args.splice(index, args[index].includes('=') ? 1 : 2); index--
  }
  if (upload !== !!path) throw new ArtiumError('INVALID_INPUT', 'Supply one local --input-file for an upload.')
  const input = await toolInput('proxmox-axi', args), client = createClient(), controller = new AbortController()
  let source: FileHandle | undefined, byteSocket: Socket | undefined, socket: Duplex | undefined, leaseId: string | undefined
  let sourceInfo: { bytes: number, sha256: string } | undefined, running = false, completed = false
  let timer: NodeJS.Timeout | undefined
  const cancel = () => { controller.abort(); client.cancel(); socket?.destroy(); byteSocket?.destroy() }
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
  try {
    if (path) {
      source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const info = await source.stat()
      if (!info.isFile() || info.size > 250 * 1024 ** 2) throw new ArtiumError('INVALID_INPUT')
      const hash = createHash('sha256')
      for await (const chunk of source.createReadStream({ start: 0, autoClose: false, highWaterMark: 32768 })) hash.update(chunk)
      sourceInfo = { bytes: info.size, sha256: hash.digest('hex') }
    }
    const response = leaseSchema.safeParse(await client.authenticated('/v1/tools/proxmox-axi/streams', 'POST', { args: input.args,
      ...(input.stdin === undefined ? {} : { stdin: input.stdin }), ...(sourceInfo ? { source: sourceInfo } : {}) }))
    if (!response.success) throw new ArtiumError('INVALID_RESPONSE')
    const lease = response.data
    leaseId = lease.id
    if (lease.selection.operation !== route.operationId || lease.selection.duplex !== duplex || lease.selection.spice !== spice
      || lease.selection.upload !== upload || lease.selection.preview !== preview) throw new ArtiumError('INVALID_RESPONSE')
    timer = setTimeout(cancel, Math.max(0, lease.expiresAt - Date.now()))
    const connection = await client.transferSession(token => openProxmoxStream(client, lease.id, token, controller.signal))
    socket = connection.socket
    if (!preview && !spice) {
      byteSocket = new Socket({ fd: byteFd!, readable: duplex, writable: true, allowHalfOpen: true })
      byteSocket.on('error', cancel)
    }
    const sent = new ProxmoxFrameMeter(lease.limits.duplexBytes), received = new ProxmoxFrameMeter(lease.limits.duplexBytes)
    const hash = createHash('sha256'); let count = 0, byteEOF = false
    let resolveRunning!: () => void
    const ready = new Promise<void>(resolve => { resolveRunning = resolve })
    let result!: (value: { stdout: string, stderr: string, exitCode: number }) => void, fail!: (error: Error) => void
    const finished = new Promise<{ stdout: string, stderr: string, exitCode: number }>((resolve, reject) => { result = resolve; fail = reject })
    const wire = new ProxmoxStreamWire(socket, false, async packet => {
      if (packet.type === 'data') {
        if (preview || spice || byteEOF || !byteSocket) throw new ArtiumError('INVALID_RESPONSE')
        if (duplex) received.add(packet.bytes)
        else { count += packet.bytes.length; hash.update(packet.bytes); if (count > lease.limits.bytes) throw new ArtiumError('INVALID_RESPONSE') }
        await new Promise<void>((resolve, reject) => byteSocket!.write(packet.bytes, error => error ? reject(error) : resolve()))
      } else if (packet.type === 'eof') {
        if (byteEOF) throw new ArtiumError('INVALID_RESPONSE')
        byteEOF = true
        if (duplex && !preview) { byteSocket!.push(null); byteSocket!.resume() }
        if (byteSocket) await new Promise<void>(resolve => byteSocket!.end(resolve))
      } else {
        const event = packet.value
        if (event.event === 'running') { if (running) throw new ArtiumError('INVALID_RESPONSE'); running = true; resolveRunning() }
        else if (event.event === 'setup') {
          if (preview || !duplex && !spice || event.result.operation !== route.operationId
            || event.result.path !== `/v1/results/proxmox-axi/${encodeURIComponent(route.operationId)}/${event.result.id}`) throw new ArtiumError('INVALID_RESPONSE')
          await deliverPrivateResult(() => client, { tool: 'proxmox-axi', operation: event.result.operation, id: event.result.id,
            fd: spice ? process.env.PROXMOX_AXI_STREAM_FD : process.env.PROXMOX_AXI_RESULT_FD, json: true,
            maxBytes: spice ? lease.limits.spiceBytes : 65540, expected: event.result }, () => {})
        } else if (event.event === 'result') {
          if (!byteEOF) throw new ArtiumError('INVALID_RESPONSE')
          if (event.exitCode === 0 && !preview) {
            const value = (event.stdout.trimStart().startsWith('{') ? JSON.parse(event.stdout) : decode(event.stdout)) as { transfer?: Record<string, unknown> }
            const transfer = value.transfer
            if (transfer?.status !== 'complete') throw new ArtiumError('INVALID_RESPONSE')
            if (duplex) {
              const a = sent.finish(), b = received.finish()
              if (transfer.sent !== a.bytes || transfer.sentSha256 !== a.sha256 || transfer.framesSent !== a.frames
                || transfer.received !== b.bytes || transfer.receivedSha256 !== b.sha256 || transfer.framesReceived !== b.frames) throw new ArtiumError('INVALID_RESPONSE')
            } else if (upload ? transfer.bytes !== sourceInfo!.bytes || transfer.sha256 !== sourceInfo!.sha256
              : !spice && (transfer.bytes !== count || transfer.sha256 !== hash.digest('hex'))) throw new ArtiumError('INVALID_RESPONSE')
          }
          await wire.send({ type: 'control', value: { event: 'delivered' } })
          completed = true
          result(event)
        } else if (event.event === 'failed') {
          fail(new ArtiumError(Object.hasOwn(errors, event.code) ? event.code as keyof typeof errors : 'SERVER_UNAVAILABLE'))
        } else throw new ArtiumError('INVALID_RESPONSE')
      }
    }, connection.head)
    socket.once('close', () => {
      resolveRunning()
      if (!completed) fail(new ArtiumError(route.effect === 'write' && !preview && running ? 'UNKNOWN_OUTCOME' : 'SERVER_UNAVAILABLE',
        'Stream interrupted; discard partial bytes. No request was retried.'))
    })
    const uploadInput = (async () => {
      if (source) {
        const hash = createHash('sha256'); let bytes = 0
        for await (const chunk of source.createReadStream({ start: 0, autoClose: false, highWaterMark: 32768 })) {
          const data = Buffer.from(chunk); bytes += data.length; hash.update(data)
          if (bytes > sourceInfo!.bytes) throw new ArtiumError('INVALID_INPUT', 'Upload source changed.')
          await wire.send({ type: 'data', bytes: data })
        }
        if (bytes !== sourceInfo!.bytes || hash.digest('hex') !== sourceInfo!.sha256) throw new ArtiumError('INVALID_INPUT', 'Upload source changed.')
        await wire.send({ type: 'eof' })
      } else if (duplex && !preview) {
        await ready
        if (!running) return
        for await (const chunk of byteSocket!) {
          const bytes = Buffer.from(chunk); sent.add(bytes)
          for (let index = 0; index < bytes.length; index += 32768) await wire.send({ type: 'data', bytes: bytes.subarray(index, index + 32768) })
        }
        sent.finish(); await wire.send({ type: 'eof' })
      }
    })()
    void uploadInput.catch(error => { fail(error); socket?.destroy() })
    try {
      const value = await finished
      output('stdout', json ? JSON.stringify(value.stdout.trimStart().startsWith('{') ? JSON.parse(value.stdout) : decode(value.stdout)) + '\n' : value.stdout)
      output('stderr', value.stderr); process.exitCode = value.exitCode
      await uploadInput
    } finally { clearTimeout(timer); socket.destroy() }
  } finally {
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel)
    clearTimeout(timer)
    controller.abort(); socket?.destroy(); byteSocket?.destroy(); await source?.close()
    if (leaseId) await client.transferSession(token => client.request(`/v1/tools/proxmox-axi/streams/${leaseId}`, 'DELETE', undefined, token)).catch(() => {})
  }
  return true
}
