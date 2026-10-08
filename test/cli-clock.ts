// Injected only into the stalled-request test bundle, never the production build.
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import { setTimeout as nativeSetTimeout, clearTimeout as nativeClearTimeout } from 'node:timers'

let elapsed = 0
const timers = new Map<NodeJS.Timeout, { due: number, callback: () => void }>()
const nativeRequest = https.request

export function setTimeout(callback: () => void, delay: number) {
  const timer = nativeSetTimeout(callback, delay)
  timers.set(timer, { due: elapsed + delay, callback })
  process.send!({ event: 'scheduled', delay })
  return timer
}

export function clearTimeout(timer: NodeJS.Timeout) {
  timers.delete(timer)
  nativeClearTimeout(timer)
}

// Prove body stalls after the client receives headers, not just after server writes.
https.request = ((...args: Parameters<typeof nativeRequest>) => {
  const request = nativeRequest(...args)
  request.on('response', () => process.send!({ event: 'response' }))
  return request
}) as typeof nativeRequest
syncBuiltinESMExports()

// Keep the child alive until the parent observes socket cleanup, so process exit
// cannot conceal a failure to abort the real connection.
process.on('message', (message: { advance?: number, release?: boolean }) => {
  if (message.release) {
    process.disconnect()
    return
  }
  elapsed += message.advance!
  for (const [timer, entry] of timers) {
    if (entry.due > elapsed) continue
    timers.delete(timer)
    nativeClearTimeout(timer)
    entry.callback()
  }
  process.send!({ event: 'advanced', elapsed, pending: timers.size })
})
