export type FormControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
export type FormDraft = ReturnType<typeof snapshotForm>

export interface DeferredSubmitEvent extends SubmitEvent {
  draft?: FormDraft
}

function wasEdited(input: HTMLInputElement) {
  const clone = input.cloneNode() as HTMLInputElement
  clone.defaultValue = `${clone.value} `
  return clone.value !== clone.defaultValue
}

export function snapshotForm(form: HTMLFormElement) {
  return {
    fields: new FormData(form),
    typed: Array.from(form.querySelectorAll<FormControl>('[data-type]'), input => ({
      name: input.name,
      value: input.value,
      type: input.dataset.type,
      checked: input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked : undefined,
    })),
    editedOverrides: new Set(Array.from(form.querySelectorAll<HTMLInputElement>('input[data-profile-clearable]'))
      .filter(wasEdited).map(input => input.name)),
  }
}
