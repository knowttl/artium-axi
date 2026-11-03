import { constants, createDeflate, createInflate } from 'node:zlib'

// SPDY/3 protocol dictionary, from moby/spdystream v0.5.0 spdy/dictionary.go.
// Copyright 2013 The Go Authors. Protocol-data redistribution notice:
/*
 * Copyright 2009 The Go Authors.
 * 
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 * 
 *    * Redistributions of source code must retain the above copyright
 * notice, this list of conditions and the following disclaimer.
 *    * Redistributions in binary form must reproduce the above
 * copyright notice, this list of conditions and the following disclaimer
 * in the documentation and/or other materials provided with the
 * distribution.
 *    * Neither the name of Google LLC nor the names of its
 * contributors may be used to endorse or promote products derived from
 * this software without specific prior written permission.
 * 
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
// SHA-256: 51d27341373f923f3cd88e1eb7162aeaa3723d7585ff2399201dc06498407f02
const dictionary = Buffer.from('AAAAB29wdGlvbnMAAAAEaGVhZAAAAARwb3N0AAAAA3B1dAAAAAZkZWxldGUAAAAFdHJhY2UAAAAGYWNjZXB0AAAADmFjY2VwdC1jaGFyc2V0AAAAD2FjY2VwdC1lbmNvZGluZwAAAA9hY2NlcHQtbGFuZ3VhZ2UAAAANYWNjZXB0LXJhbmdlcwAAAANhZ2UAAAAFYWxsb3cAAAANYXV0aG9yaXphdGlvbgAAAA1jYWNoZS1jb250cm9sAAAACmNvbm5lY3Rpb24AAAAMY29udGVudC1iYXNlAAAAEGNvbnRlbnQtZW5jb2RpbmcAAAAQY29udGVudC1sYW5ndWFnZQAAAA5jb250ZW50LWxlbmd0aAAAABBjb250ZW50LWxvY2F0aW9uAAAAC2NvbnRlbnQtbWQ1AAAADWNvbnRlbnQtcmFuZ2UAAAAMY29udGVudC10eXBlAAAABGRhdGUAAAAEZXRhZwAAAAZleHBlY3QAAAAHZXhwaXJlcwAAAARmcm9tAAAABGhvc3QAAAAIaWYtbWF0Y2gAAAARaWYtbW9kaWZpZWQtc2luY2UAAAANaWYtbm9uZS1tYXRjaAAAAAhpZi1yYW5nZQAAABNpZi11bm1vZGlmaWVkLXNpbmNlAAAADWxhc3QtbW9kaWZpZWQAAAAIbG9jYXRpb24AAAAMbWF4LWZvcndhcmRzAAAABnByYWdtYQAAABJwcm94eS1hdXRoZW50aWNhdGUAAAATcHJveHktYXV0aG9yaXphdGlvbgAAAAVyYW5nZQAAAAdyZWZlcmVyAAAAC3JldHJ5LWFmdGVyAAAABnNlcnZlcgAAAAJ0ZQAAAAd0cmFpbGVyAAAAEXRyYW5zZmVyLWVuY29kaW5nAAAAB3VwZ3JhZGUAAAAKdXNlci1hZ2VudAAAAAR2YXJ5AAAAA3ZpYQAAAAd3YXJuaW5nAAAAEHd3dy1hdXRoZW50aWNhdGUAAAAGbWV0aG9kAAAAA2dldAAAAAZzdGF0dXMAAAAGMjAwIE9LAAAAB3ZlcnNpb24AAAAISFRUUC8xLjEAAAADdXJsAAAABnB1YmxpYwAAAApzZXQtY29va2llAAAACmtlZXAtYWxpdmUAAAAGb3JpZ2luMTAwMTAxMjAxMjAyMjA1MjA2MzAwMzAyMzAzMzA0MzA1MzA2MzA3NDAyNDA1NDA2NDA3NDA4NDA5NDEwNDExNDEyNDEzNDE0NDE1NDE2NDE3NTAyNTA0NTA1MjAzIE5vbi1BdXRob3JpdGF0aXZlIEluZm9ybWF0aW9uMjA0IE5vIENvbnRlbnQzMDEgTW92ZWQgUGVybWFuZW50bHk0MDAgQmFkIFJlcXVlc3Q0MDEgVW5hdXRob3JpemVkNDAzIEZvcmJpZGRlbjQwNCBOb3QgRm91bmQ1MDAgSW50ZXJuYWwgU2VydmVyIEVycm9yNTAxIE5vdCBJbXBsZW1lbnRlZDUwMyBTZXJ2aWNlIFVuYXZhaWxhYmxlSmFuIEZlYiBNYXIgQXByIE1heSBKdW4gSnVsIEF1ZyBTZXB0IE9jdCBOb3YgRGVjIDAwOjAwOjAwIE1vbiwgVHVlLCBXZWQsIFRodSwgRnJpLCBTYXQsIFN1biwgR01UY2h1bmtlZCx0ZXh0L2h0bWwsaW1hZ2UvcG5nLGltYWdlL2pwZyxpbWFnZS9naWYsYXBwbGljYXRpb24veG1sLGFwcGxpY2F0aW9uL3hodG1sK3htbCx0ZXh0L3BsYWluLHRleHQvamF2YXNjcmlwdCxwdWJsaWNwcml2YXRlbWF4LWFnZT1nemlwLGRlZmxhdGUsc2RjaGNoYXJzZXQ9dXRmLThjaGFyc2V0PWlzby04ODU5LTEsdXRmLSwqLGVucT0wLg==', 'base64')

// Synthetic SPDY/3 echo peer for client-go v0.32.2's WebSocket tunnel.
// https://github.com/kubernetes/client-go/blob/v0.32.2/tools/portforward/tunneling_dialer.go
// Empty SYN_REPLY headers are valid. Incoming headers associate error/data streams.
export function kubernetesSpdyEcho(send: (bytes: Buffer) => void, close: () => void) {
  let pending = Buffer.alloc(0), processing = Promise.resolve()
  const compressor = createDeflate()
  const inflater = createInflate({ dictionary })
  const inflated: Buffer[] = []
  inflater.on('data', (bytes: Buffer) => inflated.push(bytes))
  inflater.on('error', close)
  const compressed: Buffer[] = []
  const counts: { stream: number, kind: string, receivedFrames: number, sentFrames: number,
    receivedBytes: number, sentBytes: number, receivedEOF: number, sentEOF: number, resets: number }[] = []
  compressor.on('data', (bytes: Buffer) => compressed.push(bytes))
  compressor.on('error', close)
  const streams = new Map<number, { queue: Buffer[], eof: boolean, kind: string, request: string }>()
  const packet = (id: number, payload: Buffer, control = 0, flags = 0) => {
    const streamId = !control ? id : [2, 3, 9].includes(control) && payload.length >= 4 ? payload.readUInt32BE(0) & 0x7fffffff : 0
    const counter = counts.find(entry => entry.stream === streamId)
    if (counter) { counter.sentFrames++; if (!control) counter.sentBytes += payload.length; if (flags & 1) counter.sentEOF++ }
    const header = Buffer.alloc(8)
    if (control) { header.writeUInt16BE(0x8003); header.writeUInt16BE(control, 2) }
    else header.writeUInt32BE(id)
    header[4] = flags; header.writeUIntBE(payload.length, 5, 3)
    send(Buffer.concat([header, payload]))
  }
  const flush = (id: number) => {
    const stream = streams.get(id)
    if (!stream) return
    // The pinned moby/spdystream transport does not implement WINDOW_UPDATE.
    // TCP/WebSocket writes carry backpressure; do not invent a return window.
    while (stream.queue.length) {
      const first = stream.queue[0], count = Math.min(first.length, 16384)
      packet(id, first.subarray(0, count))
      if (count === first.length) stream.queue.shift()
      else stream.queue[0] = first.subarray(count)
    }
    if (stream.eof && !stream.queue.length) {
      packet(id, Buffer.alloc(0), 0, 1); streams.delete(id)
      for (const [otherId, other] of streams) if (other.kind === 'error' && other.request === stream.request) {
        packet(otherId, Buffer.alloc(0), 0, 1); streams.delete(otherId)
      }
    }
  }
  const accept = async (type: number, id: number, flags: number, bytes: Buffer) => {
    if (type === 1) {
      if (bytes.length < 10) throw new Error('Invalid SYN_STREAM')
      const stream = bytes.readUInt32BE(0) & 0x7fffffff
      await new Promise<void>((resolve, reject) => inflater.write(bytes.subarray(10), error => error ? reject(error) : resolve()))
      const headers = Buffer.concat(inflated.splice(0)), fields = new Map<string, string>()
      let offset = 4
      for (let index = 0; index < headers.readUInt32BE(0); index++) {
        const nameLength = headers.readUInt32BE(offset); offset += 4
        const name = headers.subarray(offset, offset + nameLength).toString().toLowerCase(); offset += nameLength
        const valueLength = headers.readUInt32BE(offset); offset += 4
        fields.set(name, headers.subarray(offset, offset + valueLength).toString()); offset += valueLength
      }
      streams.set(stream, { queue: [], eof: false, kind: fields.get('streamtype') ?? '',
        request: fields.get('port') + ':' + fields.get('requestid') })
      if (counts.length < 32) counts.push({ stream, kind: fields.get('streamtype') === 'error' ? 'error' : fields.get('streamtype') === 'data' ? 'data' : 'other',
        receivedFrames: 1, sentFrames: 0, receivedBytes: 0, sentBytes: 0, receivedEOF: flags & 1 ? 1 : 0, sentEOF: 0, resets: 0 })
      compressor.write(Buffer.alloc(4))
      await new Promise<void>(resolve => compressor.flush(constants.Z_SYNC_FLUSH, resolve))
      const identity = Buffer.alloc(4); identity.writeUInt32BE(stream)
      packet(0, Buffer.concat([identity, ...compressed.splice(0)]), 2)
    } else if (type === 6) packet(0, bytes, 6)
    else if (type === 3) {
      const stream = bytes.readUInt32BE(0) & 0x7fffffff
      const counter = counts.find(entry => entry.stream === stream)
      if (counter) { counter.receivedFrames++; counter.resets++ }
      streams.delete(stream)
    }
    else if (!type) {
      const counter = counts.find(entry => entry.stream === id)
      if (counter) { counter.receivedFrames++; counter.receivedBytes += bytes.length; if (flags & 1) counter.receivedEOF++ }
      const stream = streams.get(id)
      if (!stream) return
      if (bytes.length) {
        stream.queue.push(Buffer.from(bytes))
      }
      if (flags & 1) stream.eof = true
      flush(id)
    }
  }
  return {
    counts,
    receive(bytes: Buffer) {
      pending = Buffer.concat([pending, bytes])
      if (pending.length > 4 * 1024 * 1024) { close(); return }
      while (pending.length >= 8) {
        const size = pending.readUIntBE(5, 3)
        if (size > 1024 * 1024) { close(); return }
        if (pending.length < 8 + size) return
        const control = Boolean(pending[0] & 128), type = control ? pending.readUInt16BE(2) : 0
        const id = control ? 0 : pending.readUInt32BE(0) & 0x7fffffff, flags = pending[4]
        const payload = Buffer.from(pending.subarray(8, 8 + size))
        pending = Buffer.from(pending.subarray(8 + size))
        processing = processing.then(() => accept(type, id, flags, payload)).catch(close)
      }
    },
    close() { console.error(JSON.stringify({ diagnostic: 's15-spdy', streams: counts })); compressor.destroy(); inflater.destroy(); streams.clear() },
  }
}
