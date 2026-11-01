import { escape } from '../escape.js'

// Every icon comes from this sprite: 24px grid, 1.75 stroke, currentColor.
const icons = {
  home: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.6c1.8.7 3 2.6 3.5 5.4"/>',
  shield: '<path d="M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  unlock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 7.7-1.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  alert: '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.5h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5h.01"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  chevd: '<path d="m6 9 6 6 6-6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M4 20h16"/>',
  test: '<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v4.5h-4.5"/>',
  book: '<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z"/><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  cert: '<circle cx="12" cy="9" r="5"/><path d="m8.5 13-1.5 8 5-3 5 3-1.5-8"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 16l-4-4 4-4M6 12h10"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
} as const
export type IconName = keyof typeof icons

const sprite = `<svg class="sprite" aria-hidden="true">${Object.entries(icons).map(([name, paths]) =>
  `<symbol id="i-${name}" viewBox="0 0 24 24">${paths}</symbol>`).join('')}</svg>`

export function icon(name: IconName): string {
  return `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`
}

// `actions` is trusted markup placed beside the title, such as buttons or an inline editor.
export function pageHeader(title: string, description?: string, actions = ''): string {
  return `<div class="page-head"><div><h1>${escape(title)}</h1>${description ? `<p>${escape(description)}</p>` : ''}</div>${actions}</div>`
}

export function card(title: string, description: string, body: string): string {
  return `<section class="card"><div class="card-head"><div><h2>${escape(title)}</h2><p>${escape(description)}</p></div></div>${body}</section>`
}

// A list footer: a summary on the left and cursor links on the right; a null href is the current end.
export function pager(summary: string, links: { label: string, href: string | null }[]): string {
  return `<div class="card-foot"><span>${escape(summary)}</span><nav class="actions" aria-label="Pages">${links.map(link => link.href === null
    ? `<span class="btn btn-secondary btn-sm" aria-disabled="true">${escape(link.label)}</span>`
    : `<a class="btn btn-secondary btn-sm" href="${escape(link.href)}">${escape(link.label)}</a>`).join('')}</nav></div>`
}

export interface Viewer {
  name: string
  // Plain sign-in method words from the status vocabulary: Password, SSO or Break-glass.
  method: string
  administrator: boolean
  mustChange: boolean
  sso: boolean
  local: boolean
  csrf: string
  // Epoch milliseconds when recent identity confirmation expires; 0 when it has.
  reauthUntil: number
}

export interface Page {
  title: string
  // A detail page names its record in the h1 and crumbs while `title` keeps naming the screen.
  heading?: string
  actions?: string
  description?: string
  content: string
  help: string
  path: string
  viewer?: Viewer
}

const navigation: { group?: string, href: string, label: string, icon: IconName }[] = [
  { href: '/admin', label: 'Overview', icon: 'home' },
  { group: 'Access', href: '/admin/users', label: 'People', icon: 'users' },
  { group: 'Access', href: '/admin/roles', label: 'Roles', icon: 'shield' },
  { group: 'Access', href: '/admin/invitations', label: 'Invitations', icon: 'mail' },
  { group: 'Tools', href: '/admin/tools', label: 'Tools', icon: 'box' },
  { group: 'Security', href: '/admin/settings/sign-in', label: 'Sign-in & SSO', icon: 'key' },
  { group: 'Security', href: '/admin/audit', label: 'Audit log', icon: 'list' },
]

const brand = (href: string) => `<a class="brand" href="${href}"><span class="logo" aria-hidden="true">A</span>Artium</a>`

// Initials are decorative; the name is always adjacent text.
export function avatar(name: string): string {
  const words = name.trim().split(/\s+/)
  const initials = (words.length > 1 ? words[0]![0]! + words[1]![0]! : name.trim().slice(0, 2)).toUpperCase()
  return `<span class="avatar" aria-hidden="true">${escape(initials)}</span>`
}

function accountMenu(viewer: Viewer, path: string, placement: 'up' | 'down'): string {
  const role = viewer.administrator && !viewer.mustChange ? ' · Admin' : ''
  const links = viewer.mustChange ? '' : `<a href="/account"${path === '/account' ? ' aria-current="page"' : ''}>${icon('user')}Your account</a>${viewer.local ? `<a href="/password"${path === '/password' ? ' aria-current="page"' : ''}>${icon('key')}Change password</a>` : ''}<hr>`
  return `<details class="account-menu ${placement}"><summary>${avatar(viewer.name)}<span class="who"><span class="sr-only">Signed in as </span><strong>${escape(viewer.name)}</strong><span>${escape(viewer.method + role)}</span></span>${icon('chevd')}</summary>
    <div class="popover">${links}<form method="post" action="/logout"><input type="hidden" name="_csrf" value="${escape(viewer.csrf)}">${viewer.sso ? '<label class="check"><input type="checkbox" name="providerLogout" value="true"> Also sign out of your identity provider</label>' : ''}<button class="btn btn-ghost btn-sm">${icon('logout')}Sign out</button></form></div></details>`
}

function learn(title: string, help: string): string {
  return `<details class="page-help learn"><summary class="btn btn-ghost btn-sm" aria-label="Learn">${icon('book')}<span class="label">Learn</span></summary><div class="learn-panel"><h2>Help with ${escape(title.toLowerCase())}</h2>${help}</div></details>`
}

// confirm.js repeats this wording when it refreshes the pill every 30 seconds.
function reauthText(until: number): string {
  const minutes = Math.max(0, Math.ceil((until - Date.now()) / 60_000))
  return minutes ? `Changes unlocked · ${minutes} min` : 'Changes locked'
}

function reauthPill(viewer: Viewer): string {
  const on = viewer.reauthUntil > Date.now()
  return `<span class="unlock ${on ? 'on' : 'off'}" data-reauth-until="${viewer.reauthUntil}" data-reauth-method="${viewer.sso ? 'sso' : 'local'}" title="Changes need an identity confirmation in the last 15 minutes. You are asked to confirm when you save.">${icon(on ? 'unlock' : 'lock')}<span data-reauth-text>${reauthText(viewer.reauthUntil)}</span></span>`
}

function dialogs(viewer: Viewer): string {
  const confirmation = `<dialog id="confirmation" class="modal" aria-labelledby="confirmation-title"><form method="dialog"><div class="modal-body"><h2 id="confirmation-title">Confirm change</h2><p data-consequence></p><label data-confirm-name-field hidden>Type <strong data-confirm-name></strong> to confirm<input data-confirm-name-input autocomplete="off" spellcheck="false"></label></div><div class="modal-foot"><button class="btn btn-secondary" value="cancel" autofocus>Cancel</button><button class="btn btn-primary" value="confirmed" data-confirm-button>Confirm change</button></div></form></dialog>`
  if (!viewer.administrator || viewer.mustChange) return confirmation
  return confirmation + `<dialog id="reauth-dialog" class="modal" aria-labelledby="reauth-title"><div class="modal-body"><h2 id="reauth-title">${viewer.sso ? 'Confirm identity' : 'Confirm password'}</h2><p>${viewer.sso ? 'Confirm your identity with your provider in a new window' : 'Confirm your password'} to continue the pending action. Changes are allowed for 15 minutes. Cancel keeps your draft.</p></div><form data-reauth>${viewer.sso ? '' : '<div class="modal-body"><label>Password <input name="password" type="password" autocomplete="current-password" required></label></div>'}<p class="modal-error" data-reauth-error role="alert"></p><div class="modal-foot"><button class="btn btn-secondary" type="button" data-reauth-cancel>Cancel</button><button class="btn btn-primary">Confirm and continue</button></div></form></dialog>`
}

const message = '<p id="message" class="message" role="alert" tabindex="-1"></p>'
// Tier-1 results: confirm.js shows the saved action's message here after the page reloads.
const toast = '<p class="toast" role="status" data-toast></p>'

export function appShell(page: Page): string {
  const { viewer } = page
  const head = pageHeader(page.heading ?? page.title, page.description, page.actions)
  if (!viewer) {
    return `<a class="skip" href="#main">Skip to content</a><main id="main" class="auth"><div class="auth-wrap"><div class="auth-card">${brand('/login')}${head}${message}${page.content}</div>
      <details class="page-help auth-help"><summary>Help with ${escape(page.title.toLowerCase())}</summary>${page.help}</details></div></main>`
  }
  if (!viewer.administrator || viewer.mustChange) {
    return `<a class="skip" href="#main">Skip to content</a><div class="app plain"><header class="topbar">${brand(viewer.mustChange ? '/password' : '/account')}<div class="right">${learn(page.title, page.help)}${accountMenu(viewer, page.path, 'down')}</div></header>
      <main id="main" class="content narrow" tabindex="-1">${head}${message}${page.content}</main></div>${dialogs(viewer)}${sprite}`
  }
  const active = navigation.find(item => item.href === '/admin' ? page.path === '/admin' : page.path === item.href || page.path.startsWith(item.href + '/'))
  let group: string | undefined
  const items = navigation.map(item => {
    const label = item.group !== group ? `<p class="nav-label">${escape(item.group!)}</p>` : ''
    group = item.group
    return `${label}<a class="nav-item" href="${item.href}"${item === active ? ' aria-current="page"' : ''}>${icon(item.icon)}${escape(item.label)}</a>`
  }).join('')
  const parent = page.heading && active ? `<a href="${active.href}">${escape(active.label)}</a>` : active?.group && active.group !== page.title ? `<span>${escape(active.group)}</span>` : ''
  const crumbs = `<p class="crumbs">${parent ? `${parent}<span class="sep" aria-hidden="true">/</span>` : ''}<strong>${escape(page.heading ?? page.title)}</strong></p>`
  return `<a class="skip" href="#main">Skip to content</a><div class="app">
    <div class="side" id="nav"><div class="side-head">${brand('/admin')}<a class="btn btn-ghost btn-icon btn-sm side-close" href="#main" aria-label="Close navigation">${icon('x')}</a></div>
      <nav aria-label="Administration">${items}</nav><div class="side-foot">${accountMenu(viewer, page.path, 'up')}</div></div>
    <div class="main"><header class="topbar"><a class="btn btn-ghost btn-icon btn-sm menu-open" href="#nav" aria-label="Open navigation">${icon('list')}</a>${crumbs}<div class="right">${reauthPill(viewer)}${learn(page.title, page.help)}</div></header>
      <main id="main" class="content" tabindex="-1">${head}${message}${page.content}</main></div></div>${toast}${dialogs(viewer)}${sprite}`
}
