import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import { errorResponseSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { escape } from './escape.js'

export async function adminRead<T>(app: FastifyInstance, request: FastifyRequest, url: string, schema: z.ZodType<T>): Promise<T> {
  const response = await app.inject({ method: 'GET', url, headers: { cookie: request.headers.cookie ?? '' } })
  if (response.statusCode >= 400) {
    const { error } = errorResponseSchema.parse(response.json())
    throw new ArtiumError(error.code, error.message, error.next)
  }
  return schema.parse(response.json())
}

export function adminNav(current: string): string {
  return `<nav aria-label="Administration">${[['/admin', 'Users'], ['/admin/tools', 'Tools'], ['/admin/credentials', 'Credentials'], ['/admin/roles', 'Roles'], ['/admin/audit', 'Audit']].map(([path, label]) =>
    `<a href="${path}"${label === current ? ' aria-current="page"' : ''}>${label}</a>`).join('')}<a href="/account"${current === 'Account' ? ' aria-current="page"' : ''}>Account</a></nav>`
}

export function pageHelp(title: string): string {
  const help: Record<string, string> = {
    Users: '<p>Search usernames or display names, then filter by sign-in source, status or role. Open a username to edit its profile, roles and sign-in controls. Create a local account with a temporary password and share it securely. The person must change it before using tools.</p><p>Administrator capability allows managing all users, roles and credentials; tool access still comes from roles. Direct means an administrator assigned the role. Effective tools combine all assigned roles; disabled users or tools cannot run calls.</p><p>Disable blocks sign-in and revokes all browser and CLI sessions immediately. Enable permits sign-in again. Sign out everywhere revokes sessions but allows a new sign-in. Archive hides a user from this table and permanently disables sign-in here, retaining history and role membership. Unlock clears failed sign-in attempts. Reset password revokes all sessions and requires a password change. Assign roles replaces the entire selection and applies to the next tool call.</p>',
    Roles: '<p>Create a role, open its name, select its tools and assign the role on a user detail page. Tool grants apply on the next call, including calls using existing tokens. Renaming a role keeps its members and grants. Saving grants replaces the entire selection.</p><p>Members lists everyone assigned this role, including disabled users. Direct means an administrator assigned it. A role can be deleted only after removing it from every member; deletion also removes its tool grants.</p>',
    Tools: '<p>Set a credential on Credentials, test it, enable the tool here, then grant it to a role on Roles and assign that role on Users.</p><p>Native settings replace the entire object; {} clears it. Settings that permit writes control what the native tool may change. Disabling a tool blocks new calls. Unknown health means no current check; error means the last check failed. Saving settings clears cached health.</p>',
    Credentials: '<p>Enter a complete replacement, including every native setting to retain. Omitted settings are cleared. Stored secrets are never displayed. Secret fields take the secret itself; object and array fields take JSON. The profile schema explains conditional requirements.</p><p>Test credential runs one fixed harmless read: Falcon auth status, Vectra health list, Azure account list, or Graph entra user list --limit 1. It does not enable the tool or grant access. Saving clears cached health; test again before enabling.</p>',
    Audit: '<p>Filter by user, tool, exact outcome or an inclusive UTC time range, such as 2026-01-01T00:00:00Z. Empty filters match all records. Next page keeps the filters; First page includes newly recorded events.</p><p>Sign-in and reauth record authentication; admin-change records configuration changes; run-start and run-terminal record tool calls. Success and completed indicate success; other outcomes are error codes. Read means no write journal activity, write means a mutation intent was recorded, and unknown means the evidence is incomplete. Write does not guarantee a remote change succeeded.</p>',
    Account: '<p>Your tools lists the grants from your roles, including tools that are disabled. The CLI instructions use this server and your local username. Revoke ends one session; Sign out everywhere ends every browser and CLI session, including this browser. You can sign in again.</p><p>Use Change password to replace your local password and sign out all sessions. Sign out in the header ends only this browser session. Ask an administrator to change your role or tool access.</p>',
    'Sign in': '<p>Use the local username and password supplied by your administrator. A temporary password must be changed before continuing. If sign-in is locked, wait 15 minutes or ask an administrator to unlock the account.</p>',
    'Change password': '<p>Use 15 to 128 Unicode characters, at most 512 UTF-8 bytes, and avoid common passwords. A temporary password can be replaced without entering it again. Otherwise enter your current password when confirmation is older than 15 minutes. Changing a password signs out all browser and CLI sessions.</p>',
    'Confirm password': '<p>Password confirmation allows administration changes for 15 minutes. On admin forms, confirmation opens in a dialog and resumes the pending action. Cancel keeps the draft without making the change.</p>',
    'Request failed': '<p>Follow the recovery step below. If another administrator changed the record, reload its page and review the latest values before submitting again.</p>',
  }
  return `<details class="page-help"><summary>Help with ${escape(title.toLowerCase())}</summary>${help[title] ?? '<p>Use the navigation to return to your account or an administration screen.</p>'}</details>`
}

export function apiForm(csrf: string, action: string, method: string, label: string, fields: string, confirmation = '', attributes = ''): string {
  return `<form data-api data-method="${escape(method)}" data-confirm="${escape(confirmation)}" ${attributes} action="${escape(action)}" method="post"><input type="hidden" name="_csrf" value="${escape(csrf)}">${fields}<button>${escape(label)}</button>${confirmation ? `<details class="action-help"><summary>What does this do?</summary><p>${escape(confirmation)}</p></details>` : ''}</form>`
}

export function revision(value: number): string {
  return `<input type="hidden" name="expectedRevision" data-type="number" value="${escape(value)}">`
}

export function timestamp(value: number | null, empty = 'Not recorded'): string {
  if (value === null) return escape(empty)
  const iso = new Date(value).toISOString()
  return `<time datetime="${iso}" title="${iso}">${iso}</time>`
}

export function changed(db: Database.Database, item: { updatedBy: string | null, updatedAt: number | null, revision: number }): string {
  const actor = item.updatedBy ? (db.prepare('SELECT username FROM users WHERE id = ?').get(item.updatedBy) as { username: string } | undefined)?.username ?? item.updatedBy : 'System'
  return `<p><small>Last changed by ${escape(actor)} at ${timestamp(item.updatedAt)}. Revision ${escape(item.revision)}.</small></p>`
}
