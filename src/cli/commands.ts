import { resolve } from 'node:path'
import { encode } from '@toon-format/toon'
import { instanceNameSchema, loginResponseSchema, meResponseSchema, runSuccessSchema, toolsResponseSchema, toolSchema, transferSelectionSchema, transferTool, transferWarningFor } from '../shared/api.js'
import { ArtiumError, errorResponse, errors } from '../shared/errors.js'
import { Client } from './http.js'
import { readPassword } from './password.js'
import { doctor } from './doctor.js'
import { commandHelp, delegatedDownloadHelp, helpCommand, validateArguments } from './help.js'
import { identityView, toolsView, toolView } from './views.js'
import { rewriteSuggestions } from './rewrite.js'
import { setup } from './setup.js'
import { toolInput } from './input.js'
import { proxmoxPrivateResult } from './proxmox-result.js'
import { proxmoxStream } from './proxmox-stream.js'
import { shodanSession } from './shodan-session.js'
import { shodanRadar } from './shodan-radar.js'
import { shodanScan } from './shodan-scan.js'
import { shodanExport } from './shodan-export.js'
import { shodanWrite } from './shodan-write.js'
import { resolveProxmoxStream } from '../shared/proxmox-commands.js'
import { ssoLogin } from './device.js'
import { cliVersion } from '../shared/version.js'
import { ManagedSession } from './managed-session.js'
import { update } from './update.js'
import { download } from './download.js'
import { sessionContext } from './session-context.js'
import { sshExecution } from './ssh.js'
import { kubernetesHosted } from './kubernetes.js'
import { kubernetesHostedRoutes, resolveKubernetesHostedCommand } from '../shared/kubernetes.js'
import { tokenCommand } from './token.js'
import { readStoredSession } from './session.js'

let managed: ManagedSession | undefined
let failureContext = 'main'
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error
  })
}
function output(stream: 'stdout' | 'stderr', text: string) {
  if (process[stream].destroyed) return
  if (managed) managed.write(stream, text)
  else process[stream].write(text)
}

function instanceErrorAdvice(error: unknown, instance: string | undefined): unknown {
  if (instance === undefined || !(error instanceof ArtiumError) || error.code !== 'INVALID_INPUT') return error
  return Object.assign(error, { next: `${error.next} If the server does not support --instance, upgrade it to a version that supports named tool instances.` })
}

async function resolveDiscoveryInstance(client: Client, tool: string, instance: string): Promise<boolean> {
  const response = await client.authenticated(`/v1/tools/${tool}/run`, 'POST', { args: ['--help'], instance })
    .catch(error => { throw instanceErrorAdvice(error, instance) })
  const parsed = runSuccessSchema.safeParse(response)
  if (!parsed.success || parsed.data.source !== tool) throw new ArtiumError('INVALID_RESPONSE')
  if (parsed.data.exitCode === 0) return true
  output('stdout', parsed.data.stdout)
  output('stderr', parsed.data.stderr)
  process.exitCode = parsed.data.exitCode
  return false
}

async function main(args: string[]) {
  const instanceAt = args[0] === '--managed-session' ? 1 : 0
  let instance: string | undefined
  if (args[instanceAt] === '--instance') {
    const parsed = instanceNameSchema.safeParse(args[instanceAt + 1])
    if (!parsed.success) throw new ArtiumError('INVALID_INPUT', 'Expected --instance <name> before the tool name.', 'Use artium-axi --instance <name> <tool> <args>.')
    instance = parsed.data
    args = [...args.slice(0, instanceAt), ...args.slice(instanceAt + 2)]
  }
  if (args.length === 2 && args.includes('--managed-session') && args.includes('--help')) {
    output('stdout', commandHelp('managed-session'))
    return
  }
  const localArgs = args[0] === '--managed-session' ? args.slice(1) : args
  validateArguments(localArgs[0] === '--help' ? localArgs.slice(1) : localArgs, localArgs[0] === '--help')
  const managedMode = args[0] === '--managed-session'
  if (managedMode) args = args.slice(1)
  const kubernetesGroup = args.slice(1).find(arg => arg !== '--json')
  if (instance !== undefined && (!toolSchema.safeParse(args[0]).success || args[0] === 'ssh-axi'
    || args[0] === 'proxmox-axi' && args[1] === 'result'
    || args[0] === 'kubernetes-axi' && ['tunnel', 'credential'].includes(kubernetesGroup ?? '')
    || args[0] === 'shodan-axi' && args[1] === 'radar')) {
    throw new ArtiumError('INVALID_INPUT', '--instance applies only to tool runs that support named instances.', 'Run the command without --instance.')
  }
  if (args.length === 1 && ['--version', '-v', '-V'].includes(args[0])) {
    output('stdout', `${cliVersion}\n`)
    return
  }
  const prefixHelp = args[0] === '--help'
  if (prefixHelp) args = args.slice(1)
  const command = args[0]
  const help = helpCommand(prefixHelp ? [...args, '--help'] : args, prefixHelp)
  if (prefixHelp && !help) throw new ArtiumError('INVALID_INPUT', undefined, 'Use artium-axi --help for commands.')
  if (command === 'shodan-axi' && args[1] === 'radar' && args.some(arg => ['--help', '-h'].includes(arg))) {
    await shodanRadar(['radar', '--help'], () => new Client(process.env, managed), output)
    return
  }
  if (command === 'shodan-axi' && args[1] === 'scan' && args[2] === 'submit' && args.some(arg => ['--help', '-h'].includes(arg))) {
    await shodanScan(['scan', 'submit', '--help'], () => new Client(process.env, managed), output)
    return
  }
  if (command === 'shodan-axi' && (args[1] === 'download' || args[1] === 'alert' && args[2] === 'download') && args.some(arg => ['--help', '-h'].includes(arg))) {
    await shodanExport([...args.slice(1, args[1] === 'alert' ? 3 : 2), '--help'], () => new Client(process.env, managed), output)
    return
  }
  if (command === 'shodan-axi' && args.some(arg => ['--help', '-h'].includes(arg))
    && await shodanWrite(args.slice(1), () => new Client(process.env, managed), output)) return
  const toolWords = args.slice(1).filter(arg => !['--json', '--full', '--help', '-h'].includes(arg))
  const toolDiscovery = toolSchema.safeParse(command).success && (prefixHelp || toolWords.length === 0
    || args.slice(1).some(arg => ['--help', '-h'].includes(arg)) || toolWords[0] === 'help'
    || toolWords.length === 1 && ['commands', 'home'].includes(toolWords[0]))
  const scopedHelp = toolDiscovery || help && ['home', 'tools', 'tools show', 'download'].includes(help)
  if (help && !scopedHelp) { output('stdout', commandHelp(help)); return }
  if (managedMode) {
    if (['passwd', 'logout', 'setup', 'update', 'session-context'].includes(args[0])) {
      throw new ArtiumError('INVALID_INPUT', 'This command is unavailable in managed session mode.',
        'The caller manages session persistence, password changes and revocation.')
    }
    try { managed = await ManagedSession.read(args[0] === 'login') }
    catch (error) {
      if (help !== 'download' || !(error instanceof ArtiumError) || error.code !== 'INVALID_INPUT') throw error
      output('stdout', commandHelp(help))
      return
    }
  }
  if (scopedHelp && (managed || readStoredSession()?.session.delegated)) {
    const client = new Client(process.env, managed)
    const delegated = managed
      ? 'delegation' in meResponseSchema.parse(await client.authenticated('/v1/me', 'GET'))
      : client.sessions.read()?.delegated
    if (delegated) {
      const { tools } = toolsResponseSchema.parse(await client.authenticated('/v1/tools', 'GET'))
      if (tools.some(tool => tool.commands === undefined)) throw new ArtiumError('INVALID_RESPONSE')
      const downloadOperation = toolDiscovery ? transferSelectionSchema.options.map(option => option.shape.operation.value)
        .find(operation => transferTool(operation) === command
          && operation === (toolWords[0] === 'help' ? toolWords.slice(1) : toolWords).join(' ')) : undefined
      if (instance !== undefined && toolDiscovery && (downloadOperation || toolWords.length === 0
        || toolWords.length === 1 && ['commands', 'home', 'help'].includes(toolWords[0]))) {
        if (!await resolveDiscoveryInstance(client, command, instance)) return
      }
      if (help === 'download' || downloadOperation) {
        const operations = transferSelectionSchema.options.map(option => option.shape.operation.value)
          .filter(operation => tools.some(tool => tool.name === transferTool(operation) && tool.commands?.includes(operation)))
        if (downloadOperation && !operations.includes(downloadOperation)) throw new ArtiumError('DELEGATED_SCOPE_DENIED')
        output('stdout', delegatedDownloadHelp(operations))
        return
      }
      const name = toolDiscovery ? command : help === 'tools show' ? args.slice(2).find(arg => toolSchema.safeParse(arg).success) : undefined
      if (name) {
        const tool = tools.find(tool => tool.name === name)
        if (toolDiscovery && !prefixHelp && toolWords.length > 0 && !(toolWords.length === 1 && ['commands', 'home', 'help'].includes(toolWords[0]))) {
          const hostedArgs = args.slice(1).map(arg => arg === '-h' ? '--help' : arg)
          if (name === 'proxmox-axi' && hostedArgs[0] === 'result') {
            if (!tool?.commands?.includes('result take')) throw new ArtiumError('DELEGATED_SCOPE_DENIED')
            await proxmoxPrivateResult(() => client, hostedArgs, text => output('stdout', text))
            return
          }
          if (name === 'proxmox-axi' && hostedArgs[0] === 'stream') {
            if (!tool) throw new ArtiumError('DELEGATED_SCOPE_DENIED')
            const stream = resolveProxmoxStream(hostedArgs)
            if (stream.separator < 0 && stream.options.includes('--help')) {
              if (stream.options.includes('limits') && !tool.commands?.includes('stream limits')) throw new ArtiumError('DELEGATED_SCOPE_DENIED')
              output('stdout', toolView({ ...tool, commands: tool.commands?.filter(command => command === 'stream limits' || /^(transfer|duplex) /.test(command)) }))
              return
            }
            if (!stream.route || !tool.commands?.includes(stream.route.command)) throw new ArtiumError('DELEGATED_SCOPE_DENIED')
            await proxmoxStream(() => client, hostedArgs, output, instance)
            return
          }
          const hosted = name === 'kubernetes-axi' ? resolveKubernetesHostedCommand(hostedArgs) : undefined
          if (hosted && kubernetesHostedRoutes.some(route => route.command === hosted)) {
            if (!tool?.commands?.includes(hosted)) throw new ArtiumError('DELEGATED_SCOPE_DENIED')
            await kubernetesHosted(hostedArgs, () => client, (text, stream = 'stdout') => output(stream, text), tool.commands, instance)
            return
          }
          const response = await client.authenticated(`/v1/tools/${name}/run`, 'POST', { args: args.slice(1), ...(instance === undefined ? {} : { instance }) })
            .catch(error => { throw instanceErrorAdvice(error, instance) })
          const parsed = runSuccessSchema.safeParse(response)
          if (!parsed.success || parsed.data.source !== name) throw new ArtiumError('INVALID_RESPONSE')
          const { truncated } = parsed.data
          if (truncated.stdout || truncated.stderr) output('stderr', `artium-axi: output truncated (${['stdout', 'stderr'].filter(stream => truncated[stream as keyof typeof truncated]).join(', ')}).\n`)
          output('stdout', parsed.data.stdout)
          output('stderr', parsed.data.stderr)
          if (parsed.data.exitCode !== 0 && client.requestId) output('stderr', `${parsed.data.stderr && !parsed.data.stderr.endsWith('\n') ? '\n' : ''}artium-axi: request_id ${client.requestId}\n`)
          process.exitCode = parsed.data.exitCode
          return
        }
        if (!tool) throw new ArtiumError('TOOL_NOT_GRANTED')
        output('stdout', args.includes('--json') ? JSON.stringify({ tool: tool.name, commands: tool.commands }) + '\n' : toolView(tool))
      } else output('stdout', toolsView(tools))
      return
    }
  }
  if (help) { output('stdout', commandHelp(help)); return }
  if (args.length === 0) {
    const bin = resolve(process.argv[1])
    output('stdout', `bin: ${JSON.stringify(bin)}\ndescription: Run managed upstream tools through one local sign-in.\n`)
  }
  if (command === 'session-context') { output('stdout', await sessionContext()); return }
  if (command === 'update') { output('stdout', await update()); return }
  if (command === 'download') { await download(args.slice(1), text => output('stdout', text), managed); return }
  if (command === 'token') { await tokenCommand(args.slice(1), text => output('stdout', text), managed); return }
  if (command === 'setup') { output('stdout', await setup(args.slice(1))); return }
  if (command === 'doctor') {
    if (args.length !== 1) throw new ArtiumError('INVALID_INPUT', undefined, 'Use artium-axi doctor.')
    if (managed) await doctor(deadline => new Client(process.env, managed, deadline), text => output('stdout', text))
    else await doctor()
    return
  }
  if (command === 'login' || command === 'passwd') {
    const remaining = args.slice(1)
    if (command === 'login' && (remaining.length === 1 && remaining[0] === '--token-stdin' || remaining.length === 0 && process.env.ARTIUM_AXI_TOKEN !== undefined)) {
      if (managed && process.env.ARTIUM_AXI_TOKEN !== undefined) throw new ArtiumError('INVALID_INPUT', 'Token environment values are refused in managed mode.')
      const client = new Client(process.env, managed)
      const signIn = async () => {
        if (!managed) {
          const current = client.sessions.read()
          if (current && !current.delegated) throw new ArtiumError('INVALID_INPUT', 'A full session already exists in this configuration directory.', 'Use a separate XDG_CONFIG_HOME for the delegated session.')
        }
        const token = remaining.length ? await readPassword(true) : process.env.ARTIUM_AXI_TOKEN!
        if (!/^artd_[A-Za-z0-9_-]{43}$/.test(token)) throw new ArtiumError('INVALID_INPUT')
        managed?.protect(token)
        const result = loginResponseSchema.safeParse(await client.request('/v1/auth/delegated', 'POST', { token }))
        if (!result.success || result.data.status !== 'authenticated') throw new ArtiumError('INVALID_RESPONSE')
        if (managed) await managed.emit(client.serverUrl, result.data)
        else { client.sessions.write(result.data, undefined, true); client.sessions.writeClientConfig(client.caFile) }
      }
      if (managed) await signIn(); else await client.sessions.locked(signIn)
      output('stdout', 'status: authenticated\nnext: artium-axi tools\n')
      return
    }
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
        else {
          client.sessions.write(parsed.data)
          client.sessions.writeClientConfig(client.caFile)
        }
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
  if (command === 'ssh-axi' && await sshExecution(args.slice(1), () => new Client(process.env, managed), text => output('stdout', text))) return
  if (command === 'kubernetes-axi' && instance !== undefined && args.slice(1).includes('--help')
    && args.slice(1).every(arg => ['--help', '--json'].includes(arg))
    && !await resolveDiscoveryInstance(new Client(process.env, managed), command, instance)) return
  if (command === 'kubernetes-axi' && await kubernetesHosted(args.slice(1), () => new Client(process.env, managed), (text, stream = 'stdout') => output(stream, text), undefined, instance)) return
  if (command === 'proxmox-axi' && await proxmoxPrivateResult(() => new Client(process.env, managed), args.slice(1), text => output('stdout', text))) return
  if (command === 'proxmox-axi' && await proxmoxStream(() => new Client(process.env, managed), args.slice(1), output, instance)) return
  if (command === 'shodan-axi' && await shodanSession(args.slice(1), () => new Client(process.env, managed), output, instance)
    .catch(error => { throw instanceErrorAdvice(error, instance) })) return
  if (command === 'shodan-axi' && await shodanRadar(args.slice(1), () => new Client(process.env, managed), output)) return
  if (command === 'shodan-axi' && await shodanScan(args.slice(1), () => new Client(process.env, managed), output, instance)
    .catch(error => { throw instanceErrorAdvice(error, instance) })) return
  if (command === 'shodan-axi' && await shodanExport(args.slice(1), () => new Client(process.env, managed), output, instance, managed)
    .catch(error => { throw instanceErrorAdvice(error, instance) })) return
  if (command === 'shodan-axi' && await shodanWrite(args.slice(1), () => new Client(process.env, managed), output, instance)
    .catch(error => { throw instanceErrorAdvice(error, instance) })) return
  const input = home || listing || whoami ? undefined : { ...await toolInput(command!, args.slice(1)), ...(instance === undefined ? {} : { instance }) }
  const client = new Client(process.env, managed)
  const homeSession = home && !managed ? client.sessions.read() : undefined
  if (home && !managed && !homeSession) throw new ArtiumError('TOKEN_INVALID', undefined, 'Run artium-axi login --username <username> --password-stdin.')
  const [result, homeTools] = (await Promise.allSettled([
    client.authenticated(home || whoami ? '/v1/me' : `/v1/tools${listing ? '' : `/${command}/run`}`, home || listing || whoami ? 'GET' : 'POST', input, homeSession),
    home ? client.authenticated('/v1/tools', 'GET', undefined, homeSession) : undefined,
  ])).map(response => {
    if (response.status === 'rejected') throw instanceErrorAdvice(response.reason, instance)
    return response.value
  })
  if (home || whoami) {
    const parsed = meResponseSchema.safeParse(result)
    if (!parsed.success) throw new ArtiumError('INVALID_RESPONSE')
    let view = identityView(parsed.data, client.serverUrl)
    if (home) {
      const tools = toolsResponseSchema.safeParse(homeTools)
      if (!tools.success) throw new ArtiumError('INVALID_RESPONSE')
      view += toolsView(tools.data.tools)
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
    failureContext = 'rewriteSuggestions'
    const forwarded = args.slice(1)
    const firstFlag = forwarded.findIndex(arg => arg.startsWith('-'))
    const invocation = command === 'unifi-axi' || command === 'proxmox-axi'
      ? { command: forwarded.slice(0, firstFlag < 0 ? forwarded.length : firstFlag).join(' ') || 'home', help: forwarded.includes('--help') }
      : undefined
    output('stdout', rewriteSuggestions(stdout, command!, truncated.stdout, invocation))
    output('stderr', rewriteSuggestions(stderr, command!, truncated.stderr, invocation))
    if (exitCode !== 0 && client.requestId) output('stderr', `${stderr && !stderr.endsWith('\n') ? '\n' : ''}artium-axi: request_id ${client.requestId}\n`)
    process.exitCode = exitCode
  }
}

function printError(error: unknown) {
  // Never serialize exception messages, names or stacks: they may contain input or credentials.
  const errorClass = error instanceof TypeError ? 'TypeError' : error instanceof SyntaxError ? 'SyntaxError'
    : error instanceof RangeError ? 'RangeError' : error instanceof ReferenceError ? 'ReferenceError'
    : error instanceof URIError ? 'URIError' : error instanceof EvalError ? 'EvalError'
    : error instanceof Error ? 'Error' : 'NonError'
  const response = errorResponse(error instanceof ArtiumError ? error : new ArtiumError('INTERNAL_ERROR',
    `The CLI failed locally (${errorClass} in ${failureContext}).`,
    'Report the error class and function to the CLI maintainer. Check the previous call outcome before retrying.'), '')
  if (process.argv[2] === 'download' || process.argv[2] === '--managed-session' && process.argv[3] === 'download') {
    output('stdout', `warning: ${JSON.stringify(transferWarningFor(process.argv[process.argv.indexOf('--operation') + 1] ?? ''))}\n`)
  }
  output('stdout', `error:\n${Object.entries(response.error).filter(([key, value]) => key !== 'requestId' || value)
    .map(([key, value]) => key === 'recovery'
      ? `  recovery:\n${encode(value).split('\n').map(line => '    ' + line).join('\n')}`
      : `  ${key}: ${JSON.stringify(value)}`).join('\n')}\n`)
  process.exitCode = errors[response.error.code].exitCode
}

main(process.argv.slice(2))
  .catch(printError)
  .then(() => {
    try { managed?.flush() }
    catch {
      managed = undefined
      printError(new ArtiumError('SECRET_IN_OUTPUT'))
    }
  })
