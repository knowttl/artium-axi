import { expect, test } from 'vitest'
import { toolManifests } from '../shared/tool-manifests.js'
import { toolsView, toolView } from './views.js'

const instances = [
  { name: 'lab', status: 'ok' as const, readOnly: false, description: 'Lab tenant, safe for tests.' },
  { name: 'production', status: 'error' as const, readOnly: true, description: 'Production, "read-only" checks only.' },
]
const falcon = { name: 'falcon-axi' as const, status: 'ok' as const, version: toolManifests['falcon-axi'].version, readOnly: false }

test('the tools listing shows an instance count per tool and one ask-the-user note', () => {
  const view = toolsView([{ ...falcon, instances }, { name: 'ldap-axi', status: 'ok', version: toolManifests['ldap-axi'].version }])
  expect(view).toContain(`tools[2]{name,status,version,readOnly,instances}:\n  falcon-axi,ok,"${falcon.version}",false,2\n  ldap-axi,ok,`)
  expect(view).toMatch(/ldap-axi,ok,"[^"]+",true,0\n/)
  expect(view.split('\n').filter(line => line.startsWith('note:'))).toEqual([
    'note: falcon-axi has several instances. Ask the user which instance to use, then run artium-axi --instance <name> <tool> ...'])
})

test('tools show lists instances and starts the first call with --instance when several are usable', () => {
  const lines = toolView({ ...falcon, instances }).split('\n')
  expect(lines).toContain('instances[2]{name,status,readOnly,description}:')
  expect(lines).toContain('  lab,ok,false,"Lab tenant, safe for tests."')
  expect(lines).toContain('  production,error,true,"Production, \\"read-only\\" checks only."')
  expect(lines.find(line => line.startsWith('example:'))).toMatch(/^example: artium-axi --instance lab falcon-axi /)
  expect(lines.some(line => line.startsWith('note: falcon-axi has several instances'))).toBe(true)
})

test('tools show keeps the plain example for a single instance and omits the block for none', () => {
  const single = toolView({ ...falcon, instances: instances.slice(0, 1) }).split('\n')
  expect(single).toContain('instances[1]{name,status,readOnly,description}:')
  expect(single.find(line => line.startsWith('example:'))).toMatch(/^example: artium-axi falcon-axi /)
  expect(single.some(line => line.startsWith('note:'))).toBe(false)
  expect(toolView(falcon)).not.toContain('instances[')
})
