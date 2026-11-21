import type { ThemeMode } from '@astryxdesign/core/theme'
import { useEffect, type ReactNode } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { captureCredentialTextareaDrafts } from '../views/credential-editor.js'
import type { FrameProps } from '../views/frame.js'
import { Root, type ViewName, type ViewProps } from '../views/root.js'

function Hydrated({ children }: { children: ReactNode }) {
  useEffect(() => { document.dispatchEvent(new Event('astryx-hydrated')) }, [])
  return children
}

const root = document.querySelector<HTMLElement>('[data-astryx-root]')
const props = document.querySelector('[data-astryx-props]')
if (root && props) {
  const hoisted = [...document.styleSheets].flatMap(sheet => [...sheet.cssRules])
    .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && rule.selectorText.startsWith('[data-inline-style='))
  for (const rule of hoisted) {
    for (const element of root.querySelectorAll<HTMLElement>(rule.selectorText)) {
      for (const property of rule.style) {
        element.style.setProperty(property, rule.style.getPropertyValue(property), rule.style.getPropertyPriority(property))
      }
      element.removeAttribute('data-inline-style')
    }
  }
  const { frame, props: viewProps, confirmations } = JSON.parse(props.textContent!) as { frame?: FrameProps, props: ViewProps[ViewName], confirmations: Record<string, string> }
  captureCredentialTextareaDrafts(root)
  hydrateRoot(root, <Hydrated><Root name={root.dataset.view as ViewName} props={viewProps} frame={frame} mode={root.dataset.mode as ThemeMode} confirmations={{ issued: confirmations }} /></Hydrated>)
}
