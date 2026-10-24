import { fstatSync, writeSync } from 'node:fs'
import { Socket } from 'node:net'
import { z } from 'zod'
import { loginResponseSchema } from '../shared/api.js'
import type { LoginResponse } from '../shared/api.js'
import { ArtiumError } from '../shared/errors.js'
import { SecretScanner } from '../server/runner/scan.js'

const sessionSchema = z.strictObject({
  serverUrl: z.string().url(), accessToken: z.string().min(1), refreshToken: z.string().min(1).optional(),
  status: z.literal('authenticated').optional(), accessExpiresAt: z.number().int().optional(), familyExpiresAt: z.number().int().optional(),
})

export class ManagedSession {
  private readonly secrets: string[] = []
  private readonly output = { stdout: '', stderr: '' }
  private constructor(private readonly channel: Socket, private session?: z.infer<typeof sessionSchema>) {
    if (session) this.protect(session.accessToken, ...(session.refreshToken ? [session.refreshToken] : []))
  }

  static async read(signIn = false): Promise<ManagedSession> {
    try {
      for (const fd of signIn ? [4] : [3, 4]) {
        const stat = fstatSync(fd)
        if (!stat.isFIFO() && !stat.isSocket()) throw new Error()
      }
      writeSync(4, Buffer.alloc(0))
      let session: z.infer<typeof sessionSchema> | undefined
      if (!signIn) {
        const input = new Socket({ fd: 3, readable: true, writable: false })
        const chunks: Buffer[] = []
        let bytes = 0
        for await (const chunk of input) {
          bytes += chunk.length
          if (bytes > 64 * 1024) { input.destroy(); throw new Error() }
          chunks.push(chunk)
        }
        session = sessionSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      }
      const channel = new Socket({ fd: 4, readable: false, writable: true })
      // Errors are translated at the write boundary; never print raw channel errors.
      channel.on('error', () => {})
      return new ManagedSession(channel, session)
    } catch {
      throw new ArtiumError('INVALID_INPUT', 'Managed session input or private descriptors are invalid.',
        signIn ? 'Supply a writable private pipe on fd 4 for the new session.' :
          'Supply session JSON on inherited pipe fd 3 and a writable private pipe on fd 4; close fd 3 after sending JSON.')
    }
  }

  checkServer(serverUrl: string) {
    if (this.session && this.session.serverUrl.replace(/\/$/, '') !== serverUrl) throw new ArtiumError('SESSION_SERVER_MISMATCH')
  }

  async once<T>(request: (token: string) => Promise<T>): Promise<T> {
    if (!this.session) throw new ArtiumError('TOKEN_INVALID')
    return request(this.session.accessToken)
  }

  async authenticated(request: (token: string) => Promise<unknown>, refresh: (token: string) => Promise<unknown>) {
    if (!this.session) throw new ArtiumError('TOKEN_INVALID')
    try { return await request(this.session.accessToken) }
    catch (error) {
      if (!(error instanceof ArtiumError) || error.code !== 'TOKEN_EXPIRED' || !this.session.refreshToken) throw error
    }
    const parsed = loginResponseSchema.safeParse(await refresh(this.session.refreshToken))
    if (!parsed.success || parsed.data.status !== 'authenticated' || !parsed.data.accessToken || !parsed.data.refreshToken) {
      throw new ArtiumError('INVALID_RESPONSE')
    }
    await this.emit(this.session.serverUrl, parsed.data)
    this.session = { serverUrl: this.session.serverUrl, ...parsed.data }
    return request(this.session.accessToken)
  }

  protect(...secrets: string[]) { this.secrets.push(...secrets.filter(secret => secret.length > 0)) }

  async emit(serverUrl: string, session: LoginResponse) {
    if (session.status === 'authenticated') this.protect(session.accessToken, session.refreshToken)
    else this.protect(session.passwordChangeToken)
    try {
      await new Promise<void>((resolve, reject) => {
        this.channel.write(`${JSON.stringify({ serverUrl, ...session })}\n`, error => error ? reject(error) : resolve())
      })
    } catch {
      throw new ArtiumError('INVALID_INPUT', 'Managed session could not be returned.',
        'Recover the session through the caller; do not reuse a consumed refresh token.')
    }
  }

  write(stream: 'stdout' | 'stderr', text: string) { this.output[stream] += text }

  // Identity approval and pre-execution notices must reach the caller before
  // the pending operation. Tool output retains the buffered flush contract.
  notice(text: string) {
    if (new SecretScanner(this.secrets).scan('stdout', Buffer.from(text))) throw new ArtiumError('SECRET_IN_OUTPUT')
    process.stdout.write(text)
  }

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
