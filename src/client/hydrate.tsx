import { hydrateRoot } from 'react-dom/client'
import { Root, type ViewName, type ViewProps } from '../views/root.js'

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
  hydrateRoot(root, <Root name={root.dataset.view as ViewName} props={JSON.parse(props.textContent!) as ViewProps[ViewName]} />)
}
