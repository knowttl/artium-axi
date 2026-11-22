import type { FrameProps, NavigationLink, NavigationSection } from '../../views/frame.js'
import type { IconName } from '../../views/icon.js'

export interface PageHeader {
  // A detail page names its record in the h1 and crumbs while `title` keeps naming the screen.
  heading?: string
  description?: string
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
}

export interface Page extends PageHeader {
  // Detail pages show their parent page in the breadcrumb.
  parent?: { href: string, label: string }
  title: string
  content: string
  help: string[]
  path: string
  viewer: Viewer
}

const navigation: { group?: string, href: string, label: string, icon: IconName }[] = [
  { href: '/admin', label: 'Overview', icon: 'home' },
  { group: 'Access', href: '/admin/users', label: 'People', icon: 'users' },
  { group: 'Access', href: '/admin/roles', label: 'Roles', icon: 'shield' },
  { group: 'Access', href: '/admin/invitations', label: 'Invitations', icon: 'mail' },
  { group: 'Tools', href: '/admin/tools', label: 'Tools', icon: 'box' },
  { group: 'Security', href: '/admin/settings/sign-in', label: 'Sign-in & SSO', icon: 'key' },
  { group: 'Security', href: '/admin/tokens', label: 'Access tokens', icon: 'key' },
  { group: 'Security', href: '/admin/audit', label: 'Audit log', icon: 'list' },
]

export const product = { name: 'Artium', href: '/admin' }


// Initials are decorative; the name is always adjacent text.
export function initials(name: string): string {
  const words = name.trim().split(/\s+/)
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : name.trim().slice(0, 2)).toUpperCase()
}

export type AdminChrome = Pick<FrameProps, 'crumbs' | 'brand' | 'navigation' | 'account' | 'help'>

export function adminChrome(page: Page): AdminChrome {
  const { viewer } = page
  const active = navigation.find(item => item.href === '/admin' ? page.path === '/admin' : page.path === item.href || page.path.startsWith(item.href + '/'))
  const sections: NavigationSection[] = []
  for (const item of navigation) {
    const link = { href: item.href, label: item.label, icon: item.icon, current: item === active }
    const last = sections.at(-1)
    if (last && last.title === item.group) last.links.push(link)
    else sections.push({ title: item.group, links: [link] })
  }
  const role = viewer.administrator && !viewer.mustChange ? ' · Admin' : ''
  const accountLinks: NavigationLink[] = viewer.mustChange ? [] : [
    { href: '/account', label: 'Your account', icon: 'user', current: page.path === '/account' },
    ...viewer.local ? [{ href: '/password', label: 'Change password', icon: 'key' as const, current: page.path === '/password' }] : [],
  ]
  const parent = page.parent ?? (page.heading && active ? { href: active.href, label: active.label } : active?.group && active.group !== page.title ? { label: active.group } : undefined)
  return {
    crumbs: [...parent ? [parent] : [], { label: page.heading ?? page.title }],
    brand: product,
    navigation: sections,
    account: { name: viewer.name, initials: initials(viewer.name), method: viewer.method + role, links: accountLinks, csrf: viewer.csrf },
    help: { title: page.title, paragraphs: page.help },
  }
}
