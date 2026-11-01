import type { z } from 'zod'
import type { userSessionsSchema } from '../../shared/api.js'
import { escape } from './escape.js'
import { actionForm, timestamp } from './forms.js'
import { card, icon } from './design/ui.js'

export function sessionTable(csrf: string, path: string, sessions: z.infer<typeof userSessionsSchema>['sessions']): string {
  const signOut = sessions.length ? actionForm(csrf, path + '/revoke', 'POST', '<button class="btn btn-secondary btn-sm">Sign out everywhere</button>',
    { consequence: `Sign out all ${sessions.length} active browser and CLI sessions now?${sessions.some(session => session.current) ? ' This includes this browser.' : ''}`, title: 'Sign out everywhere', action: 'Sign out everywhere' }) : ''
  return card('Sessions', 'Browser sessions and CLI sign-ins. Revoking one ends it now; they can sign in again while their account is enabled.', sessions.length
    ? `<div class="table-wrap"><table class="tbl stacked session-table"><caption class="sr-only">${sessions.length} active sessions</caption><thead><tr><th scope="col">Session</th><th scope="col">Signed in</th><th scope="col">Last browser activity</th><th scope="col">Expires</th><th scope="col"><span class="sr-only">Action</span></th></tr></thead><tbody>${sessions.map(session =>
      `<tr><td><div class="cell-main">${icon(session.kind === 'browser' ? 'monitor' : 'terminal')}<div><strong>${session.kind === 'browser' ? 'Browser' : 'CLI'}${session.current ? ' (This browser)' : ''}</strong><span><code>${escape(session.id)}</code></span></div></div></td><td class="muted" data-label="Signed in">${timestamp(session.createdAt)}</td><td class="faint" data-label="Last browser activity">${timestamp(session.lastSeenAt, 'Not tracked for CLI')}</td><td class="muted" data-label="Expires">${timestamp(session.expiresAt)}</td><td class="actions-cell">${actionForm(csrf, path + '/' + encodeURIComponent(session.id) + '/revoke', 'POST', '<button class="btn btn-ghost btn-sm">Revoke</button>',
        { consequence: `Revoke this ${session.kind === 'browser' ? 'browser session' : 'CLI session and all its access and refresh tokens'}?${session.current ? ' This signs you out now.' : ''}`, title: 'Revoke session', action: 'Revoke' })}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="card-body"><p class="none">No active sessions. A new session appears when they sign in.</p></div>', { actions: signOut })
}
