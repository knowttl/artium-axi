import type { FastifyReply } from 'fastify'
import { renderToString } from 'react-dom/server'
import type { ConfirmationTokens } from '../../views/action-form.js'
import type { AuthBlock } from '../../views/auth.js'
import type { FrameAction, FrameProps } from '../../views/frame.js'
import { Root, type ViewName, type ViewProps } from '../../views/root.js'
import { browserDocument, browserViewer } from '../auth/browser.js'
import { browserReauthRemainingMs, type BrowserSession } from '../auth/sessions.js'
import { adminChrome, authOverlays, product } from './design/ui.js'
import { mintConfirmation } from './confirmation-token.js'
import { pageHelp } from './forms.js'
import { hoistInlineStyles } from './inline-styles.js'
import { readThemeMode, themeSwitch } from './theme-mode.js'

function respond<Name extends ViewName>(reply: FastifyReply, title: string, name: Name, props: ViewProps[Name], frame: FrameProps | undefined,
  overlays: string, current?: BrowserSession, notifiesOpener?: true) {
  const mode = readThemeMode(reply.request)
  const confirmations: ConfirmationTokens = { issued: {}, mint: current && ((method, path, name) => mintConfirmation(current.id, method, path, name)) }
  const { html, style } = hoistInlineStyles(renderToString(<Root name={name} props={props} frame={frame} mode={mode} confirmations={confirmations} />), reply.styleNonce)
  const data = JSON.stringify({ frame, props, confirmations: confirmations.issued }).replace(/</g, '\\u003c')
  const body = `<div data-astryx-root data-view="${name}" data-mode="${mode}">${html}</div><script type="application/json" data-astryx-props>${data}</script>${overlays}`
  const completion = notifiesOpener ? '<script src="/admin/assets/reauth-complete.js"></script>' : ''
  const head = `${completion}${style}<script defer src="/admin/assets/hydrate.js"></script>`
  return browserDocument(reply, title, body, current, head)
}

export function renderPage<Name extends ViewName>(reply: FastifyReply, title: string, name: Name, props: ViewProps[Name],
  current: BrowserSession, description?: string, actions?: FrameAction[], heading?: string, parent?: { href: string, label: string }, helpTopic = title) {
  const mode = readThemeMode(reply.request)
  const viewer = browserViewer(reply, current)
  const { crumbs, brand, navigation, account, topbarEnd, overlays } = adminChrome({ title, heading, parent, description, content: '', help: pageHelp(helpTopic, current.source),
    path: reply.request.url.split('?')[0]!, viewer, themeSwitch: '' })
  const frame = { title: heading ?? title, description, actions, crumbs, brand: { ...brand, href: current.administrator ? brand.href : '/account' }, navigation: current.administrator ? navigation : [], account, reauth: { remainingMs: browserReauthRemainingMs(current), sso: viewer.sso }, controls: themeSwitch(reply, mode), topbarEnd }
  return respond(reply, title, name, props, frame, overlays, current)
}

export interface AuthPage {
  title: string
  description?: string
  mark?: { icon: string, tone: 'ok' | 'warn' | 'neutral' }
  blocks: AuthBlock[]
  footnote?: string
  helpTopic?: string
  notifiesOpener?: true
}

export function renderAuthPage(reply: FastifyReply, { title, description, mark, blocks, footnote, helpTopic, notifiesOpener }: AuthPage, current?: BrowserSession) {
  const viewer = current && browserViewer(reply, current)
  const home = !viewer ? '/login' : viewer.mustChange ? '/password' : viewer.administrator ? '/admin' : '/account'
  const switchable = reply.request.method === 'GET' && !reply.request.url.startsWith('/auth/sso/')
  return respond(reply, title, 'auth', { title, description, mark, blocks, footnote, brand: { name: product.name, href: home },
    signedIn: viewer && { name: viewer.name, csrf: viewer.csrf, sso: viewer.sso }, help: pageHelp(helpTopic ?? title, current?.source),
    themeSwitch: switchable ? themeSwitch(reply, readThemeMode(reply.request)) : '' }, undefined, authOverlays, current, notifiesOpener)
}
