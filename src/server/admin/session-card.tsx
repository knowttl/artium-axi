import type { FastifyReply } from 'fastify'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { renderToString } from 'react-dom/server'
import type { z } from 'zod'
import type { userSessionsSchema } from '../../shared/api.js'
import { Sessions, type SessionsProps } from '../../views/sessions.js'
import { hoistInlineStyles } from './inline-styles.js'
import { readThemeMode } from './theme-mode.js'

export function sessionsProps(csrf: string, path: string, sessions: z.infer<typeof userSessionsSchema>['sessions']): SessionsProps {
  return { csrf, path, sessions: sessions.map(({ id, kind, current, createdAt, lastSeenAt, expiresAt }) => ({ id, kind, current,
    createdAt: new Date(createdAt).toISOString(), lastSeenAt: lastSeenAt === null ? null : new Date(lastSeenAt).toISOString(), expiresAt: new Date(expiresAt).toISOString() })) }
}

export function renderSessionsCard(reply: FastifyReply, props: SessionsProps): string {
  const { html, style } = hoistInlineStyles(renderToString(<Theme theme={neutralTheme} mode={readThemeMode(reply.request)}><Sessions {...props} /></Theme>), reply.styleNonce)
  return `${style}<div data-astryx-root>${html}</div>`
}
