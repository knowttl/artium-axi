import type { z } from 'zod'
import { shodanStreamBounds, shodanStreamPolicy } from '../shared/shodan-stream.js'
import { ArtiumError } from '../shared/errors.js'

type Policy = z.infer<typeof shodanStreamPolicy>
type Bounds = z.infer<typeof shodanStreamBounds>
interface Reservation { user: string, credential: string, events: number, bytes: number, active: boolean }

export class ShodanCapacity {
  private reservations = new Map<string, Reservation>()

  reserve(id: string, user: string, credential: string, policy: Policy, requested: Bounds) {
    const select = (value: number | undefined, ceiling: number) => {
      if (value !== undefined && value > ceiling) throw new ArtiumError('INVALID_INPUT')
      return value ?? ceiling
    }
    const events = select(requested.events, policy.sessionEvents), bytes = select(requested.bytes, policy.sessionBytes)
    const retentionSeconds = select(requested.retentionSeconds, policy.retentionSeconds)
    const leaseSeconds = select(requested.leaseSeconds ?? Math.min(policy.leaseSeconds, 900), policy.leaseSeconds)
    const all = [...this.reservations.values()], active = all.filter(entry => entry.active)
    if (this.reservations.has(id) || active.length >= policy.total
      || active.filter(entry => entry.user === user).length >= policy.perUser
      || active.filter(entry => entry.credential === credential).length >= policy.perCredential
      || all.reduce((sum, entry) => sum + entry.events, events) > policy.totalEvents
      || all.reduce((sum, entry) => sum + entry.bytes, bytes) > policy.totalBytes) throw new ArtiumError('TOO_MANY_CALLS')
    this.reservations.set(id, { user, credential, events, bytes, active: true })
    return { events, bytes, retentionSeconds, leaseSeconds }
  }

  stopped(id: string) { const entry = this.reservations.get(id); if (entry) entry.active = false }
  release(id: string) { this.reservations.delete(id) }
}
