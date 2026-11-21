import { readSuccessfulTestHealth, readTestResponse, structuredDiagnostic } from '../shared/diagnostic.js'
import { errors } from '../shared/errors.js'
import type { Confirmation } from './action-form.js'
import type { CertificateInspection } from './certificate-inspection.js'
import { completePemFields } from './certificate-verification.js'
import { claimLinkEvent } from './claim-link.js'
import { confirmationEvent, type ConfirmationRequest } from './confirmation.js'
import { createdTokenEvent } from './created-token.js'
import type { GithubDeviceStart } from './github-device.js'
import { requestReauth } from './reauth.js'
import { storeTestOutcome, type TestOutcome } from './test-outcome.js'
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
  claimLink?: boolean
  createdToken?: boolean
  bodyFrom?: (fields: FormData) => Body
  saveTool?: string
  retestUrl?: string
  showTest?: (outcome: TestOutcome) => void
  showInspection?: (inspection: CertificateInspection) => void
  showDevice?: (connection: GithubDeviceStart, report: Report) => Promise<void>
  report: Report
}

export type Report = (text: string, reload?: boolean) => void

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
type Body = Record<string, unknown>
type FormDraft = ReturnType<typeof snapshotForm>

const hydrated = typeof document === 'undefined' ? undefined : new Promise<void>(resolve => {
  document.addEventListener('astryx-hydrated', () => resolve(), { once: true })
})

function beginSubmit(form: HTMLFormElement, submitter: HTMLButtonElement | null) {
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

function wasEdited(input: HTMLInputElement) {
  const clone = input.cloneNode() as HTMLInputElement
  clone.defaultValue = `${clone.value} `
  return clone.value !== clone.defaultValue
}

function applyProfile(form: HTMLFormElement, fields: FormData, body: Body): string | null {
  const inputs = Array.from(form.querySelectorAll<Control>('[data-profile-field]'))
  if (!inputs.length) return null
  const endpointChanged = Array.from(form.querySelectorAll<HTMLInputElement>('[data-profile-field="origin"], [data-profile-field="url"]'))
    .some(endpoint => fields.has(endpoint.name) && fields.get(endpoint.name) !== (endpoint.dataset.saved ?? endpoint.defaultValue))
  const value: Record<string, any> = Object.create(null)
  for (const input of inputs) {
    delete body[input.name]
    const raw = fields.get(input.name) as string | null
    const clearable = input.hasAttribute('data-profile-clearable')
    const tls = input.hasAttribute('data-tls-input')
    if (raw === null || raw === '' && !clearable) continue
    if (input instanceof HTMLInputElement && clearable && endpointChanged && !wasEdited(input)) continue
    const path = tls ? input.dataset.profileField!.split('.') : [input.dataset.profileField!]
    const key = path.pop()!
    const parent = path.reduce((node, name) => node[name] ??= Object.create(null), value)
    try {
      parent[key] = raw === '' ? null : input.dataset.profileType === 'list' ? raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
        : input.dataset.profileType === 'json' ? JSON.parse(raw) : raw
    } catch { return `Enter valid JSON in ${input.dataset.profileField}.` }
  }
  for (const removal of form.querySelectorAll<HTMLInputElement>('[data-tls-remove]')) {
    delete body[removal.name]
    if (fields.has(removal.name)) value[removal.dataset.tlsRemove!] = null
  }
  delete body.certificatePem
  const certificate = fields.get('certificatePem')
  if (certificate) value.certificatePem = certificate
  body.value = value
  return null
}

function snapshotForm(form: HTMLFormElement) {
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

async function retestConnection(url: string, csrf: unknown): Promise<TestOutcome | { redirect: string }> {
  let response: Response
  try {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Artium-Retest': '1' }, body: JSON.stringify({ _csrf: csrf }) })
  } catch {
    return { message: 'Connection test: Could not reach the artium admin server. Run Test connection again.' }
  }
  if (response.redirected) return { redirect: response.url }
  const status = ` HTTP ${response.status}.`
  let result
  try { result = await response.json() }
  catch (error) {
    return { message: error instanceof SyntaxError
      ? `Connection test: response was not valid JSON.${status} Check the server or proxy response format. Run Test connection again.`
      : `Connection test: response body could not be read.${status} Check the connection for an interrupted response. Run Test connection again.` }
  }
  if (response.ok) {
    const health = readSuccessfulTestHealth(result)
    return health ? { message: 'Connected', health }
      : { message: `Connection test: response did not match the connection-test format.${status} Check server and client version compatibility. Run Test connection again.` }
  }
  const code = result?.error?.code
  const errorCode = typeof code === 'string' && Object.hasOwn(errors, code) ? code as keyof typeof errors : undefined
  const detail = structuredDiagnostic(result?.error?.diagnostic)
  const message = `Connection test:${status}` + (errorCode ? ` ${errors[errorCode].message} (${errorCode}).` : ' Server error code unavailable.') +
    (detail?.stage ? ` Failed step: ${detail.stage}.` : '') + (detail?.toolCode ? ` Code: ${detail.toolCode}.` : '') +
    (detail?.transportCode ? ` Transport: ${detail.transportCode}.` : '') + (detail?.providerCode ? ` Provider: ${detail.providerCode}.` : '') +
    (detail?.upstreamStatus === undefined ? '' : ` Upstream HTTP ${detail.upstreamStatus}.`) +
    (detail?.trust ? ` Certificate trust: ${detail.trust}.` : '') + ' Run Test connection again.'
  return { message }
}

export async function submitForm({ form, submitter, action, method, confirmation, token, successUrl, successMessage, claimLink, createdToken, bodyFrom, saveTool, retestUrl, showTest, showInspection, showDevice, report }: SubmitRequest) {
  const submission = beginSubmit(form, submitter)
  if (!submission) return
  const { button, release } = submission
  try {
    const draft = snapshotForm(form)
    if (form.querySelector('[data-credential-editor]')) await completePemFields(draft.fields)
    const body: Body = bodyFrom ? { _csrf: draft.fields.get('_csrf'), ...bodyFrom(draft.fields) } : Object.fromEntries(draft.fields)
    const invalidProfile = applyProfile(form, draft.fields, body)
    const testUrl = saveTool && draft.fields.has('testAfterSave')
      ? `/v1/admin/tools/${saveTool}/instances/${form.dataset.saveInstance || body.name}/test` : undefined
    if (saveTool) delete body.testAfterSave
    await hydrated
    report('')
    showTest?.({ message: '' })
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
    const invalid = invalidProfile ?? shapeBody(draft, body)
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
        if (!await requestReauth(body._csrf)) return
        response = await send()
      }
    }
    if (response.redirected) {
      location.assign(response.url)
      return
    }
    if (showTest) {
      const { error, health } = await readTestResponse(response)
      showTest({ message: response.ok ? 'Test passed.' : 'Test failed.', health })
      if (error) report(`${error.message} ${error.next} (${error.code})`, error.code === 'REVISION_CONFLICT')
      return
    }
    if (!response.ok) {
      const { error } = await response.json() as { error: { message: string, next: string, code: string } }
      report(`${error.message} ${error.next} (${error.code})`, error.code === 'REVISION_CONFLICT')
      return
    }
    if (showDevice) {
      await showDevice(await response.json() as GithubDeviceStart, report)
      return
    }
    if (showInspection) {
      showInspection(await response.json() as CertificateInspection)
      return
    }
    if (retestUrl) {
      report('Certificate trusted. Testing connection…')
      const outcome = await retestConnection(retestUrl, body._csrf)
      if ('redirect' in outcome) location.assign(outcome.redirect)
      else {
        storeTestOutcome(outcome)
        location.reload()
      }
      return
    }
    if (saveTool) {
      const { normalizations = [] } = await response.json() as { normalizations?: { field: string, reason: string }[] }
      const tested = testUrl ? await fetch(testUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ _csrf: body._csrf }) }).catch(() => undefined) : undefined
      if (tested?.redirected) {
        location.assign(tested.url)
        return
      }
      const result = tested ? await readTestResponse(tested).catch(() => undefined) : undefined
      let message = !testUrl ? 'Saved.' : !result ? 'Saved. Test could not complete. Run Test connection again.'
        : result.error ? `Saved. Test failed. ${result.error.message} ${result.error.next} (${result.error.code})` : 'Saved. Test passed.'
      for (const { field, reason } of normalizations) message += ` ${field}: ${reason}.`
      storeTestOutcome({ message, health: result?.health })
      location.reload()
      return
    }
    if (claimLink) {
      const { claimPath } = await response.json() as { claimPath: string }
      form.closest('dialog')!.close()
      document.dispatchEvent(new CustomEvent(claimLinkEvent, { detail: new URL(claimPath, location.origin).href }))
      return
    }
    if (createdToken) {
      const { token: created } = await response.json() as { token: string }
      document.dispatchEvent(new CustomEvent(createdTokenEvent, { detail: created }))
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
