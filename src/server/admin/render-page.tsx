import type { FastifyReply } from 'fastify'
import { renderToString } from 'react-dom/server'
import { Root, type ViewName, type ViewProps } from '../../views/root.js'
import { browserPage } from '../auth/browser.js'
import type { BrowserSession } from '../auth/sessions.js'
import { hoistInlineStyles } from './inline-styles.js'
import { readThemeMode } from './theme-mode.js'

export function renderPage<Name extends ViewName>(reply: FastifyReply, title: string, name: Name, props: ViewProps[Name],
  current?: BrowserSession, description?: string) {
  const mode = readThemeMode(reply.request)
  const { html, style } = hoistInlineStyles(renderToString(<Root name={name} props={props} mode={mode} />), reply.styleNonce)
  const data = JSON.stringify(props).replace(/</g, '\\u003c')
  const content = `<div data-astryx-root data-view="${name}" data-mode="${mode}">${html}</div><script type="application/json" data-astryx-props>${data}</script>`
  const head = `${style}<script defer src="/admin/assets/hydrate.js"></script>`
  return browserPage(reply, title, content, current, description, { head })
}
