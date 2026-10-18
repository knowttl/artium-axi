import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { resolve, relative, sep, isAbsolute } from 'node:path'
import { loginResponseSchema, meResponseSchema, runSuccessSchema, toolsResponseSchema, toolSchema } from '../shared/api.js'
import { ArtiumError, errorResponse, errors } from '../shared/errors.js'
import { Client } from './http.js'
import { readPassword } from './password.js'
import { doctor } from './doctor.js'
import { commandHelp, helpCommand } from './help.js'
import { identityView, toolsView, toolView } from './views.js'
import { rewriteSuggestions } from './rewrite.js'
import { setup } from './setup.js'
import { toolInput } from './input.js'
import { ssoLogin } from './device.js'
import { cliVersion } from '../shared/version.js'
import { ManagedSession } from './managed-session.js'

let managed: ManagedSession | undefined
function output(stream: 'stdout' | 'stderr', text: string) {
  if (managed) managed.write(stream, text)
  else process[stream].write(text)
}

async function main(args: string[]) {
  const managedMode = args[0] === '--managed-session'
  if (managedMode) {
    args = args.slice(1)
    if (['passwd', 'logout', 'setup'].includes(args[0])) {
      throw new ArtiumError('INVALID_INPUT', 'This command is unavailable in managed session mode.',
        'The caller manages session persistence, password changes and revocation.')
    }
    managed = await ManagedSession.read(args[0] === 'login')
  }
  if (args.length === 1 && args[0] === '--version') {
    output('stdout', `${cliVersion}\n`)
    return
  }
  const prefixHelp = args[0] === '--help'
  if (prefixHelp) args = args.slice(1)
  const command = args[0]
  const help = helpCommand(prefixHelp ? [...args, '--help'] : args, prefixHelp)
  if (prefixHelp && !help) throw new ArtiumError('INVALID_INPUT', undefined, 'Use artium-axi --help for commands.')
  if (help) { output('stdout', commandHelp(help)); return }
  if (command === 'setup') { output('stdout', await setup(args.slice(1))); return }
  if (command === 'doctor') {
    if (args.length !== 1) throw new ArtiumError('INVALID_INPUT', undefined, 'Use artium-axi doctor.')
    if (managed) await doctor(deadline => new Client(process.env, managed, deadline), text => output('stdout', text))
    else await doctor()
    return
  }
  if (command === 'login' || command === 'passwd') {
    const remaining = args.slice(1)
    if (managed && process.env.ARTIUM_AXI_PASSWORD !== undefined) {
      throw new ArtiumError('INVALID_INPUT', 'Password environment values are refused in managed mode.',
        'Unset ARTIUM_AXI_PASSWORD; use --password-stdin for local sign-in or --sso.')
    }
    if (command === 'login' && remaining.length === 1 && remaining[0] === '--sso') {
      await ssoLogin(new Client(process.env, managed), managed)
      return
    }
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
        command === 'login' ? 'Use artium-axi login --sso or artium-axi login --username <username> --password-stdin.' : 'Use artium-axi passwd --password-stdin.')
    }
    const client = new Client(process.env, managed)
    if (command === 'login') {
      if (managed && !stdin) {
        throw new ArtiumError('INVALID_INPUT', 'Managed login requires protected password input.',
          'Use --password-stdin with inherited stdin; unset ARTIUM_AXI_PASSWORD. Password arguments and environment values are refused.')
      }
      const password = await readPassword(stdin, 'ARTIUM_AXI_PASSWORD')
      managed?.protect(password)
      const signIn = async () => {
        const parsed = loginResponseSchema.safeParse(await client.request('/v1/auth/login', 'POST', { username, password }))
        if (!parsed.success) throw new ArtiumError('INVALID_RESPONSE')
        if (managed) await managed.emit(client.serverUrl, parsed.data)
        else client.sessions.write(parsed.data)
        return parsed.data
      }
      const session = await (managed ? signIn() : client.sessions.locked(signIn))
      if (session.status === 'password-change-required') throw new ArtiumError('PASSWORD_CHANGE_REQUIRED')
      output('stdout', 'status: authenticated\nnext: artium-axi tools\n')
    } else {
      await client.changePassword(async session => {
        const newPassword = await readPassword(stdin)
        const currentPassword = session.status === 'authenticated' ? await readPassword(false, 'ARTIUM_AXI_CURRENT_PASSWORD') : undefined
        return { newPassword, ...(currentPassword === undefined ? {} : { currentPassword }) }
      })
      output('stdout', 'status: password-changed\nnext: artium-axi login --username <username> --password-stdin\n')
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
    output('stdout', `status: logged-out\nremoteRevocation: ${verified ? 'verified' : 'unverified'}\n`)
    if (!verified) output('stdout', 'next: Remote revocation is unverified. The local tokens were removed.\n')
    return
  }
  const home = args.length === 0
  const listing = command === 'tools'
  const whoami = command === 'whoami'
  const detail = listing && args[1] === 'show' && args.length === 3 && toolSchema.safeParse(args[2]).success
  if (!home && (listing || whoami ? !detail && args.length !== 1 : !toolSchema.safeParse(command).success)) {
    throw new ArtiumError('INVALID_INPUT', 'Unknown command, argument or flag.', 'Use artium-axi --help for commands or artium-axi <command> --help for valid flags.')
  }
  const input = home || listing || whoami ? undefined : await toolInput(command!, args.slice(1))
  const client = new Client(process.env, managed)
  const homeSession = home && !managed ? client.sessions.read() : undefined
  if (home && !managed && !homeSession) throw new ArtiumError('TOKEN_INVALID', undefined, 'Run artium-axi login --username <username> --password-stdin.')
  const result = await client.authenticated(home || whoami ? '/v1/me' : `/v1/tools${listing ? '' : `/${command}/run`}`, home || listing || whoami ? 'GET' : 'POST', input, homeSession)
  if (home || whoami) {
    const parsed = meResponseSchema.safeParse(result)
    if (!parsed.success) throw new ArtiumError('INVALID_RESPONSE')
    let view = identityView(parsed.data, client.serverUrl)
    if (home) {
      const tools = toolsResponseSchema.safeParse(await client.authenticated('/v1/tools', 'GET', undefined, homeSession))
      if (!tools.success) throw new ArtiumError('INVALID_RESPONSE')
      const executable = resolve(process.argv[1])
      const local = relative(homedir(), executable)
      const bin = local && !isAbsolute(local) && !local.startsWith(`..${sep}`) && local !== '..' ? `~${sep}${local}` : executable
      view = `bin: ${JSON.stringify(bin)}\ndescription: Run managed upstream tools through one local sign-in.\n${view}${toolsView(tools.data.tools)}`
    }
    output('stdout', view)
  } else if (listing) {
    const parsed = toolsResponseSchema.safeParse(result)
    if (!parsed.success) throw new ArtiumError('INVALID_RESPONSE')
    const tools = parsed.data.tools
    if (detail) {
      const tool = tools.find(tool => tool.name === args[2])
      if (!tool) throw new ArtiumError('TOOL_NOT_GRANTED', 'The tool is not available to your account.', 'Ask an administrator to check your role assignments and enabled tools.')
      output('stdout', toolView(tool))
    } else output('stdout', toolsView(tools))
  } else {
    const parsed = runSuccessSchema.safeParse(result)
    if (!parsed.success || parsed.data.source !== command) throw new ArtiumError('INVALID_RESPONSE')
    const { stdout, stderr, exitCode, truncated } = parsed.data
    if (truncated.stdout || truncated.stderr) output('stderr', `artium-axi: output truncated (${['stdout', 'stderr'].filter(stream => truncated[stream as keyof typeof truncated]).join(', ')}).\n`)
    output('stdout', rewriteSuggestions(stdout, command!, truncated.stdout))
    output('stderr', rewriteSuggestions(stderr, command!, truncated.stderr))
    process.exitCode = exitCode
  }
}

function printError(response: ReturnType<typeof errorResponse>) {
  output('stdout', `error:\n${Object.entries(response.error).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`).join('\n')}\n`)
  process.exitCode = errors[response.error.code].exitCode
}

main(process.argv.slice(2))
  .catch(error => printError(errorResponse(error instanceof ArtiumError ? error : new ArtiumError('INTERNAL_ERROR'), randomUUID())))
  .then(() => {
    try { managed?.flush() }
    catch {
      managed = undefined
      printError(errorResponse(new ArtiumError('SECRET_IN_OUTPUT'), randomUUID()))
    }
  })
