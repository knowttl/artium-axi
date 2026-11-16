import type { FastifyReply } from 'fastify'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { renderToString } from 'react-dom/server'
import type { z } from 'zod'
import type { userSessionsSchema } from '../../shared/api.js'
import { AccountGuide, type AccountGuideProps } from '../../views/account.js'
import { Sessions, type SessionsProps } from '../../views/sessions.js'
import { hoistInlineStyles } from './inline-styles.js'
import { readThemeMode } from './theme-mode.js'

export function sessionsProps(csrf: string, path: string, sessions: z.infer<typeof userSessionsSchema>['sessions']): SessionsProps {
  return { csrf, path, sessions: sessions.map(({ id, kind, current, createdAt, lastSeenAt, expiresAt }) => ({ id, kind, current,
    createdAt: new Date(createdAt).toISOString(), lastSeenAt: lastSeenAt === null ? null : new Date(lastSeenAt).toISOString(), expiresAt: new Date(expiresAt).toISOString() })) }
}

const split = '<!--account-split-->'

export function renderAccountCards(reply: FastifyReply, guide: AccountGuideProps, between: string, sessions: SessionsProps): string {
  const mode = readThemeMode(reply.request)
  const render = (view: React.JSX.Element) => renderToString(<Theme theme={neutralTheme} mode={mode}>{view}</Theme>)
  const { html, style } = hoistInlineStyles(render(<AccountGuide {...guide} />) + split + render(<Sessions {...sessions} />), reply.styleNonce)
  const [guideHtml, sessionsHtml] = html.split(split)
  return `${style || `<style nonce="${reply.styleNonce}"></style>`}<div data-astryx-root>${guideHtml}</div>${between}<div data-astryx-root>${sessionsHtml}</div>`
}
