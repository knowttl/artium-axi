import type { z } from 'zod'
import type { userSessionsSchema } from '../../shared/api.js'
import { card, icon } from './design/ui.js'
import { badge } from './design/status.js'
import { escape } from './escape.js'
import { apiForm, timestamp } from './forms.js'

export function sessionTable(csrf: string, path: string, sessions: z.infer<typeof userSessionsSchema>['sessions']): string {
  const rows = sessions.map(session => `<tr><th scope="row"><div class="cell-main">${icon(session.kind === 'browser' ? 'monitor' : 'terminal')}<div><strong>${session.kind === 'browser' ? 'Browser' : 'CLI'}${session.current ? ' (This browser)' : ''}</strong>
    <span class="sub">Signed in ${timestamp(session.createdAt)} · last browser activity ${timestamp(session.lastSeenAt, 'not tracked for CLI')} · expires ${timestamp(session.expiresAt)}</span><span class="sub mono">${escape(session.id)}</span></div></div></th>
    <td class="num">${session.current ? badge('session-current') : ''}${apiForm(csrf, path + '/' + encodeURIComponent(session.id) + '/revoke', 'POST', 'Revoke session', '',
      `Revoke this ${session.kind === 'browser' ? 'browser session' : 'CLI session and all its access and refresh tokens'}?${session.current ? ' This signs you out now.' : ''}`, '', 'btn btn-ghost btn-sm')}</td></tr>`).join('')
  const signOutEverywhere = sessions.length ? apiForm(csrf, path + '/revoke', 'POST', 'Sign out everywhere', '',
    `Sign out all ${sessions.length} active browser and CLI sessions now?${sessions.some(session => session.current) ? ' This includes this browser.' : ''}`, '', 'btn btn-secondary btn-sm') : ''
  return card('Sessions', 'Revoke ends one browser session or CLI token family immediately. Sign out everywhere ends all browser and CLI sessions. People can sign in again while their account is enabled.',
    sessions.length ? `<div class="table-scroll"><table class="tbl session-table"><caption class="sr-only">${sessions.length} active sessions</caption><tbody>${rows}</tbody></table></div>`
      : '<div class="card-body"><p>No active sessions. A new session appears when this person signs in.</p></div>', signOutEverywhere)
}
