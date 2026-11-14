const tagPattern = /<([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\s*\/?)>/g
const attributePattern = /[\s/]*([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
const propertyPattern = /^--[\w-]+$/
const valuePattern = /^[\w\s.,%()+*/-]*$/
const allowedFunctions = new Set(['calc', 'var', 'min', 'max', 'clamp', 'translate', 'translatex', 'translatey', 'translate3d', 'scale', 'rotate'])
const unsafe = () => new Error('Inline style cannot be moved into the nonce-protected style element')

function balanced(value: string) {
  let depth = 0
  for (const character of value) {
    if (character === '(') depth++
    if (character === ')' && --depth < 0) return false
  }
  return depth === 0
}

function declarations(text: string) {
  return text.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const separator = part.indexOf(':')
    const property = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    const functions = [...value.matchAll(/([\w-]+)\s*\(/g)].map(match => match[1]!.toLowerCase())
    const gridColumns = property === '--x-gridTemplateColumns' && value === 'repeat(auto-fit, minmax(220px, 1fr))'
    if (separator < 1 || !propertyPattern.test(property) || !valuePattern.test(value) || !balanced(value) || /\/\*|\*\//.test(value) ||
      !gridColumns && functions.some(name => !allowedFunctions.has(name))) throw unsafe()
    return `${property}:${value}`
  }).join(';')
}

export function hoistInlineStyles(html: string, nonce: string): { html: string, style: string } {
  const rules = new Map<string, number>()
  const hoisted = html.replace(tagPattern, (tag, name: string, attributes: string, end: string) => {
    let id: number | undefined
    const names: string[] = []
    const kept = attributes.replace(attributePattern, (attribute, attributeName: string, double?: string, single?: string, bare?: string) => {
      names.push(attributeName.toLowerCase())
      if (names.at(-1) !== 'style') return attribute
      const text = declarations(double ?? single ?? bare ?? '')
      if (text) {
        if (!rules.has(text)) rules.set(text, rules.size + 1)
        id = rules.get(text)
      }
      return ''
    })
    if (names.filter(attributeName => attributeName === 'style').length > 1 || names.includes('data-inline-style') ||
      /(?<![\w-])style\s*=/i.test(kept.replace(/"[^"]*"|'[^']*'/g, ''))) throw unsafe()
    return id === undefined && kept === attributes ? tag : `<${name}${kept}${id === undefined ? '' : ` data-inline-style="${id}"`}${end}>`
  })
  const css = [...rules].map(([text, id]) => `[data-inline-style="${id}"]{${text}}`).join('')
  return { html: hoisted, style: css ? `<style nonce="${nonce}">${css}</style>` : '' }
}
