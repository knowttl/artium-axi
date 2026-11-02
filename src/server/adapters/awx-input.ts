import type { RunnerInput } from '../runner/input.js'
import { privateOutput, protocolOutputFields } from '../runner/scan.js'

const inputFields = {
  variables: 'variables', 'extra-vars': 'extra_vars', 'source-vars': 'source_vars',
  'module-args': 'module_args', args: 'module_args', 'inputs-file': 'inputs', 'password-file': 'password',
  'credential-passwords-file': 'credential_passwords', 'hosts-file': 'hosts',
  'configuration-file': 'notification_configuration', 'config-file': 'notification_configuration', 'messages-file': 'messages',
}

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
const { values, output: { fields, patterns } } = JSON.parse(readFileSync('awx-input.json', 'utf8'));
for (const [index, value] of values) argv[index] = argv[index].split('=', 1)[0] + '=' + value;
const tokens = patterns.map(([pattern, mask]) => [new RegExp(pattern, 'u'), mask]);
const masks = new Set([...Object.values(fields), ...patterns.map(([, mask]) => mask)]);
const protocolFields = new Set(${JSON.stringify(protocolOutputFields)});
const redact = (value, key = '', depth = 0) => {
  if ((depth > 1 || key === 'payload') && Object.hasOwn(fields, key)) return fields[key];
  if (protocolFields.has(key)) return value;
  if (typeof value === 'string' && !masks.has(value)) {
    const match = tokens.find(([pattern]) => pattern.test(value));
    if (match) return match[1];
  }
  if (Array.isArray(value)) return value.map(child => redact(child, '', depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, redact(child, name, depth + 1)]));
  return value;
};
const output = stream => ({ write(chunk) {
  stream.write(encode({ ...redact(decode(String(chunk))), input: fields }) + '\\n');
} });
const { main } = await import(pathToFileURL(require.resolve('awx-axi')).href);
await main({ argv, env: process.env, stdout: output(process.stdout), stderr: output(process.stderr) });
`

export function awxPrivateOutput(input: RunnerInput, structured: readonly (readonly [number, string])[], args: readonly string[]) {
  const inline = new Map(structured.map(([index, content]) => [args[index].slice(2).split('=', 1)[0], content]))
  return privateOutput(Object.entries(inputFields).flatMap(([flag, defaultField]) => {
    const field = flag === 'extra-vars' && args[0] === 'schedule' ? 'extra_data' : defaultField
    let content = inline.get(flag)
    if (content === undefined) {
      const index = args.indexOf(`--${flag}`)
      if (index === -1) return []
      const name = args[index + 1]
      const file = input.files?.find(file => file.name === name)
      content = name === '-' ? input.stdin : file && Buffer.from(file.contentBase64, 'base64').toString('utf8')
    }
    return content === undefined ? [] : [{ field, content }]
  }))
}
