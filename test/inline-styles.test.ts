import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'
import { Grid } from '@astryxdesign/core/Grid'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { hoistInlineStyles } from '../src/server/admin/inline-styles.js'

const nonce = 'AAAAAAAAAAAAAAAAAAAAAA=='

test.each([
  ['a style attribute becomes a nonce-protected rule',
    '<div class="card" style="--x-maxWidth:480px">Text</div>',
    '<div class="card" data-inline-style="1">Text</div>', '[data-inline-style="1"]{--x-maxWidth:480px}'],
  ['elements with equal declarations share one rule',
    '<p style="--x-width:10px"></p><p style="--x-width:10px"></p>',
    '<p data-inline-style="1"></p><p data-inline-style="1"></p>', '[data-inline-style="1"]{--x-width:10px}'],
  ['different declarations get separate rules in document order',
    '<p style="--x-a:1px"></p><p style="--x-b:2px; --x-c:calc(100% - 4px)"></p>',
    '<p data-inline-style="1"></p><p data-inline-style="2"></p>', '[data-inline-style="1"]{--x-a:1px}[data-inline-style="2"]{--x-b:2px;--x-c:calc(100% - 4px)}'],
  ['single-quoted and self-closing tags are handled',
    "<img alt='a' style='--x-size:2rem'/><br/>", '<img alt=\'a\' data-inline-style="1"/><br/>', '[data-inline-style="1"]{--x-size:2rem}'],
  ['the word style inside another attribute or in text is left alone',
    '<a title=" style=&quot;--x-a:1px&quot;">style="--x-b:2px"</a>', '<a title=" style=&quot;--x-a:1px&quot;">style="--x-b:2px"</a>', ''],
  ['a style attribute with no separator before it is still hoisted',
    '<div class="a"style="--x-a:1px"></div><p/style="--x-a:1px"></p>', '<div class="a" data-inline-style="1"></div><p data-inline-style="1"></p>', '[data-inline-style="1"]{--x-a:1px}'],
  ['an empty style attribute is dropped without a rule',
    '<div style="">x</div>', '<div>x</div>', ''],
  ['markup without styles is returned unchanged', '<main><h1>Overview</h1></main>', '<main><h1>Overview</h1></main>', ''],
])('%s', (_name, input, html, css) => {
  expect(hoistInlineStyles(input, nonce)).toEqual({ html, style: css ? `<style nonce="${nonce}">${css}</style>` : '' })
})

test.each([
  ['a style element breakout', '<div style="--x-a:1px&lt;/style&gt;&lt;script&gt;"></div>'],
  ['a rule breakout', '<div style="--x-a:1px}body{display:none"></div>'],
  ['a CSS comment', '<div style="--x-a:1px/**/"></div>'],
  ['a url function', '<div style="--x-a:url(https://attacker.example/a)"></div>'],
  ['an escaped url function', '<div style="--x-a:u\\72l(a)"></div>'],
  ['an image-set function', '<div style="--x-a:image-set(a 1x)"></div>'],
  ['a colour literal in hex form', '<div style="--x-a:#fff"></div>'],
  ['a layout property that is not a custom property', '<div style="position:fixed;top:0;width:100%;height:100%"></div>'],
  ['an unclosed parenthesis that would swallow later rules', '<div style="--x-a:calc(1px"></div><p style="--x-b:2px"></p>'],
  ['a stray closing parenthesis', '<div style="--x-a:1px)"></div>'],
  ['two style attributes on one element', '<div style="--x-a:1px" style="--x-b:2px"></div>'],
  ['an element that already carries the hoisted attribute', '<div data-inline-style="9" style="--x-a:1px"></div>'],
  ['an upper-case style attribute name', '<div STYLE="position:fixed"></div>'],
  ['an at-rule', '<div style="--x-a:@import"></div>'],
  ['an important flag', '<div style="--x-a:1px!important"></div>'],
  ['a quoted string', '<div style="--x-a:&quot;x&quot;"></div>'],
  ['an unknown entity', '<div style="--x-a:&nbsp;1px"></div>'],
  ['a property that is not a CSS name', '<div style="a b:1px"></div>'],
  ['a declaration without a colon', '<div style="--x-a"></div>'],
])('rejects %s instead of emitting it', (_name, input) => {
  expect(() => hoistInlineStyles(input, nonce)).toThrow('cannot be moved')
})

test('hoists the styles of the Overview Astryx Grid', () => {
  const html = renderToString(createElement(Theme, { theme: neutralTheme, children: createElement(Grid, { columns: { minWidth: 220, repeat: 'fit' }, gap: 3, children: 'Synthetic cell' }) }))
  const hoisted = hoistInlineStyles(html, nonce)
  expect(hoisted.html).not.toMatch(/\sstyle=/)
  expect(hoisted.style).toContain('--x-gridTemplateColumns:repeat(auto-fit, minmax(220px, 1fr))')
})

test.each([
  ['a template on another property', '<div style="--x-width:repeat(auto-fit, minmax(220px, 1fr))"></div>'],
  ['a fixed column count', '<div style="--x-gridTemplateColumns:repeat(3, 1fr)"></div>'],
  ['auto-fill columns', '<div style="--x-gridTemplateColumns:repeat(auto-fill, minmax(220px, 1fr))"></div>'],
  ['a different minimum', '<div style="--x-gridTemplateColumns:repeat(auto-fit, minmax(200px, 1fr))"></div>'],
  ['capped columns with a gap', '<div style="--x-gridTemplateColumns:repeat(auto-fill, minmax(min(100%, max(200px, calc((100% - 3 * var(--spacing-0-5)) / 4))), 1fr))"></div>'],
  ['capped columns without a gap', '<div style="--x-gridTemplateColumns:repeat(auto-fit, minmax(min(100%, max(200px, calc(100% / 4))), 1fr))"></div>'],
  ['a repeat count that is not a number', '<div style="--x-gridTemplateColumns:repeat(var(--x-a), 1fr)"></div>'],
  ['a track list that carries more than the grid form', '<div style="--x-gridTemplateColumns:repeat(3, 1fr) 2px"></div>'],
  ['a repeat that wraps a disallowed function', '<div style="--x-gridTemplateColumns:repeat(auto-fill, minmax(url(a), 1fr))"></div>'],
  ['a minmax outside repeat', '<div style="--x-gridTemplateColumns:minmax(200px, 1fr)"></div>'],
  ['a spacing variable that is not a spacing token', '<div style="--x-gridTemplateColumns:repeat(auto-fill, minmax(min(100%, max(200px, calc((100% - 3 * var(--other)) / 4))), 1fr))"></div>'],
])('still rejects %s', (_name, input) => {
  expect(() => hoistInlineStyles(input, nonce)).toThrow('cannot be moved')
})
