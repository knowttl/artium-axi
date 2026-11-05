import type { RunnerInput } from '../runner/input.js'

type Route = { command: string, effect?: string, canonicalCommand?: string }

// Parsing failures cannot grant read access, even if a command resembles a known one.
export function classifyCommand(
  routes: readonly Route[],
  resolve: (args: readonly string[], input?: RunnerInput) => { command: string, help?: boolean },
  args: readonly string[],
  input?: RunnerInput,
): { command: string, effect: 'read' | 'write' } {
  const exact = routes.find(item => item.command === args.join(' '))
  if (exact) return { command: exact.canonicalCommand ?? (exact.command || 'home'),
    effect: exact.effect === 'read' || exact.effect === 'local' ? 'read' : 'write' }
  let invocation: { command: string, help?: boolean }
  try { invocation = resolve(args, input) }
  catch { return { command: 'unknown', effect: 'write' } }
  const { command, help } = invocation
  const route = routes.find(item => (item.canonicalCommand ?? (item.command || 'home')) === command)
  const informational = !route && (command === 'version' && args.length === 1 && ['--version', '-v', '-V'].includes(args[0])
    || help && (command === 'home' || command === 'help' || routes.some(item => item.command.startsWith(command + ' '))))
  return { command, effect: informational || route && (route.effect === 'read' || route.effect === 'local') ? 'read' : 'write' }
}
