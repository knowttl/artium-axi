import { expect, test } from 'vitest'
import { toolManifests } from '../shared/tool-manifests.js'
import { toolsView, toolView } from './views.js'

const instances = [
  { name: 'lab', status: 'ok' as const, readOnly: false, description: 'Lab tenant, safe for tests.' },
  { name: 'production', status: 'error' as const, readOnly: true, description: 'Production, "read-only" checks only.' },
]
const falcon = { name: 'falcon-axi' as const, status: 'ok' as const, version: toolManifests['falcon-axi'].version, readOnly: false }

test('the tools listing shows instance counts without suggesting an ambiguous call', () => {
  const view = toolsView([{ ...falcon, instances }, { name: 'ldap-axi', status: 'ok', version: toolManifests['ldap-axi'].version }])
  expect(view).toContain(`tools[2]{name,status,version,readOnly,instances}:\n  falcon-axi,ok,"${falcon.version}",false,2\n  ldap-axi,ok,`)
  expect(view).toMatch(/ldap-axi,ok,"[^"]+",true,0\n/)
  expect(view).toContain('next[1]:\n  - artium-axi tools show falcon-axi\n')
  expect(view).not.toContain('note:')
})

test('tools show lists instances and starts the first call with --instance when several are usable', () => {
  const lines = toolView({ ...falcon, instances }).split('\n')
  expect(lines).toContain('instances[2]{name,status,readOnly,description}:')
  expect(lines).toContain('  lab,ok,false,"Lab tenant, safe for tests."')
  expect(lines).toContain('  production,error,true,"Production, \\"read-only\\" checks only."')
  expect(lines.find(line => line.startsWith('example:'))).toMatch(/^example: artium-axi --instance <name> falcon-axi /)
  expect(lines.some(line => line.startsWith('note:'))).toBe(false)
})

test('tools show includes the instance block and neutral selector for one or no instances', () => {
  const single = toolView({ ...falcon, instances: instances.slice(0, 1) }).split('\n')
  expect(single).toContain('instances[1]{name,status,readOnly,description}:')
  expect(single.find(line => line.startsWith('example:'))).toMatch(/^example: artium-axi --instance <name> falcon-axi /)
  expect(single.some(line => line.startsWith('note:'))).toBe(false)
  expect(toolView(falcon)).toContain('instances[0]{name,status,readOnly,description}:\n')
})

test('delegated tool detail includes the instance block and neutral example', () => {
  const view = toolView({ ...falcon, instances, commands: ['host list'] })
  expect(view).toContain('instances[2]{name,status,readOnly,description}:\n')
  expect(view).toContain('example: artium-axi --instance <name> falcon-axi ...\n')
  expect(view).not.toContain('note:')
})
