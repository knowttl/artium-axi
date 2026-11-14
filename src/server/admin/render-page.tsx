import type { FastifyReply } from 'fastify'
import { renderToString } from 'react-dom/server'
import { Root, type ViewName, type ViewProps } from '../../views/root.js'
import { browserPage } from '../auth/browser.js'
import type { BrowserSession } from '../auth/sessions.js'
import { hoistInlineStyles } from './inline-styles.js'

export function renderPage<Name extends ViewName>(reply: FastifyReply, title: string, name: Name, props: ViewProps[Name],
  current?: BrowserSession, description?: string) {
  const { html, style } = hoistInlineStyles(renderToString(<Root name={name} props={props} />), reply.styleNonce)
  const data = JSON.stringify(props).replace(/</g, '\\u003c')
  const content = `<div data-astryx-root data-view="${name}">${html}</div><script type="application/json" data-astryx-props>${data}</script>`
  const head = `<link rel="stylesheet" href="/admin/assets/astryx.css">${style}<script defer src="/admin/assets/hydrate.js"></script>`
  return browserPage(reply, title, content, current, description, { head })
}
