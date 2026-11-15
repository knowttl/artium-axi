import { Field } from '@astryxdesign/core/Field'
import { Text } from '@astryxdesign/core/Text'
import { TextArea } from '@astryxdesign/core/TextArea'
import { TextInput } from '@astryxdesign/core/TextInput'
import { memo, useEffect, useRef, useState } from 'react'
import { CertificateVerification, type TlsSection } from './certificate-verification.js'

export interface CredentialControl {
  name: string
  id: string
  label: string
  help: string
  secret: boolean
  ephemeral: boolean
  required: boolean
  stored: boolean
  kind: 'select' | 'list' | 'textarea' | 'input'
  dataType: 'json' | 'list' | 'string'
  value: string
  emptyLabel?: string
  options?: { value: string, label: string, selected: boolean }[]
  numeric?: 'decimal' | 'integer'
}

export interface CredentialEditorProps {
  intro: string
  schema: Record<string, unknown>
  identity: Record<string, unknown>
  configured: boolean
  controls: CredentialControl[]
  tls: TlsSection | null
}

function Control({ control, value, onChange }: { control: CredentialControl, value: string, onChange: (value: string) => void }) {
  const { name, id, label, help, required, dataType } = control
  const hint = `${id}-hint`
  const profile = { 'data-profile-field': name, 'data-profile-type': dataType }
  if (control.secret) {
    return (
      <Field label={label} description={help} inputID={id} descriptionID={hint}>
        <textarea {...profile} id={id} name={`profile.${name}`} aria-describedby={hint} autoComplete="off" spellCheck={false} rows={6} className="input mono" />
      </Field>
    )
  }
  if (control.kind === 'select') {
    return (
      <Field label={label} description={help} inputID={id} descriptionID={hint}>
        <select {...profile} id={id} name={`profile.${name}`} aria-describedby={hint} autoComplete="off" required={required} className="select"
          defaultValue={control.options!.find(option => option.selected)?.value ?? ''}>
          <option value="">{control.emptyLabel}</option>
          {control.options!.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </Field>
    )
  }
  if (control.numeric) {
    return (
      <Field label={label} description={help} inputID={id} descriptionID={hint}>
        <input {...profile} id={id} name={`profile.${name}`} aria-describedby={hint} autoComplete="off" required={required} type="number" className="input"
          step={control.numeric === 'decimal' ? 'any' : undefined} defaultValue={control.value} />
      </Field>
    )
  }
  if (control.kind === 'input') {
    return <TextInput label={label} description={help} id={id} htmlName={`profile.${name}`} value={value} onChange={onChange} autoComplete="off" {...profile} {...{ required }} />
  }
  return (
    <TextArea label={label} description={control.kind === 'list' ? `${help} One value per line.` : help} id={id} htmlName={`profile.${name}`} value={value} onChange={onChange}
      rows={control.kind === 'list' ? 3 : 6} autoComplete="off" hasSpellCheck={control.kind === 'list'} {...profile} {...{ required }} />
  )
}

export const CredentialEditor = memo(function CredentialEditor({ intro, schema, identity, configured, controls, tls }: CredentialEditorProps) {
  const [values, setValues] = useState(() => Object.fromEntries(controls.filter(control => !control.secret).map(control => [control.name, control.value])))
  const editor = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const dialog = editor.current?.closest('dialog')
    const clear = () => {
      for (const typed of editor.current?.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>('[data-secret] textarea, [data-certificate-pem], [data-certificate-file], [data-tls-file], textarea[data-tls-input]') ?? []) typed.value = ''
      editor.current?.dispatchEvent(new Event('change', { bubbles: true }))
    }
    dialog?.addEventListener('close', clear)
    return () => dialog?.removeEventListener('close', clear)
  }, [])
  return (
    <div ref={editor} data-credential-editor="" data-schema={JSON.stringify(schema)} data-identity={JSON.stringify(identity)} data-configured={String(configured)}>
      <Text as="p" type="supporting">{intro}</Text>
      {controls.map(control => (
        <div key={control.name} data-credential-field={control.name} data-secret={control.secret ? '' : undefined} data-ephemeral={control.ephemeral ? '' : undefined} suppressHydrationWarning>
          <Control control={control} value={values[control.name] ?? ''} onChange={value => setValues(current => ({ ...current, [control.name]: value }))} />
          {control.stored && <p data-stored-secret="" suppressHydrationWarning>Stored when configured below. Leave blank to keep; enter a value to replace.</p>}
        </div>
      ))}
      {tls && <CertificateVerification section={tls} />}
      <div data-certificate="" hidden suppressHydrationWarning>
        <Field label="Certificate and private key (one PEM file)" inputID="credential-certificate-file">
          <input id="credential-certificate-file" type="file" data-certificate-file="" accept=".pem" />
        </Field>
        <Field label="Or paste certificate and private key" inputID="credential-certificate-pem"
          description="Include one certificate and its matching unencrypted private key. The server calculates the fingerprint. Leave blank to keep the stored key and fingerprint, or use the separate fields above.">
          <textarea id="credential-certificate-pem" data-certificate-pem="" rows={8} autoComplete="off" spellCheck={false} className="input mono" />
        </Field>
      </div>
      <details>
        <summary>Advanced: profile schema and requirements</summary>
        <pre>{JSON.stringify(schema, null, 2)}</pre>
      </details>
    </div>
  )
})
