import { emitKeypressEvents } from 'node:readline'
import { ArtiumError } from '../shared/errors.js'

export async function readPassword(stdin: boolean, environmentVariable?: string): Promise<string> {
  if (stdin) {
    if (process.stdin.isTTY) throw new ArtiumError('INVALID_INPUT', 'Pipe the password to --password-stdin.')
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
  }
  if (environmentVariable && process.env[environmentVariable] !== undefined) return process.env[environmentVariable]!
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new ArtiumError('INVALID_INPUT', 'A password source is required.', 'Use --password-stdin or the documented password environment variable.')
  emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  try {
    return await new Promise<string>((resolve, reject) => {
      let password = ''
      const keypress = (text: string, key: { name?: string, ctrl?: boolean }) => {
        if (key.name === 'return' || (key.ctrl && key.name === 'c')) {
          process.stdin.off('keypress', keypress)
          if (key.ctrl) reject(new ArtiumError('CANCELLED'))
          else resolve(password)
        } else if (key.name === 'backspace') password = Array.from(password).slice(0, -1).join('')
        else if (text && !key.ctrl && !/\p{Cc}/u.test(text)) password += text
      }
      process.stdin.on('keypress', keypress)
      process.stderr.write(environmentVariable === 'ARTIUM_AXI_CURRENT_PASSWORD' ? 'Current password: ' : 'Password: ')
    })
  } finally { process.stdin.setRawMode(false); process.stdin.pause(); process.stderr.write('\n') }
}
