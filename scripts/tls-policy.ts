import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../src/server/', import.meta.url))
const transportOwners = new Set(['credential-tls.ts', 'runner/pinned-http.ts', 'health/preflight.ts',
  'runner/runner.ts', 'trusted-ca.ts', 'certificate-inspection.ts'])
const optionOwners = new Set(['credential-tls.ts', 'runner/runtime-trust.ts', 'health/preflight.ts'])
const transports = new Set(['tls', 'https', 'http2', 'undici'])
const options = new Set(['rejectUnauthorized', 'checkServerIdentity', 'allowPartialTrustChain', 'secureContext'])
const failures: string[] = []

function inspect(directory: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) { inspect(path); continue }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
    const name = relative(root, path)
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)
        && transports.has(node.moduleSpecifier.text.replace(/^node:/, '')) && !transportOwners.has(name)) {
        failures.push(`${name}: direct TLS transport must use credential-tls.ts`)
      }
      if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
        && transports.has(node.arguments[0].text.replace(/^node:/, '')) && !transportOwners.has(name)) {
        failures.push(`${name}: dynamic TLS transport must use credential-tls.ts`)
      }
      if ((ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node)) && node.name
        && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
        && options.has(node.name.text) && !optionOwners.has(name)) {
        failures.push(`${name}: TLS verification options belong in credential-tls.ts`)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
}

inspect(root)
if (failures.length) throw new Error(failures.join('\n'))
console.log('TLS policy: all server transports use the reviewed trust boundaries')
