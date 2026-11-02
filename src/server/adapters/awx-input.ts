import { isNode, isScalar, parseDocument, visit } from 'yaml'
import type { RunnerInput } from '../runner/input.js'
import { protocolOutputFields, secretFieldPattern } from '../runner/scan.js'

// Upstream's public main accepts argv in memory. Load private structured values
// there, so even tools which require inline JSON/YAML never receive it via exec.
export const awxInputBridge = `
const { readFileSync } = await import('node:fs');
const { pathToFileURL } = await import('node:url');
const { createRequire } = await import('node:module');
const executable = process.argv[1];
const argv = process.argv.slice(2);
const require = createRequire(executable);
const { decode, encode } = await import(pathToFileURL(require.resolve('@toon-format/toon')).href);
const { values, patterns } = JSON.parse(readFileSync('awx-input.json', 'utf8'));
for (const [index, value] of values) argv[index] = argv[index].split('=', 1)[0] + '=' + value;
const tokens = patterns.map(pattern => new RegExp(pattern, 'u'));
const secretField = ${secretFieldPattern};
const protocolFields = new Set(${JSON.stringify(protocolOutputFields)});
const redact = (value, key = '') => {
  if (protocolFields.has(key)) return value;
  if (secretField.test(key) && value !== null && typeof value !== 'boolean' && typeof value !== 'number') return null;
  if (typeof value === 'string') return tokens.some(pattern => pattern.test(value)) ? null : value;
  if (Array.isArray(value)) return value.map(child => redact(child));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, redact(child, name)]));
  return value;
};
const output = stream => ({ write(chunk) {
  stream.write(encode(redact(decode(String(chunk)))) + '\\n');
} });
const { main } = await import(pathToFileURL(require.resolve('awx-axi')).href);
await main({ argv, env: process.env, stdout: output(process.stdout), stderr: output(process.stderr) });
`

export function awxInputSecrets(input: RunnerInput, structured: readonly string[], args: readonly string[]): string[] {
  const secrets = new Set<string>()
  const credentialFile = (name: string) => args.some((arg, index) =>
    ['--password-file', '--inputs-file', '--credential-passwords-file'].includes(arg) && args[index + 1] === name)
  const contents = [...structured.map(content => ({ content, credential: false })),
    ...(input.stdin === undefined ? [] : [{ content: input.stdin, credential: true }]),
    ...(input.files ?? []).map(file => ({ content: Buffer.from(file.contentBase64, 'base64').toString('utf8'), credential: credentialFile(file.name) }))]
  const collect = (node: Parameters<typeof visit>[0]) => visit(node, { Scalar: (key, scalar) => {
    if (key !== 'key' && typeof scalar.value === 'string' && scalar.value.length) secrets.add(scalar.value)
  } })
  for (const { content, credential } of contents) {
    if (credential && content.length) secrets.add(content)
    if (credential && content.trim().length) secrets.add(content.trim())
    const document = parseDocument(content, { uniqueKeys: false })
    if (!document.errors.length) {
      if (credential) collect(document)
      else visit(document, { Pair: (_, pair) => {
        if (isScalar(pair.key) && typeof pair.key.value === 'string' && secretFieldPattern.test(pair.key.value) && isNode(pair.value)) collect(pair.value)
      } })
    }
  }
  return [...secrets]
}
