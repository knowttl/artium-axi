import { parseDocument, visit } from 'yaml'
import type { RunnerInput } from '../runner/input.js'

// Upstream's public main accepts argv in memory. Load private structured values
// there, so even tools which require inline JSON/YAML never receive it via exec.
export const awxInputBridge = `
const { readFileSync } = await import('node:fs');
const { pathToFileURL } = await import('node:url');
const { createRequire } = await import('node:module');
const executable = process.argv[1];
const argv = process.argv.slice(2);
const { values, patterns } = JSON.parse(readFileSync('awx-input.json', 'utf8'));
for (const [index, value] of values) argv[index] = value;
patterns.sort((a, b) => b.length - a.length);
const output = stream => ({ write(chunk) {
  let text = String(chunk);
  for (const pattern of patterns) text = text.replaceAll(pattern, '[redacted]');
  stream.write(text);
} });
const { main } = await import(pathToFileURL(createRequire(executable).resolve('awx-axi')).href);
await main({ argv, env: process.env, stdout: output(process.stdout), stderr: output(process.stderr) });
`

// Register both original bytes and parsed scalar values: upstream may echo one
// field, normalize whitespace, or serialize a nested value independently.
export function awxInputSecrets(input: RunnerInput, structured: readonly string[]): string[] {
  const secrets = new Set<string>()
  for (const content of [...structured, ...(input.stdin === undefined ? [] : [input.stdin]),
    ...(input.files ?? []).map(file => Buffer.from(file.contentBase64, 'base64').toString('utf8'))]) {
    if (content.length) secrets.add(content)
    if (content.trim().length) secrets.add(content.trim())
    const document = parseDocument(content, { uniqueKeys: false })
    if (!document.errors.length) {
      // Alias expansion is unnecessary for scanning and must remain bounded.
      visit(document, { Scalar: (key, node) => {
        if (key !== 'key' && typeof node.value === 'string' && node.value.length) secrets.add(node.value)
      } })
    }
  }
  return [...secrets]
}
