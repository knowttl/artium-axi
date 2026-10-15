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
  return `<nav aria-label="Administration">${[['/admin', 'Users'], ['/admin/tools', 'Tools'], ['/admin/roles', 'Roles'], ['/admin/audit', 'Audit'], ['/admin/settings/sign-in', 'Sign-in settings']].map(([path, label]) =>
    `<a href="${path}"${label === current ? ' aria-current="page"' : ''}>${label}</a>`).join('')}<a href="/account"${current === 'Account' ? ' aria-current="page"' : ''}>Account</a></nav>`
}

export function pageHelp(title: string): string {
  const help: Record<string, string> = {
    Invitations: '<p>Create an invitation for a new SSO user, or open an enabled local user and choose Link to SSO to retain their account history. Select an Entra provider, enter the expected sign-in username, choose direct roles and an expiry. The username must match at claim time; it is a guard, not the permanent identity key.</p><p>Creation and Resend show a link once. Select and copy it, then send it securely yourself. Resend invalidates the old link and resets expiry; Revoke prevents claiming. Expired links can be resent. Claimed and revoked invitations cannot be resent. Actions require recent identity confirmation (Microsoft for SSO, a password for local accounts) and are audited. Claiming requires an enabled provider. Enable it in Sign-in settings after configuring credentials and testing break-glass access.</p>',
    'Sign-in settings': '<p>Add a single-tenant Entra ID provider using its directory tenant UUID, then open it to save an application credential. Certificate authentication is preferred; upload the public certificate to the application registration and paste a combined PEM certificate and private key here. A client secret is accepted with a warning.</p><p>Secrets are encrypted and never redisplayed. Leave secret fields blank to keep them for the same tenant, client and authentication method. A changed tenant removes the credential; a changed client or authentication method requires a new secret. Every settings change is audited. Providers start disabled. Use the Entra setup guide on the provider page, prepare invitations, and test a designated local break-glass administrator before enabling sign-in. Enabling any provider restricts local password use to break-glass administrators.</p><p>Role rules map exact, case-sensitive Entra app-role values in the roles claim to artium roles and their tool grants. Create roles and configure their tools on Roles first. Rules never set the administrator flag. Open a rule to edit or remove it; changes require recent identity confirmation (Microsoft for SSO, a password for local accounts) and stale edits require a reload. Sign-in synchronizes rule grants. Deleting or retargeting a rule immediately removes only that rule’s grants, including grants retained by archived users. Direct and other-rule grants remain unchanged.</p>',
    Users: '<p>Search usernames or display names, then filter by sign-in source, status or role. Open a username to edit its profile, roles and sign-in controls. Create a local account with a temporary password and share it securely. The person must change it before using tools.</p><p>Administrator capability allows managing all users, roles and credentials; tool access still comes from roles. Direct means an administrator assigned the role. Effective tools combine all assigned roles; disabled users or tools cannot run calls.</p><p>Disable blocks sign-in and revokes all browser and CLI sessions immediately. Enable permits sign-in again. Sign out everywhere revokes sessions but allows a new sign-in. Archive hides a user from this table and permanently disables sign-in here, retaining history and role membership. Unlock clears failed sign-in attempts. Reset password applies only to local accounts, revokes all sessions and requires a password change. Assign roles replaces direct grants, preserves rule grants and applies to the next tool call.</p>',
    Roles: '<p>Create a role, open its name, select its tools and assign the role on a user detail page. Tool grants apply on the next call, including calls using existing tokens. Renaming a role keeps its members and grants. Saving grants replaces the entire selection.</p><p>Members lists everyone assigned this role, including disabled users. Direct means an administrator assigned it. A role can be deleted only when it has no members, SSO rule references or invitation role references. Remove or retarget SSO rules in Sign-in settings first. Invitation history retains role references, including after expiry, revocation or claim, and prevents deletion. Deletion also removes the role’s tool grants.</p>',
    Tools: '<p>Open a tool, choose authentication and save its credential, test it, enable it, then grant it to a role and assign that role to people. Each tool page combines credentials, native settings, health and role access.</p><p>Stored secrets stay unchanged when left blank for the same identity. Changing authentication, mode, kind, tenant, client or origin requires new secrets. Certificate uploads accept one PEM file containing the certificate and matching private key; the fingerprint is calculated automatically. PEM editors preserve line breaks.</p><p>Credentials and native settings save separately, keeping the other. Native settings replace the entire object; {} clears it. Write settings control what the tool may change. Disabling blocks new calls. Unknown health means no current check; error means the last check failed. Saving clears cached health; Test after saving reports the new check inline.</p>',
    Audit: '<p>Filter by user, tool, exact event, exact outcome or an inclusive UTC time range, such as 2026-01-01T00:00:00Z. Empty filters match all records. Apply filters before downloading. Next page keeps the filters; First page includes newly recorded events. Open an event to see every persisted field; displayed times use your browser timezone, with UTC in the tooltip.</p><p>Download CSV for spreadsheets or JSON lines for processing, with one record per line. Downloads include all retained records matching the applied filters, across every page, as of the download request. Both contain the same safe persisted fields as the audit stream, including redacted arguments, never credentials, tokens or tool output. No matches produces a CSV header or an empty JSON-lines file. Retention keeps records for 90 days.</p><p>Sign-in and reauth record authentication; admin-change records configuration changes; run-start and run-terminal record tool calls. Success and completed indicate success; other outcomes are error codes. Read means no write journal activity, write means a mutation intent was recorded, and unknown means the evidence is incomplete. Write does not guarantee a remote change succeeded.</p>',
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
