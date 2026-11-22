import { parseFragment, type DefaultTreeAdapterMap } from 'parse5'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'
import { ActionForm, ConfirmationTokenContext, type ActionFormProps } from '../src/views/action-form.js'

const render = (props: Partial<ActionFormProps>) => renderToString(createElement(ConfirmationTokenContext, { value: { issued: {} } },
  createElement(ActionForm, { action: '/v1/admin/tokens/revoke-all', method: 'POST', csrf: 'synthetic-csrf', children: [
    createElement('input', { key: 'name', name: 'name' }),
    createElement('button', { key: 'save', type: 'submit' }, 'Save'),
  ], ...props })))

type Element = DefaultTreeAdapterMap['element']
const elements = (node: DefaultTreeAdapterMap['node']): Element[] => [...'tagName' in node ? [node] : [], ...'childNodes' in node ? node.childNodes.flatMap(elements) : []]

function isDisabled(control: Element): boolean {
  if (control.attrs.some(attr => attr.name === 'disabled')) return true
  for (let child = control; child.parentNode && 'tagName' in child.parentNode; child = child.parentNode) {
    const parent = child.parentNode
    if (parent.tagName === 'fieldset' && parent.attrs.some(attr => attr.name === 'disabled')
      && parent.childNodes.find(node => 'tagName' in node && node.tagName === 'legend') !== child) return true
  }
  return false
}

test.each([
  { name: 'an unregistered route with a confirmation', props: { action: '/v1/admin/roles', confirmation: { consequence: 'Create?' } } },
  { name: 'a registered route without a confirmation', props: { action: '/v1/admin/tokens/revoke-all' } },
  { name: 'a registered tier 2 route that asks for a typed name', props: { confirmation: { consequence: 'Revoke?', typedName: 'all' } } },
  { name: 'a registered tier 3 route that asks for no typed name', props: { action: '/v1/admin/users/synthetic-user/archive', confirmation: { consequence: 'Archive?' } } },
])('a form cannot render with $name', ({ props }) => {
  expect(() => render(props as Partial<ActionFormProps>)).toThrow('disagree with the confirmation routes')
})

test.each([
  { name: 'an unconfirmed API route', props: { action: '/v1/admin/roles' }, inert: true },
  { name: 'a confirmed route with no native confirmation page', props: { action: '/v1/admin/token-settings', method: 'PATCH', confirmation: { consequence: 'Save?' } }, inert: true },
  { name: 'a confirmed route with a native confirmation page', props: { confirmation: { consequence: 'Revoke?' } }, inert: false },
  { name: 'a route that carries fields to its native confirmation page', props: { action: '/v1/admin/sso/role-rules', confirmation: { consequence: 'Add?' } }, inert: false },
])('before hydration a form for $name is inert: $inert', ({ props, inert }) => {
  const rendered = elements(parseFragment(render(props as Partial<ActionFormProps>)))
  const input = rendered.find(node => node.tagName === 'input' && node.attrs.some(attr => attr.name === 'name' && attr.value === 'name'))!
  const submit = rendered.find(node => node.tagName === 'button' && node.attrs.some(attr => attr.name === 'type' && attr.value === 'submit'))!
  expect([isDisabled(input), isDisabled(submit)]).toEqual([inert, inert])
})
