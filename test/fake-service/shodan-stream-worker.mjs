import { readFileSync } from 'node:fs'
import { Socket } from 'node:net'
import { join } from 'node:path'

const channel = new Socket({ fd: 3, readable: true, writable: true })
let pending = ''
let bounds
let admission
let waitingForStop = false
const send = value => channel.write(JSON.stringify({ version: 1, ...value }) + '\n')
channel.on('data', chunk => {
  pending += chunk.toString('utf8')
  for (;;) {
    const end = pending.indexOf('\n')
    if (end < 0) break
    const message = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1)
    if (message.type === 'admit') {
      if (admission || !/^[a-f0-9]{64}$/.test(message.admission) || message.profilePath !== join(process.env.XDG_CONFIG_HOME, 'shodan-axi/config.json')) process.exit(1)
      admission = message.admission
    } else if (message.type === 'start') {
      if (!admission || message.admission !== admission) process.exit(1)
      bounds = message.bounds
      const profile = JSON.parse(readFileSync(join(process.env.XDG_CONFIG_HOME, 'shodan-axi/config.json'), 'utf8'))
      const reference = profile.profiles.artium.apiKey.env
      if (message.confirmation === 'crash') process.exit(1)
      if (message.confirmation === 'wait-for-stop') { waitingForStop = true; continue }
      if (['idle-timeout', 'max-seconds'].includes(message.confirmation)) {
        send({ type: 'closed', requestId: 'closed', stopReason: message.confirmation, count: 0, bytes: 0,
          partialRecordCount: 0, debugDiscarded: 0, bounds })
        channel.end(); continue
      }
      send({ type: 'ready', requestId: message.requestId })
      if (message.confirmation === 'many-losses') {
        for (let i = 0; i < 1100; i++) send({ type: 'loss', requestId: `loss-${i}`, discarded: 1, reason: 'debug' })
        send({ type: 'closed', requestId: 'closed', stopReason: 'max-bytes', count: 0, bytes: 35200,
          partialRecordCount: 0, debugDiscarded: 1100, bounds })
        channel.end(); continue
      }
      send({ type: 'event', requestId: 'event-1', event: { profile: profile.defaultProfile,
        isolated: process.env.CANARY_AMBIENT === undefined && process.env.SSL_CERT_FILE === undefined, value: message.confirmation === 'leak' ? process.env[reference]
          : message.confirmation === 'trust' ? (process.env.NODE_EXTRA_CA_CERTS ? readFileSync(process.env.NODE_EXTRA_CA_CERTS, 'utf8') : 'no-configured-ca') : 'synthetic' } })
    } else if (message.type === 'stop') {
      send({ type: 'closed', requestId: message.requestId, stopReason: waitingForStop ? 'cancelled' : 'stopped', count: waitingForStop ? 0 : 1, bytes: waitingForStop ? 0 : 1,
        partialRecordCount: 0, debugDiscarded: 0, bounds })
      channel.end()
    }
  }
})
