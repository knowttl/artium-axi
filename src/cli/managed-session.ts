import { fstatSync, writeSync } from 'node:fs'
import { Socket } from 'node:net'
import { z } from 'zod'
import { loginResponseSchema } from '../shared/api.js'
import { ArtiumError } from '../shared/errors.js'
import { SecretScanner } from '../server/runner/scan.js'

const sessionSchema = z.strictObject({
  serverUrl: z.string().url(), accessToken: z.string().min(1), refreshToken: z.string().min(1).optional(),
  status: z.literal('authenticated').optional(), accessExpiresAt: z.number().int().optional(), familyExpiresAt: z.number().int().optional(),
})

export class ManagedSession {
  private readonly secrets: string[]
  private readonly output = { stdout: '', stderr: '' }
  private constructor(private session: z.infer<typeof sessionSchema>, private readonly channel: Socket) {
    this.secrets = [session.accessToken, ...(session.refreshToken ? [session.refreshToken] : [])]
  }

  static async read(): Promise<ManagedSession> {
    try {
      for (const fd of [3, 4]) {
        const stat = fstatSync(fd)
        if (!stat.isFIFO() && !stat.isSocket()) throw new Error()
      }
      writeSync(4, Buffer.alloc(0))
      const input = new Socket({ fd: 3, readable: true, writable: false })
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of input) {
        bytes += chunk.length
        if (bytes > 64 * 1024) { input.destroy(); throw new Error() }
        chunks.push(chunk)
      }
      const session = sessionSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      const channel = new Socket({ fd: 4, readable: false, writable: true })
      // Errors are translated at the write boundary; never print raw channel errors.
      channel.on('error', () => {})
      return new ManagedSession(session, channel)
    } catch {
      throw new ArtiumError('INVALID_INPUT', 'Managed session input or private descriptors are invalid.',
        'Supply session JSON on inherited pipe fd 3 and a writable private pipe on fd 4; close fd 3 after sending JSON.')
    }
  }

  checkServer(serverUrl: string) {
    if (this.session.serverUrl.replace(/\/$/, '') !== serverUrl) throw new ArtiumError('SESSION_SERVER_MISMATCH')
  }

  async authenticated(request: (token: string) => Promise<unknown>, refresh: (token: string) => Promise<unknown>) {
    try { return await request(this.session.accessToken) }
    catch (error) {
      if (!(error instanceof ArtiumError) || error.code !== 'TOKEN_EXPIRED' || !this.session.refreshToken) throw error
    }
    const parsed = loginResponseSchema.safeParse(await refresh(this.session.refreshToken))
    if (!parsed.success || parsed.data.status !== 'authenticated' || !parsed.data.accessToken || !parsed.data.refreshToken) {
      throw new ArtiumError('INVALID_RESPONSE')
    }
    this.session = { serverUrl: this.session.serverUrl, ...parsed.data }
    this.secrets.push(parsed.data.accessToken, parsed.data.refreshToken)
    try {
      await new Promise<void>((resolve, reject) => {
        this.channel.write(`${JSON.stringify(this.session)}\n`, error => error ? reject(error) : resolve())
      })
    } catch {
      throw new ArtiumError('INVALID_INPUT', 'Managed session rotation could not be returned.',
        'Recover the session through the caller; do not retry using the old refresh token.')
    }
    return request(this.session.accessToken)
  }

  write(stream: 'stdout' | 'stderr', text: string) { this.output[stream] += text }

  flush() {
    this.channel.destroy()
    const scanner = new SecretScanner(this.secrets)
    if (scanner.scan('stdout', Buffer.from(this.output.stdout)) || scanner.scan('stderr', Buffer.from(this.output.stderr))) {
      throw new ArtiumError('SECRET_IN_OUTPUT')
    }
    process.stdout.write(this.output.stdout)
    process.stderr.write(this.output.stderr)
  }
}
