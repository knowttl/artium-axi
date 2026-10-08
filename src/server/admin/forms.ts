import type Database from 'better-sqlite3'
import { escape } from './escape.js'

export function adminNav(current: string): string {
  return `<nav aria-label="Administration">${[['/admin', 'Users'], ['/admin/tools', 'Tools'], ['/admin/credentials', 'Credentials'], ['/admin/roles', 'Roles'], ['/admin/audit', 'Audit']].map(([path, label]) =>
    `<a href="${path}"${label === current ? ' aria-current="page"' : ''}>${label}</a>`).join('')}<a href="/password">Change password</a><a href="/reauth">Confirm password</a></nav>`
}

export function apiForm(csrf: string, action: string, method: string, label: string, fields: string, confirmation = '', attributes = ''): string {
  return `<form data-api data-method="${escape(method)}" data-confirm="${escape(confirmation)}" ${attributes} action="${escape(action)}" method="post"><input type="hidden" name="_csrf" value="${escape(csrf)}">${fields}<button>${escape(label)}</button></form>`
}

export function revision(value: number): string {
  return `<input type="hidden" name="expectedRevision" data-type="number" value="${escape(value)}">`
}

export function changed(db: Database.Database, item: { updatedBy: string | null, updatedAt: number | null, revision: number }): string {
  const actor = item.updatedBy ? (db.prepare('SELECT username FROM users WHERE id = ?').get(item.updatedBy) as { username: string } | undefined)?.username ?? item.updatedBy : 'System'
  return `<p><small>Last changed by ${escape(actor)} at ${escape(item.updatedAt === null ? 'Not recorded' : new Date(item.updatedAt).toISOString())}. Revision ${escape(item.revision)}.</small></p>`
}
