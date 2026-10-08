import { readFileSync, statSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { rootCertificates } from 'node:tls'
import { randomUUID } from 'node:crypto'
import { errorResponseSchema, runRequestSchema, runSuccessSchema, toolsResponseSchema, toolSchema } from '../shared/api.js'
import { ArtiumError, errorResponse } from '../shared/errors.js'

async function main(args: string[]) {
  const listing = args[0] === 'tools'
  if (listing ? args.length !== 1 : !toolSchema.safeParse(args[0]).success) throw new ArtiumError('INVALID_INPUT', 'Use artium-axi tools or artium-axi <tool> <args>.')
  const body = listing ? undefined : JSON.stringify(runRequestSchema.parse({ args: args.slice(1) }))
  let url: URL
  let token: string
  let ca: string[] | undefined
  try {
    url = new URL(process.env.ARTIUM_AXI_URL!)
    if (url.username || url.password || url.href.includes('?') || url.href.includes('#') ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && process.env.ARTIUM_AXI_TEST_HTTP === '1' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error()
    const file = process.env.ARTIUM_AXI_DEV_TOKEN_FILE!
    const stat = statSync(file)
    if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error()
    token = readFileSync(file, 'utf8').trim()
    if (!token || /\s/.test(token)) throw new Error()
    if (process.env.ARTIUM_AXI_CA_FILE) ca = [...rootCertificates, readFileSync(process.env.ARTIUM_AXI_CA_FILE, 'utf8')]
  } catch { throw new ArtiumError('CLIENT_CONFIG_INVALID') }
  url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/tools${listing ? '' : `/${args[0]}/run`}`
  const result = await new Promise<{ status: number, body: unknown }>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: listing ? 'GET' : 'POST', ca,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    }, response => {
      if (response.statusCode! >= 300 && response.statusCode! < 400) {
        response.resume()
        reject(new ArtiumError('INVALID_RESPONSE', 'Authenticated redirects are refused.'))
        return
      }
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('error', () => reject(new ArtiumError('SERVER_UNAVAILABLE')))
      response.on('end', () => {
        try { resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }) }
        catch { reject(new ArtiumError('INVALID_RESPONSE')) }
      })
    })
    request.on('error', () => reject(new ArtiumError('SERVER_UNAVAILABLE')))
    request.end(body)
  })
  const failure = errorResponseSchema.safeParse(result.body)
  if (failure.success) {
    printError(failure.data)
    return
  }
  if (result.status !== 200) throw new ArtiumError('INVALID_RESPONSE')
  if (listing) {
    const parsed = toolsResponseSchema.safeParse(result.body)
    if (!parsed.success) throw new ArtiumError('INVALID_RESPONSE')
    const tools = parsed.data.tools
    process.stdout.write(tools.length ? `tools[${tools.length}]{name,status,version}:\n${tools.map(tool => `  ${tool.name},${tool.status},${JSON.stringify(tool.version)}`).join('\n')}\n` : 'tools: 0 available\n')
  } else {
    const parsed = runSuccessSchema.safeParse(result.body)
    if (!parsed.success || parsed.data.source !== args[0]) throw new ArtiumError('INVALID_RESPONSE')
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
