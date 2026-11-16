import type { z } from 'zod'
import type { userSessionsSchema } from '../../shared/api.js'
import type { SessionsProps } from '../../views/sessions.js'

export function sessionsProps(csrf: string, path: string, sessions: z.infer<typeof userSessionsSchema>['sessions']): SessionsProps {
  return { csrf, path, sessions: sessions.map(({ id, kind, current, createdAt, lastSeenAt, expiresAt }) => ({ id, kind, current,
    createdAt: new Date(createdAt).toISOString(), lastSeenAt: lastSeenAt === null ? null : new Date(lastSeenAt).toISOString(), expiresAt: new Date(expiresAt).toISOString() })) }
}
