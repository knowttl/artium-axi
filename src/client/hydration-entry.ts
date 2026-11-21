import { snapshotForm, type DeferredSubmitEvent } from '../views/form-draft.js'

let pending: { form: HTMLFormElement, event: DeferredSubmitEvent } | undefined
function holdSubmit(event: SubmitEvent) {
  const form = event.target
  if (!(form instanceof HTMLFormElement) || !form.matches('[data-api]:not([data-native-submit])')) return
  event.preventDefault()
  event.stopPropagation()
  if (pending) return
  pending = { form, event: Object.assign(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: event.submitter }),
    { draft: snapshotForm(form) }) }
}

document.addEventListener('submit', holdSubmit, true)
document.addEventListener('astryx-hydrated', () => {
  document.removeEventListener('submit', holdSubmit, true)
  const submission = pending
  pending = undefined
  submission?.form.dispatchEvent(submission.event)
}, { once: true })

const reactBundle = '/admin/assets/hydrate-app.js'
document.addEventListener('DOMContentLoaded', () => { void import(reactBundle) }, { once: true })
