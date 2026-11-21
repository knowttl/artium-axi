import type { Confirmation } from './action-form.js'
import { confirmationEvent, type ConfirmationRequest } from './confirmation.js'
import { reauthRequestEvent } from './reauth.js'
import { successKey } from './toasts.js'

export interface SubmitRequest {
  form: HTMLFormElement
  submitter: HTMLButtonElement | null
  action: string
  method: string
  confirmation?: Confirmation
  token?: string
  successUrl?: string
  successMessage?: string
  report: (text: string, reload?: boolean) => void
}

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
type Body = Record<string, unknown>

let pending = false

function ask<Answer>(type: string, detail: object) {
  return new Promise<Answer>(resolve => document.dispatchEvent(new CustomEvent(type, { cancelable: true, detail: { ...detail, resolve } })))
}

function shapeBody(form: HTMLFormElement, fields: FormData, body: Body): string | null {
  for (const input of form.querySelectorAll<Control>('[data-type]')) {
    const { name, value } = input
    if (input.dataset.type === 'boolean') body[name] = input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked : value === 'true'
    if (input.dataset.type === 'number') body[name] = Number(value)
    if (input.dataset.type === 'array') body[name] = fields.getAll(name)
    if (input.dataset.type === 'lines') body[name] = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    if (input.dataset.type === 'json') {
      try { body[name] = JSON.parse(value) } catch { return `Enter valid JSON in ${name}.` }
    }
  }
  if (form.querySelector('[name=roleIds]')) body.roleIds = fields.getAll('roleIds')
  return null
}

export async function submitForm({ form, submitter, action, method, confirmation, token, successUrl, successMessage, report }: SubmitRequest) {
  const button = submitter ?? form.querySelector<HTMLButtonElement>('button:not([form]):not([type=button]):not([type=reset])')!
  if (pending || button.disabled) return
  pending = true
  button.disabled = true
  report('')
  const fields = new FormData(form)
  const body: Body = Object.fromEntries(fields)
  try {
    if (confirmation) {
      const confirmAction = confirmation.action || button.textContent!.trim()
      const typedName = await ask<string | null>(confirmationEvent, { action: confirmAction, title: confirmation.title || `${confirmAction}?`,
        consequence: confirmation.consequence, typedName: confirmation.typedName ?? '' } satisfies Omit<ConfirmationRequest, 'resolve'>)
      if (typedName === null) {
        const dialog = document.getElementById('confirmation') as HTMLDialogElement
        if (dialog.open) await new Promise(resolve => dialog.addEventListener('close', resolve, { once: true }))
        button.disabled = false
        button.focus()
        return
      }
      body._confirm = token
      if (confirmation.typedName) body._confirmName = typedName
      for (const name of ['_confirmTitle', '_confirmAction', '_confirmText']) delete body[name]
    }
    const invalid = shapeBody(form, fields, body)
    if (invalid) {
      report(invalid)
      return
    }
    let confirmationRetried = false
    const send = async () => {
      const request = () => fetch(action, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) })
      let response = await request()
      if (!confirmationRetried && response.status === 428 && response.headers.get('x-artium-confirmation')) {
        confirmationRetried = true
        body._confirm = response.headers.get('x-artium-confirmation')
        response = await request()
      }
      return response
    }
    let response = await send()
    if (response.status === 401 && !response.redirected) {
      const result = await response.clone().json() as { error: { code: string } }
      if (result.error.code === 'REAUTH_REQUIRED') {
        if (!await ask<boolean>(reauthRequestEvent, { csrf: body._csrf })) return
        response = await send()
      }
    }
    if (response.redirected) {
      location.assign(response.url)
      return
    }
    if (!response.ok) {
      const { error } = await response.json() as { error: { message: string, next: string, code: string } }
      report(`${error.message} ${error.next} (${error.code})`, error.code === 'REVISION_CONFLICT')
      return
    }
    sessionStorage.setItem(successKey, successMessage || 'Change saved.')
    if (successUrl?.includes('{id}')) location.assign(successUrl.replace('{id}', encodeURIComponent((await response.json() as { id: string }).id)))
    else if (successUrl) location.assign(successUrl)
    else location.reload()
  } catch {
    report('Request could not complete. Reload the page to check the current state before trying again.')
  } finally {
    button.disabled = false
    pending = false
  }
}
