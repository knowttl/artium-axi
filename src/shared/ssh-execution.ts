import { z } from 'zod'

export const sshExecutionInput = z.object({ host: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  command: z.string().min(1).max(16384), confirm: z.literal(true),
  timeout: z.number().int().min(1).max(600).default(60),
  outputLimit: z.number().int().min(0).max(1048576).default(65536), sudo: z.boolean().default(false),
  connection: z.string().min(1).max(64).optional() }).strict()
export type SshExecutionInput = z.infer<typeof sshExecutionInput>
export const sshPreparation = z.object({ requestKey: z.string().min(1).max(4096), host: z.string() }).strict()
export const sshExecutionStatus = z.object({ id: z.string(), host: z.string(),
  outcome: z.enum(['running', 'completed', 'failed', 'cancelled', 'timed_out', 'unknown']),
  remoteExit: z.number().int().nullable(), remoteSignal: z.string().nullable(),
  termination: z.enum(['remote-exit', 'deadline', 'unknown']),
}).passthrough()

export function resolveSshManagedCommand(args: readonly string[]): string | undefined {
  let prefix = 0
  while (['--json', '--help'].includes(args[prefix])) prefix++
  const command = args[prefix] === 'exec' ? 'exec' : args.slice(prefix, prefix + 2).join(' ')
  return command === 'exec' || command.startsWith('execution ') || command.startsWith('connection ') ? command : undefined
}
