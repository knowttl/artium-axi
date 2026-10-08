import { randomUUID } from 'node:crypto'
import { loginResponseSchema, meResponseSchema, runRequestSchema, runSuccessSchema, toolsResponseSchema, toolSchema } from '../shared/api.js'
import { ArtiumError, errorResponse } from '../shared/errors.js'
import { Client } from './http.js'
import { readPassword } from './password.js'

async function main(args: string[]) {
  const command = args[0]
  if (command === 'login' || command === 'passwd') {
    const remaining = args.slice(1)
    let stdin = false
    let username: string | undefined
    let invalid = false
    for (let index = 0; index < remaining.length; index++) {
      const option = remaining[index]
      if (option === '--username' && command === 'login' && username === undefined) username = remaining[++index]
      else if (option === '--password-stdin' && !stdin) stdin = true
      else invalid = true
    }
    if (invalid || (command === 'login' && !username)) {
      throw new ArtiumError('INVALID_INPUT', 'Invalid sign-in arguments. Password arguments are refused.',
        command === 'login' ? 'Use artium-axi login --username <username> --password-stdin.' : 'Use artium-axi passwd --password-stdin.')
    }
    const client = new Client()
    if (command === 'login') {
      const password = await readPassword(stdin, 'ARTIUM_AXI_PASSWORD')
      const session = await client.sessions.locked(async () => {
        const parsed = loginResponseSchema.safeParse(await client.request('/v1/auth/login', 'POST', { username, password }))
        if (!parsed.success) throw new ArtiumError('INVALID_RESPONSE')
        client.sessions.write(parsed.data)
        return parsed.data
      })
      if (session.status === 'password-change-required') throw new ArtiumError('PASSWORD_CHANGE_REQUIRED')
      process.stdout.write('status: authenticated\nnext: artium-axi tools\n')
    } else {
      await client.changePassword(async session => {
        const newPassword = await readPassword(stdin)
        const currentPassword = session.status === 'authenticated' ? await readPassword(false, 'ARTIUM_AXI_CURRENT_PASSWORD') : undefined
        return { newPassword, ...(currentPassword === undefined ? {} : { currentPassword }) }
      })
      process.stdout.write('status: password-changed\nnext: artium-axi login --username <username> --password-stdin\n')
    }
    return
  }
  if (command === 'logout') {
    if (args.length !== 1) throw new ArtiumError('INVALID_INPUT')
    const client = new Client()
    const verified = await client.sessions.locked(async () => {
      let session
      try { session = client.sessions.read() }
      catch { return false }
      finally { client.sessions.remove() }
      if (!session) return true
      if (session.status === 'password-change-required') return false
      try { await client.request('/v1/auth/logout', 'POST', undefined, session.refreshToken); return true }
      catch { return false }
    })
    process.stdout.write(`status: logged-out\nremoteRevocation: ${verified ? 'verified' : 'unverified'}\n`)
    if (!verified) process.stdout.write('next: Remote revocation is unverified. The local tokens were removed.\n')
    return
  }
  const listing = command === 'tools'
  const whoami = command === 'whoami'
  if (listing || whoami ? args.length !== 1 : !toolSchema.safeParse(command).success) throw new ArtiumError('INVALID_INPUT', 'Use artium-axi login, passwd, logout, whoami, tools or artium-axi <tool> <args>.')
  const input = listing || whoami ? undefined : runRequestSchema.parse({ args: args.slice(1) })
  const client = new Client()
  const result = await client.authenticated(whoami ? '/v1/me' : `/v1/tools${listing ? '' : `/${command}/run`}`, listing || whoami ? 'GET' : 'POST', input)
  if (whoami) {
    const parsed = meResponseSchema.safeParse(result)
    if (!parsed.success) throw new ArtiumError('INVALID_RESPONSE')
    const { username, roles, accessExpiresAt } = parsed.data
    process.stdout.write(`user: ${JSON.stringify(username)}\nserver: ${JSON.stringify(client.serverUrl)}\nroles[${roles.length}]: ${roles.map(role => JSON.stringify(role)).join(',')}\naccessExpiresAt: ${accessExpiresAt}\n`)
  } else if (listing) {
    const parsed = toolsResponseSchema.safeParse(result)
    if (!parsed.success) throw new ArtiumError('INVALID_RESPONSE')
    const tools = parsed.data.tools
    process.stdout.write(tools.length ? `tools[${tools.length}]{name,status,version}:\n${tools.map(tool => `  ${tool.name},${tool.status},${JSON.stringify(tool.version)}`).join('\n')}\n` : 'tools: 0 available\n')
  } else {
    const parsed = runSuccessSchema.safeParse(result)
    if (!parsed.success || parsed.data.source !== command) throw new ArtiumError('INVALID_RESPONSE')
    const { stdout, stderr, exitCode, truncated } = parsed.data
    if (truncated.stdout || truncated.stderr) process.stderr.write(`artium-axi: output truncated (${['stdout', 'stderr'].filter(stream => truncated[stream as keyof typeof truncated]).join(', ')}).\n`)
    process.stdout.write(stdout)
    process.stderr.write(stderr)
    process.exitCode = exitCode
  }
}

function printError(response: ReturnType<typeof errorResponse>) {
  process.stdout.write(`error:\n${Object.entries(response.error).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`).join('\n')}\n`)
  process.exitCode = ['INVALID_INPUT', 'UNSUPPORTED_INPUT', 'FLAG_BLOCKED', 'CLIENT_CONFIG_INVALID'].includes(response.error.code) ? 2 : 1
}

main(process.argv.slice(2)).catch(error => printError(errorResponse(error instanceof ArtiumError ? error : new ArtiumError('INVALID_INPUT'), randomUUID())))
