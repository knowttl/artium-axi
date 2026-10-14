import type { z } from 'zod'
import type { userSessionsSchema } from '../../shared/api.js'
import { escape } from './escape.js'
import { apiForm, timestamp } from './forms.js'

export function sessionTable(csrf: string, path: string, sessions: z.infer<typeof userSessionsSchema>['sessions']): string {
  return `<section><h2>Sessions</h2><p>Revoke ends one browser session or CLI token family immediately. Sign out everywhere ends all browser and CLI sessions. People can sign in again while their account is enabled.</p>
    ${sessions.length ? `<div class="table-scroll"><table class="session-table"><caption>${sessions.length} active sessions</caption><thead><tr><th>Session</th><th>Signed in</th><th>Last browser activity</th><th>Expires</th><th>Action</th></tr></thead><tbody>${sessions.map(session =>
      `<tr><th scope="row">${session.kind === 'browser' ? 'Browser' : 'CLI'}${session.current ? ' (This browser)' : ''}<small> ${escape(session.id)}</small></th><td>${timestamp(session.createdAt)}</td><td>${timestamp(session.lastSeenAt, 'Not tracked for CLI')}</td><td>${timestamp(session.expiresAt)}</td><td>${apiForm(csrf, path + '/' + encodeURIComponent(session.id) + '/revoke', 'POST', 'Revoke session', '',
        `Revoke this ${session.kind === 'browser' ? 'browser session' : 'CLI session and all its access and refresh tokens'}?${session.current ? ' This signs you out now.' : ''}`)}</td></tr>`).join('')}</tbody></table></div>
      ${apiForm(csrf, path + '/revoke', 'POST', 'Sign out everywhere', '', `Sign out all ${sessions.length} active browser and CLI sessions now?${sessions.some(session => session.current) ? ' This includes this browser.' : ''}`)}` : '<p>No active sessions. A new session appears when this person signs in.</p>'}</section>`
}
