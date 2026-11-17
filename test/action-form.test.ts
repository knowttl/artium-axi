import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'
import { ActionForm, ConfirmationTokenContext, type ActionFormProps, type ConfirmationTokens } from '../src/views/action-form.js'

const render = (props: Partial<ActionFormProps>, tokens: ConfirmationTokens = { issued: {} }) => renderToString(createElement(ConfirmationTokenContext, { value: tokens },
  createElement(ActionForm, { action: '/v1/admin/tokens/revoke-all', method: 'POST', csrf: 'synthetic-csrf', children: null, ...props })))

test.each([
  { name: 'an unregistered route with a confirmation', props: { action: '/v1/admin/roles', confirmation: { consequence: 'Create?' } } },
  { name: 'a registered route without a confirmation', props: { action: '/v1/admin/tokens/revoke-all' } },
  { name: 'a registered tier 2 route that asks for a typed name', props: { confirmation: { consequence: 'Revoke?', typedName: 'all' } } },
  { name: 'a registered tier 3 route that asks for no typed name', props: { action: '/v1/admin/users/synthetic-user/archive', confirmation: { consequence: 'Archive?' } } },
])('a form cannot render with $name', ({ props }) => {
  expect(() => render(props as Partial<ActionFormProps>)).toThrow('disagree with the confirmation routes')
})

test('a confirmation form carries the confirmation minted for its own method and URL, and keeps it outside its fields', () => {
  const minted: string[] = []
  const tokens: ConfirmationTokens = { issued: {}, mint: (method, path, name) => { minted.push(`${method} ${path} ${name}`); return 'synthetic-confirmation' } }
  const html = render({ confirmation: { consequence: 'Revoke all tokens and their sessions?' } }, tokens)
  expect(html).toContain('data-confirm-token="synthetic-confirmation"')
  expect(html).not.toContain('name="_confirm"')
  expect(minted).toEqual(['POST /v1/admin/tokens/revoke-all '])
})

test.each(['/v1/admin/ssh/credential-delete', '/v1/admin/ssh/host-delete'])('forms for different targets at %s receive their own confirmations', action => {
  const tokens: ConfirmationTokens = { issued: {}, mint: (_method, _path, name) => `token-for-${name}` }
  const first = render({ action, confirmation: { consequence: 'Delete?', typedName: 'first' } }, tokens)
  const second = render({ action, confirmation: { consequence: 'Delete?', typedName: 'second' } }, tokens)
  expect(first).toContain('data-confirm-token="token-for-first"')
  expect(second).toContain('data-confirm-token="token-for-second"')
})
