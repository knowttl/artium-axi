import type { FastifyReply } from 'fastify'
import { renderToString } from 'react-dom/server'
import { Root, type ViewName, type ViewProps } from '../../views/root.js'
import { browserDocument, browserViewer } from '../auth/browser.js'
import type { BrowserSession } from '../auth/sessions.js'
import { adminChrome } from './design/ui.js'
import { pageHelp } from './forms.js'
import { hoistInlineStyles } from './inline-styles.js'
import { readThemeMode, themeSwitch } from './theme-mode.js'

export function renderPage<Name extends ViewName>(reply: FastifyReply, title: string, name: Name, props: ViewProps[Name],
  current: BrowserSession, description?: string) {
  const mode = readThemeMode(reply.request)
  const { crumbs, brand, navigation, mobileNavigation, topbarEnd, overlays } = adminChrome({ title, description, content: '', help: pageHelp(title, current.source),
    path: reply.request.url.split('?')[0]!, viewer: browserViewer(reply, current), themeSwitch: '' })
  const frame = { title, description, crumbs, brand, navigation, mobileNavigation, topbarEnd: topbarEnd + themeSwitch(reply, mode) }
  const { html, style } = hoistInlineStyles(renderToString(<Root name={name} props={props} frame={frame} mode={mode} />), reply.styleNonce)
  const data = JSON.stringify({ frame, props }).replace(/</g, '\\u003c')
  const body = `<div data-astryx-root data-view="${name}" data-mode="${mode}">${html}</div><script type="application/json" data-astryx-props>${data}</script>${overlays}`
  const head = `${style}<script defer src="/admin/assets/hydrate.js"></script>`
  return browserDocument(reply, title, body, current, head)
}
