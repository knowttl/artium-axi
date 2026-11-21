import { Field } from '@astryxdesign/core/Field'
import { Text } from '@astryxdesign/core/Text'
import { TextArea } from '@astryxdesign/core/TextArea'
import { TextInput } from '@astryxdesign/core/TextInput'
import { VStack } from '@astryxdesign/core/VStack'
import { memo, useLayoutEffect, useRef, useState } from 'react'
import { CertificateVerification, usePemUpload, type TlsSection } from './certificate-verification.js'
import { evaluateCredentialSchema } from './credential-schema.js'

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

type NativeField = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement

interface Snapshot {
  values: Record<string, unknown>
  certificateEntered: boolean
}

const certificateIdentityFields = ['privateKey', 'thumbprint', 'thumbprintSha256']
const textareaDrafts = new WeakMap<Element, string>()

export function captureCredentialTextareaDrafts(root: HTMLElement) {
  for (const field of root.querySelectorAll<HTMLTextAreaElement>('textarea[data-credential-draft]')) {
    if (field.value !== field.defaultValue) textareaDrafts.set(field, field.value)
  }
}

function parse(raw: string, dataType?: string) {
  if (!raw) return null
  if (dataType !== 'json') return raw
  try { return JSON.parse(raw) } catch { return null }
}

const initialSnapshot = (controls: CredentialControl[]): Snapshot => ({
  values: Object.fromEntries(controls.map(control => [control.name, control.secret ? null
    : parse(control.kind === 'select' ? control.options!.find(option => option.selected)?.value ?? '' : control.value, control.dataType)])),
  certificateEntered: false,
})

const readSnapshot = (editor: HTMLElement): Snapshot => ({
  values: Object.fromEntries(Array.from(editor.querySelectorAll<NativeField>('[data-profile-field]:not([data-tls-input])'), field => [field.dataset.profileField,
    field.closest('[data-secret]') ? field.value ? true : null : parse(field.value, field.dataset.profileType)])),
  certificateEntered: editor.querySelector<HTMLTextAreaElement>('[data-certificate-pem]')!.value !== '',
})

function Control({ control, value, required, disabled, onChange }: { control: CredentialControl, value: string, required: boolean, disabled: boolean, onChange: (value: string) => void }) {
  const { name, id, label, help, dataType } = control
  const hint = `${id}-hint`
  const profile = { 'data-profile-field': name, 'data-profile-type': dataType }
  if (control.secret) {
    return (
      <Field label={label} description={help} inputID={id} descriptionID={hint}>
        <textarea {...profile} id={id} name={`profile.${name}`} aria-describedby={hint} autoComplete="off" spellCheck={false} rows={6} required={required} disabled={disabled} className="input mono" />
      </Field>
    )
  }
  if (control.kind === 'select') {
    return (
      <Field label={label} description={help} inputID={id} descriptionID={hint}>
        <select {...profile} id={id} name={`profile.${name}`} aria-describedby={hint} autoComplete="off" required={required} disabled={disabled} className="select"
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
        <input {...profile} id={id} name={`profile.${name}`} aria-describedby={hint} autoComplete="off" required={required} disabled={disabled} type="number" className="input"
          step={control.numeric === 'decimal' ? 'any' : undefined} defaultValue={control.value} />
      </Field>
    )
  }
  const draft = { ...profile, 'data-credential-draft': '' }
  if (control.kind === 'input') {
    return <TextInput label={label} description={help} id={id} htmlName={`profile.${name}`} value={value} onChange={onChange} autoComplete="off" {...draft} {...{ required, disabled, 'data-saved': control.value }} />
  }
  return (
    <TextArea label={label} description={control.kind === 'list' ? `${help} One value per line.` : help} id={id} htmlName={`profile.${name}`} value={value} onChange={onChange}
      rows={control.kind === 'list' ? 3 : 6} autoComplete="off" hasSpellCheck={control.kind === 'list'} {...draft} {...{ required, disabled }} />
  )
}

export const CredentialEditor = memo(function CredentialEditor({ intro, schema, identity, configured, controls, tls }: CredentialEditorProps) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [snapshot, setSnapshot] = useState(() => initialSnapshot(controls))
  const editor = useRef<HTMLDivElement>(null)
  const certificate = useRef<HTMLTextAreaElement>(null)
  const pemUpload = usePemUpload(certificate, 'certificatePem')
  useLayoutEffect(() => {
    const root = editor.current!
    const dialog = root.closest('dialog')
    const refresh = () => setSnapshot(readSnapshot(root))
    const clear = () => {
      for (const typed of root.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>('[data-secret] textarea, [data-certificate-pem], [data-certificate-file], [data-tls-file], textarea[data-tls-input]')) typed.value = ''
      refresh()
    }
    setValues(Object.fromEntries(Array.from(root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-credential-draft]'), field => {
      const draft = textareaDrafts.get(field)
      textareaDrafts.delete(field)
      if (draft !== undefined && field.value === field.defaultValue) field.value = draft
      return [field.dataset.profileField!, field.value]
    })))
    refresh()
    root.addEventListener('input', refresh)
    root.addEventListener('change', refresh)
    dialog?.addEventListener('close', clear)
    window.addEventListener('pagehide', clear)
    return () => {
      root.removeEventListener('input', refresh)
      root.removeEventListener('change', refresh)
      dialog?.removeEventListener('close', clear)
      window.removeEventListener('pagehide', clear)
    }
  }, [])
  const { required, forbidden, sameIdentity } = evaluateCredentialSchema(schema, identity, configured, snapshot.values)
  const certificateHidden = forbidden.has('auth') || snapshot.values.auth !== 'certificate' || !controls.some(control => ['thumbprint', 'thumbprintSha256'].includes(control.name))
  const combinedCertificate = !certificateHidden && snapshot.certificateEntered
  return (
    <div ref={editor} data-credential-editor="">
      <Text as="p" type="supporting">{intro}</Text>
      {controls.map(control => {
        const hidden = forbidden.has(control.name)
        const needed = !hidden && required.has(control.name) && !(control.secret && !control.ephemeral && sameIdentity) && !(combinedCertificate && certificateIdentityFields.includes(control.name))
        return (
          <div key={control.name} data-credential-field={control.name} data-secret={control.secret ? '' : undefined} data-ephemeral={control.ephemeral ? '' : undefined} hidden={hidden}>
            <VStack gap={1}>
              <Control control={control} value={values[control.name] ?? control.value} required={needed} disabled={hidden} onChange={value => setValues(current => ({ ...current, [control.name]: value }))} />
              {control.stored && (
                <Text as="p" type="supporting" data-stored-secret="">
                  {sameIdentity ? 'Stored when configured. Leave blank to keep; enter a value to replace.' : 'Identity changed. Enter a new secret before saving.'}
                </Text>
              )}
            </VStack>
          </div>
        )
      })}
      {tls && <CertificateVerification section={tls} />}
      <div data-certificate="" hidden={certificateHidden}>
        <Field label="Certificate and private key (one PEM file)" inputID="credential-certificate-file">
          <input id="credential-certificate-file" type="file" data-certificate-file="" accept=".pem" {...pemUpload} />
        </Field>
        <Field label="Or paste certificate and private key" inputID="credential-certificate-pem"
          description="Include one certificate and its matching unencrypted private key. The server calculates the fingerprint. Leave blank to keep the stored key and fingerprint, or use the separate fields above.">
          <textarea ref={certificate} id="credential-certificate-pem" name="certificatePem" data-certificate-pem="" disabled={certificateHidden} rows={8} autoComplete="off" spellCheck={false} className="input mono" />
        </Field>
      </div>
      <details>
        <summary>Advanced: profile schema and requirements</summary>
        <pre>{JSON.stringify(schema, null, 2)}</pre>
      </details>
    </div>
  )
})
