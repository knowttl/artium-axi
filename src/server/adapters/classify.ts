import type { RunnerInput } from '../runner/input.js'

type Route = { command: string, effect?: string, canonicalCommand?: string }

// Parsing failures cannot grant read access, even if a command resembles a known one.
export function classifyCommand(
  routes: readonly Route[],
  resolve: (args: readonly string[], input?: RunnerInput) => string,
  args: readonly string[],
  input?: RunnerInput,
): { command: string, effect: 'read' | 'write' } {
  let command: string
  try { command = resolve(args, input) }
  catch { return { command: args.join(' '), effect: 'write' } }
  const route = routes.find(item => (item.canonicalCommand ?? item.command) === command)
  return { command, effect: route && (route.effect === 'read' || route.effect === 'local') ? 'read' : 'write' }
}
