import type { RunnerInput } from '../runner/input.js'
import { privateOutput, protocolOutputFields } from '../runner/scan.js'

const inputFields = {
  variables: 'variables', 'extra-vars': 'extra_vars', 'source-vars': 'source_vars',
  'module-args': 'module_args', args: 'module_args', 'inputs-file': 'inputs', 'password-file': 'password',
  'credential-passwords-file': 'credential_passwords', 'hosts-file': 'hosts',
  'configuration-file': 'notification_configuration', 'config-file': 'notification_configuration', 'messages-file': 'messages', 'scm-url': 'scm_url',
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
const awxModule = require.resolve('awx-axi');
const { decode, encode } = await import(pathToFileURL(require.resolve('@toon-format/toon')).href);
const { parse } = await import(pathToFileURL(createRequire(awxModule).resolve('yaml')).href);
const { redactValue } = await import(new URL('./core/redact.js', pathToFileURL(awxModule)).href);
const { values, output: { fields, patterns } } = JSON.parse(readFileSync('awx-input.json', 'utf8'));
const rawOutput = ['job', 'ad-hoc'].includes(argv[0]) && argv[1] === 'stdout';
for (const [index, value] of values) {
  const flag = argv[index].split('=', 1)[0];
  let content = value;
  // Pinned upstream advertises YAML extra vars but its parser accepts only JSON.
  if (flag === '--extra-vars') {
    try {
      const parsed = parse(value);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) content = JSON.stringify(parsed);
    } catch { /* Leave invalid input for upstream validation. */ }
  }
  argv[index] = flag + '=' + content;
}
const tokens = patterns.map(([pattern, mask]) => [new RegExp(pattern, 'u'), mask]);
const masks = new Set([...Object.values(fields), ...patterns.map(([, mask]) => mask)]);
const protocolFields = new Set(${JSON.stringify(protocolOutputFields)});
const redact = (value, key = '', depth = 0) => {
  if ((depth > 1 || key === 'payload') && Object.hasOwn(fields, key)) return fields[key];
  if (depth > 1 && key === 'changes' && typeof value === 'string') {
    try { return JSON.stringify(redact(JSON.parse(value), '', depth + 1)); } catch { return '[activity changes redacted]'; }
  }
  if (depth > 1 && ['variables', 'source_vars'].includes(key) && typeof value === 'string') {
    try { return redactValue(parse(value)); } catch { return '***'; }
  }
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
  if (rawOutput) {
    stream.write(String(chunk));
    return;
  }
  stream.write(encode({ ...redact(decode(String(chunk))), input: fields }) + '\\n');
} });
const { main } = await import(pathToFileURL(awxModule).href);
const { createTransport } = await import(new URL('./core/auth.js', pathToFileURL(awxModule)).href);
await main({ argv, env: process.env, stdout: output(process.stdout), stderr: output(process.stderr),
  ...(rawOutput ? { createTransport(env, signal, diagnostics) {
    const transport = createTransport(env, {}, undefined, signal, diagnostics);
    const getText = transport.getText.bind(transport);
    transport.getText = async (...args) => {
      const projects = await transport.getPaged('projects/', {}, null);
      const secrets = new Set();
      for (const project of projects.rows) {
        if (!URL.canParse(project.scm_url)) continue;
        const url = new URL(project.scm_url);
        const values = [decodeURIComponent(url.username), decodeURIComponent(url.password), ...url.searchParams.values(), decodeURIComponent(url.hash.slice(1)), ...new URLSearchParams(url.hash.slice(1)).values()];
        for (const value of values.filter(Boolean)) {
          for (const form of [value, encodeURIComponent(value), new URLSearchParams({ v: value }).toString().slice(2), JSON.stringify(value).slice(1, -1)]) secrets.add(form);
        }
      }
      const result = await getText(...args);
      let content = result.content;
      for (const secret of [...secrets].sort((a, b) => b.length - a.length)) content = content.replaceAll(secret, '***');
      return { ...result, content };
    };
    return transport;
  } } : {}) });
`

export function awxPrivateOutput(input: RunnerInput, structured: readonly (readonly [number, string])[], args: readonly string[]) {
  const inline = new Map(structured.map(([index, content]) => [args[index].slice(2).split('=', 1)[0], content]))
  const output = privateOutput(Object.entries(inputFields).flatMap(([flag, defaultField]) => {
    const field = flag === 'extra-vars' && (args[0] === 'schedule' || args[0] === 'workflow' && ['node-create', 'node-edit'].includes(args[1]))
      ? 'extra_data' : defaultField
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
  output.fields.scm_url = '[SCM URL redacted]'
  if (inline.has('scm-url')) delete output.fields.payload
  return output
}
