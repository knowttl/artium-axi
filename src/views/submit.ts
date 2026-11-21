import type { Confirmation } from './action-form.js'
import { confirmationEvent, type ConfirmationRequest } from './confirmation.js'
import { reauthRequestEvent } from './reauth.js'
import { successKey } from './toasts.js'

export interface SubmitRequest {
  form: HTMLFormElement
  submitter: HTMLButtonElement | null
  draft?: FormDraft
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
type FormDraft = ReturnType<typeof snapshotForm>

export interface DeferredSubmitEvent extends SubmitEvent {
  astryxDraft?: FormDraft
}

export function beginSubmit(form: HTMLFormElement, submitter: HTMLButtonElement | null) {
  const button = submitter ?? form.querySelector<HTMLButtonElement>('button:not([form]):not([type=button]):not([type=reset])')!
  const page = document.documentElement
  const pending = 'data-submit-pending'
  if (page.hasAttribute(pending) || button.disabled) return
  page.setAttribute(pending, '')
  button.disabled = true
  return {
    button,
    release() {
      button.disabled = false
      page.removeAttribute(pending)
    },
  }
}

export function snapshotForm(form: HTMLFormElement) {
  return {
    fields: new FormData(form),
    typed: Array.from(form.querySelectorAll<Control>('[data-type]'), input => ({
      name: input.name,
      value: input.value,
      type: input.dataset.type,
      checked: input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked : undefined,
    })),
  }
}

function ask<Answer>(type: string, detail: object) {
  return new Promise<Answer>(resolve => document.dispatchEvent(new CustomEvent(type, { cancelable: true, detail: { ...detail, resolve } })))
}

function shapeBody({ fields, typed }: FormDraft, body: Body): string | null {
  for (const { name, value, type, checked } of typed) {
    if (type === 'boolean') body[name] = checked ?? (value === 'true')
    if (type === 'number') body[name] = Number(value)
    if (type === 'array') body[name] = fields.getAll(name)
    if (type === 'lines') body[name] = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    if (type === 'json') {
      try { body[name] = JSON.parse(value) } catch { return `Enter valid JSON in ${name}.` }
    }
  }
  return null
}

export async function submitForm({ form, submitter, draft, action, method, confirmation, token, successUrl, successMessage, report }: SubmitRequest) {
  const submission = beginSubmit(form, submitter)
  if (!submission) return
  const { button, release } = submission
  try {
    report('')
    draft ??= snapshotForm(form)
    const body: Body = Object.fromEntries(draft.fields)
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
    const invalid = shapeBody(draft, body)
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
    release()
  }
}
