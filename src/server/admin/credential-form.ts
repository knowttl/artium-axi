import type { CredentialProfile } from '../adapters/credential-profile.js'
import { escape } from './escape.js'

export function credentialFields(profile: CredentialProfile): string {
  const fields = profile.fields().map(({ name, schema, required }) => {
    const attributes = `name="profile.${escape(name)}" data-profile-field="${escape(name)}"${required ? ' required' : ''} autocomplete="off"`
    const label = escape(schema.title ?? name) + (schema['x-secret'] ? ' (secret)' : '')
    let input: string
    if (schema.enum) {
      input = `<select ${attributes} data-profile-type="json"><option value="">Choose a value</option>${schema.enum.map((value: unknown) =>
        `<option value="${escape(JSON.stringify(value))}">${escape(String(value))}</option>`).join('')}</select>`
    } else if (schema.type === 'boolean') {
      input = `<select ${attributes} data-profile-type="json"><option value="">Use the default</option><option value="true">True</option><option value="false">False</option></select>`
    } else if (schema['x-secret'] || !['string', 'number', 'integer'].includes(schema.type)) {
      input = `<textarea ${attributes} data-profile-type="${schema['x-secret'] ? 'string' : 'json'}" rows="3" spellcheck="false"></textarea>`
    } else {
      input = `<input ${attributes} data-profile-type="${schema.type === 'string' ? 'string' : 'json'}" type="${schema.type === 'string' ? 'text' : 'number'}"${schema.type === 'number' ? ' step="any"' : ''}>`
    }
    return `<label>${label}${input}</label>${schema.description ? `<p>${escape(schema.description)}</p>` : ''}`
  }).join('')
  return '<p>Enter a complete replacement. Leave unused fields blank. Secret fields accept the value itself; stored values are never filled in.</p>' + fields +
    `<details><summary>Profile schema and requirements</summary><pre>${escape(JSON.stringify(profile.inputSchema, null, 2))}</pre></details>`
}
