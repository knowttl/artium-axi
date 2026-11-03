import { z } from 'zod'

export const kubernetesHostedCommands = [
  'workspace create <directory>', 'workspace show <id>', 'workspace download <id> <path> --output <absolute-file>', 'workspace delete <id>',
  'session list', 'session start <kind> [--workspace <id>] [--stdin-file <file>] -- <native arguments>',
  'session show <id> [--wait]', 'session output <id> [--after <sequence>] [--wait]',
  'session confirm <id> --digest <exact-digest>', 'session cancel <id> --confirm',
  'session artifact <id> <path> --output <absolute-file>',
] as const

export const kubernetesSessionKind = z.enum(['watch', 'logs', 'exec', 'attach', 'apply', 'create', 'cp'])
export const kubernetesSessionPolicy = z.strictObject({
  grants: z.record(z.string().min(1).max(128), z.array(kubernetesSessionKind).max(7)),
  lifetimeSeconds: z.number().int().min(1).max(1800).optional(),
  outputBytes: z.number().int().min(1).max(1048576).optional(),
})
export const kubernetesWorkspacePath = z.string().min(1).max(1024).refine(path =>
  !/[\\:\x00-\x1f\x7f]/.test(path) && path.split('/').every(part =>
    part.length > 0 && part !== '.' && part !== '..' && !/[. ]$/.test(part)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
export const kubernetesFile = z.strictObject({ path: kubernetesWorkspacePath,
  bytes: z.number().int().min(0).max(100 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
export const kubernetesWorkspaceManifest = z.strictObject({ files: z.array(kubernetesFile).min(1).max(100),
  lifetimeSeconds: z.number().int().min(1).max(1800).default(300) })
export const kubernetesSessionStart = z.strictObject({ kind: kubernetesSessionKind,
  argv: z.array(z.string().max(8192)).min(1).max(256), workspace: z.uuid().optional(),
  stdinBase64: z.string().max(4 * Math.ceil(512 * 1024 / 3)).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).optional(),
  inputArtifact: z.strictObject({ workspace: z.uuid(), path: kubernetesWorkspacePath }).optional(),
  limits: z.strictObject({ lifetimeSeconds: z.number().int().min(1).max(1800).optional(),
    outputBytes: z.number().int().min(1).max(1048576).optional() }).default({}),
}).refine(input => input.stdinBase64 === undefined || input.inputArtifact === undefined)
