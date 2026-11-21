import { Field } from '@astryxdesign/core/Field'
import { Text } from '@astryxdesign/core/Text'
import { useRef, useState } from 'react'

export interface TlsField {
  path: string
  id: string
  label: string
  help: string
  value: string
  required: boolean
  clearable: boolean
  upload?: string
}

export interface TlsRemoval {
  path: string
  label: string
}

export interface TlsSection {
  legend: string
  intro: string
  connection: ({ field: TlsField } | { label: string, unsupported: string })[]
  saved: { certificateLabel: string, certificate: string, fingerprintLabel: string, fingerprint: string }
  certificate: { summary: string, open: boolean, note: string, fields: TlsField[] } | null
  certificateRemoval: TlsRemoval | null
  pin: { summary: string, fingerprint: TlsField, hostname: { id: string, path: string, label: string, emptyLabel: string, help: string } } | null
  pinRemoval: TlsRemoval | null
  note: string
}

export async function loadPem(upload: HTMLInputElement, target: HTMLTextAreaElement) {
  const file = upload.files?.[0]
  if (!file) return
  const content = await file.text()
  if (upload.files?.[0] !== file) return
  target.value = content
  target.dispatchEvent(new Event('input', { bubbles: true }))
}

function TlsInput({ field }: { field: TlsField }) {
  const { path, id, label, help, value, required, clearable, upload } = field
  const hint = `${id}-hint`
  const profile = { id, name: `profile.${path}`, 'data-profile-field': path, 'data-profile-type': 'string', 'data-tls-input': '', 'aria-describedby': hint, autoComplete: 'off', required }
  const [edited, setEdited] = useState(false)
  const pem = useRef<HTMLTextAreaElement>(null)
  return (
    <div data-credential-field={path}>
      <Field label={label} description={help} inputID={id} descriptionID={hint}>
        {upload
          ? <textarea {...profile} ref={pem} rows={6} spellCheck={false} className="input mono" />
          : <input {...profile} type="text" defaultValue={value} className="input" data-profile-clearable={clearable ? '' : undefined} data-tls-edited={edited ? 'true' : undefined}
            onChange={clearable ? () => setEdited(true) : undefined} />}
      </Field>
      {upload && (
        <Field label={upload} inputID={`${id}-file`}>
          <input id={`${id}-file`} type="file" data-tls-file={path} accept=".pem" onChange={event => loadPem(event.currentTarget, pem.current!)} />
        </Field>
      )}
    </div>
  )
}

function TlsRemove({ removal }: { removal: TlsRemoval | null }) {
  return removal && <label className="check"><input type="checkbox" data-tls-remove={removal.path} />{removal.label}</label>
}

export function CertificateVerification({ section }: { section: TlsSection }) {
  const { saved, certificate, pin } = section
  return (
    <fieldset>
      <legend>{section.legend}</legend>
      <Text as="p" type="supporting">{section.intro}</Text>
      {section.connection.map(entry => 'field' in entry
        ? <TlsInput key={entry.field.path} field={entry.field} />
        : <Text key={entry.label} as="p" type="supporting"><strong>{entry.label}</strong>{`: ${entry.unsupported}`}</Text>)}
      <details>
        <summary>{saved.certificateLabel}</summary>
        <pre>{saved.certificate}</pre>
      </details>
      <Text as="p" type="supporting">{saved.fingerprintLabel}</Text>
      <pre>{saved.fingerprint}</pre>
      {certificate && (
        <details open={certificate.open}>
          <summary>{certificate.summary}</summary>
          {certificate.note && <Text as="p" type="supporting">{certificate.note}</Text>}
          {certificate.fields.map(field => <TlsInput key={field.path} field={field} />)}
        </details>
      )}
      <TlsRemove removal={section.certificateRemoval} />
      {pin && (
        <details>
          <summary>{pin.summary}</summary>
          <TlsInput field={pin.fingerprint} />
          <Field label={pin.hostname.label} description={pin.hostname.help} inputID={pin.hostname.id} descriptionID={`${pin.hostname.id}-hint`}>
            <select id={pin.hostname.id} name={`profile.${pin.hostname.path}`} data-profile-field={pin.hostname.path} data-profile-type="json" data-tls-input="" aria-describedby={`${pin.hostname.id}-hint`} className="select">
              <option value="">{pin.hostname.emptyLabel}</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </Field>
        </details>
      )}
      <TlsRemove removal={section.pinRemoval} />
      {section.note && <Text as="p" type="supporting">{section.note}</Text>}
    </fieldset>
  )
}
