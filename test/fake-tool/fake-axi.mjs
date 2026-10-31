#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { link, mkdir, readFile, readdir, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const [mode, ...args] = process.argv.slice(2)
const modes = ['env', 'print', 'sleep', 'cleanup', 'stdout', 'stderr', 'memory', 'child',
  'descendant', 'child-exit', 'exit', 'split', 'leak', 'signal', 'upstream', 'hosted-profile', 'failure', 'tool-failure']
const hold = () => setInterval(() => {}, 60_000)
const ready = async value => {
  const path = process.env.ARTIUM_TEST_READY_FILE
  if (path) {
    await writeFile(`${path}.tmp`, JSON.stringify(value))
    await rename(`${path}.tmp`, path)
  }
}
const number = (value, fallback) => {
  const result = Number(value ?? fallback)
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Expected a non-negative integer')
  return result
}
const write = async (stream, value) => {
  if (!stream.write(value)) await once(stream, 'drain')
}

try {
  switch (mode) {
    case 'input-file': {
      const path = args[args.indexOf('--note-file') + 1]
      const content = await readFile(path)
      const metadata = { path, contentBase64: content.toString('base64'),
        mode: (await stat(path)).mode & 0o777, directoryMode: (await stat(join(path, '..'))).mode & 0o777 }
      await ready(metadata)
      if (process.env.ARTIUM_TEST_INPUT_OUTCOME === 'cancel') hold()
      else {
        console.log(JSON.stringify(metadata))
        process.exitCode = process.env.ARTIUM_TEST_INPUT_OUTCOME === 'error' ? 7 : 0
      }
      break
    }
    case 'native-artifact': {
      const { main } = await import('../../tools/node_modules/@knowttl/hybrid-axi/dist/src/cli.js')
      const { constructWriteCoordinator } = await import('../../tools/node_modules/@knowttl/hybrid-axi/dist/src/writes-core.js')
      const { downloadBindings, downloadOperations } = await import('../../tools/node_modules/@knowttl/hybrid-axi/dist/src/download-catalogue.js')
      const size = number(process.env.ARTIUM_TEST_ARTIFACT_BYTES, 257)
      let requests = 0
      await main(args, { createWriteCoordinator: (options, credentials) => constructWriteCoordinator(options, {
        credentials, operations: downloadOperations, bindings: downloadBindings,
        fetch: async () => {
          requests++
          let remaining = size
          return new Response(new ReadableStream({ pull(controller) {
            if (!remaining) { controller.close(); return }
            const count = Math.min(remaining, 1024 * 1024)
            controller.enqueue(new Uint8Array(count).fill(0xa5))
            remaining -= count
          } }), { status: 200, headers: { 'content-type': 'application/octet-stream' } })
        },
      }) })
      await writeFile(process.env.ARTIUM_TEST_RSS_FILE,
        JSON.stringify({ maxRssBytes: process.resourceUsage().maxRSS * 1024, bytes: size, requests }))
      break
    }
    case 'artifact': {
      const { encode } = await import('@toon-format/toon')
      const [group, , id] = args
      const flag = name => args[args.indexOf(name) + 1]
      const output = flag('--output')
      const confirmation = JSON.parse(flag('--confirm'))
      const operation = confirmation[1]
      const variant = process.env.ARTIUM_TEST_ARTIFACT_VARIANT ?? 'success'
      const size = number(process.env.ARTIUM_TEST_ARTIFACT_BYTES, 257)
      const auditId = '77066c24-bcb0-4a39-9304-551a617ac080'
      const meta = { time: '2026-01-01T00:00:00.000Z', auditId, intentKey: 'b'.repeat(64),
        profile: confirmation[0], operation, target: confirmation[3], effect: 'write' }
      if (variant === 'upstream-failure' || variant === 'restricted-key') {
        await writeFile(process.env.HYBRID_AXI_WRITE_LOG, JSON.stringify({ ...meta, kind: 'intent' }) + '\n'
          + JSON.stringify({ ...meta, kind: 'outcome', result: 'FAILED', status: 403 }) + '\n', { mode: 0o600 })
        process.stdout.write(encode({ error: { code: variant === 'restricted-key' ? 'KEY_LEVEL_RESTRICTED' : 'PERMISSION_DENIED',
          keyLevel: variant === 'restricted-key' ? 'restricted' : 'unknown', status: 403, auditId } }) + '\n')
        process.exitCode = 1
        break
      }
      if (variant === 'partial') {
        await writeFile(output.replace(/archive$/, '.hybrid-artifact-aaaa.tmp'), Buffer.alloc(1024, 0xa5), { mode: 0o600 })
        await ready({ parent: process.pid })
        hold()
        break
      }
      const { constructTransport } = await import('../../tools/node_modules/@knowttl/hybrid-axi/dist/src/transport-core.js')
      const { downloadBindings } = await import('../../tools/node_modules/@knowttl/hybrid-axi/dist/src/download-catalogue.js')
      const { saveArtifact } = await import('../../tools/node_modules/@knowttl/hybrid-axi/dist/src/report-file.js')
      // Exercise the pinned buffered transport with an inert, in-process source.
      // There is no network fallback in this fake.
      let remaining = size
      const transport = constructTransport({ credential: { apiKey: 'CANARY-artifact-key', redact: value => value } }, {
        bindings: downloadBindings, consumeWriteAuthorization: () => true,
        fetch: async () => new Response(new ReadableStream({ pull(controller) {
          if (!remaining) { controller.close(); return }
          const count = Math.min(remaining, 1024 * 1024)
          controller.enqueue(new Uint8Array(count).fill(0xa5))
          remaining -= count
        } }), { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
      })
      const response = await transport.request(operation, { pathParams: { [group === 'hash' ? 'sha256' : 'id']: id } })
      saveArtifact(output, response.body, operation)
      if (variant === 'symlink') { await unlink(output); await symlink('/dev/null', output) }
      if (variant === 'directory') { await unlink(output); await mkdir(output) }
      if (variant === 'missing-output') await unlink(output)
      if (variant === 'hardlink') await link(output, output.replace(/archive$/, '.hybrid-artifact-aaaa.tmp'))
      if (variant === 'failure') process.exitCode = 1
      if (variant === 'wrong-target') meta.target = 'd'.repeat(64)
      if (variant !== 'missing-journal') await writeFile(process.env.HYBRID_AXI_WRITE_LOG,
        JSON.stringify({ ...meta, kind: 'intent' }) + '\n' + JSON.stringify({ ...meta, kind: 'outcome',
          result: variant === 'failed-journal' ? 'FAILED' : 'SUCCESS', status: variant === 'failed-journal' ? 403 : 200 })
        + (variant === 'incomplete-journal' ? '' : '\n'), { mode: 0o600 })
      if (process.env.ARTIUM_TEST_RSS_FILE) await writeFile(process.env.ARTIUM_TEST_RSS_FILE,
        JSON.stringify({ maxRssBytes: process.resourceUsage().maxRSS * 1024, bytes: size }))
      process.stdout.write(encode({ id, type: group === 'hash' ? 'bin' : flag('--type'), output,
        bytes: variant === 'size-mismatch' ? size + 1 : size, auditId }) + '\n')
      break
    }
    case 'ldap-delivery': {
      const config = JSON.parse(await readFile(join(process.env.XDG_CONFIG_HOME, 'ldap-axi/config.json'), 'utf8'))
      const profile = config.profiles.artium
      await ready({ caFile: profile.caFile ? await readFile(join(process.env.XDG_CONFIG_HOME, profile.caFile), 'utf8') : null,
        bindPassword: process.env[profile.bindPassword.env] })
      break
    }
    case 'native-journal': {
      const journal = process.env.AZ_AXI_WRITE_LOG ?? process.env.MG_AXI_WRITE_LOG ?? process.env.VECTRA_AXI_WRITE_LOG
      if (args[0] === 'signal-before-journal') process.kill(process.pid, 'SIGTERM')
      if (args[0] === 'missing') break
      if (args[0] === 'empty') { await writeFile(journal, ''); break }
      if (args[0] === 'failed') { process.exitCode = 1; break }
      if (args[0] !== 'read') await writeFile(journal, JSON.stringify({ kind: 'intent', time: new Date().toISOString(), intentKey: 'a'.repeat(64) }) + '\n', { mode: 0o600 })
      if (args[0] === 'signal') process.kill(process.pid, 'SIGTERM')
      break
    }
    case 'hosted-profile': {
      const tool = args[0]
      const file = join(process.env.XDG_CONFIG_HOME, tool, 'config.json')
      const content = await readFile(file, 'utf8')
      const config = JSON.parse(content)
      const profile = config.profiles.artium
      const emptyHome = (await readdir(process.env.HOME)).length === 0
      if (!emptyHome) throw new Error('Hosted HOME must be empty')
      if (config.version !== 1 || config.defaultProfile !== 'artium' || Object.keys(config.profiles).length !== 1)
        throw new Error('Invalid hosted config')
      if ((await stat(file)).mode % 512 !== 384 || (await stat(join(process.env.XDG_CONFIG_HOME, tool))).mode % 512 !== 448)
        throw new Error('Invalid hosted permissions')
      const secret = profile.clientSecret ?? profile.privateKey
      if (!/^ARTIUM_SECRET_[0-9]+$/.test(secret.env) || !process.env[secret.env] || content.includes(process.env[secret.env]))
        throw new Error('Invalid hosted secret')
      console.log(JSON.stringify({ profile: 'artium', auth: profile.auth, thumbprintSha256: profile.thumbprintSha256,
        writes: profile.writes, secretResolved: true, privateFiles: true, emptyHome }))
      break
    }
    case 'env':
      console.log(JSON.stringify(process.env))
      break
    case 'print':
      process.stdout.write(args.join(' '))
      break
    case 'sleep':
      if (args[1] === 'ignore-term') process.on('SIGTERM', () => {})
      await ready({ parent: process.pid })
      await delay(number(args[0], 60_000))
      break
    case 'cleanup':
      process.once('SIGTERM', async () => {
        await delay(number(args[0], 3_000))
        await writeFile(process.env.ARTIUM_TEST_CLEANUP_FILE, 'deleted')
        process.exit(0)
      })
      await ready({ parent: process.pid })
      hold()
      break
    case 'stdout':
    case 'stderr': {
      const stream = process[mode]
      let remaining = number(args[0], 8 * 1024 * 1024)
      const block = Buffer.alloc(64 * 1024, 'x')
      while (remaining > 0) {
        const count = Math.min(remaining, block.length)
        await write(stream, block.subarray(0, count))
        remaining -= count
      }
      break
    }
    case 'memory': {
      // Touch pages and retain buffers: a heap-only allocation misses resident limits.
      const buffers = Array.from({ length: number(args[0], 128) }, () => Buffer.alloc(1024 * 1024, 1))
      console.log(JSON.stringify({ bytes: buffers.reduce((sum, buffer) => sum + buffer.length, 0) }))
      await ready({ parent: process.pid, bytes: buffers.reduce((sum, buffer) => sum + buffer.length, 0) })
      setInterval(() => buffers[0]?.readUInt8(0), 60_000)
      break
    }
    case 'child':
    case 'child-exit':
    case 'descendant': {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
        detached: mode === 'descendant', stdio: args[0] === 'pipes' ? ['ignore', 'inherit', 'inherit'] : 'ignore', env: process.env,
      })
      console.log(JSON.stringify({ parent: process.pid, child: child.pid, detached: mode === 'descendant' }))
      await ready({ parent: process.pid, child: child.pid, detached: mode === 'descendant' })
      if (mode === 'child-exit') child.unref()
      else hold()
      break
    }
    case 'failure':
      process.stderr.write(args[0])
      process.exitCode = Number(args[1] ?? 1)
      break
    case 'tool-failure':
      // The code alone is a safe synthetic token; the message and help are canaries that must never be stored.
      process.stderr.write(`${args[0] ? `error:\n  code: ${args[0]}\n` : 'error:\n'}  message: CANARY-failure-message\nhelp[1]: CANARY-help-text\n`)
      process.exitCode = 1
      break
    case 'exit': {
      const code = number(args[0], 0)
      if (code > 255) throw new Error('Exit code must be at most 255')
      process.exitCode = code
      break
    }
    case 'split': {
      const bytes = Buffer.from(args[0] ?? 'CANARY-synthetic')
      const stream = args[2] === 'stderr' ? process.stderr : process.stdout
      const offset = number(args[1], Math.floor(bytes.length / 2))
      await write(stream, bytes.subarray(0, offset))
      await delay(20)
      await write(stream, bytes.subarray(offset))
      break
    }
    case 'leak': {
      const value = process.env.ARTIUM_TEST_CANARY ?? 'CANARY-synthetic'
      const forms = { raw: value, base64: Buffer.from(value).toString('base64'),
        base64url: Buffer.from(value).toString('base64url'), url: encodeURIComponent(value) }
      if (!Object.hasOwn(forms, args[0] ?? 'raw')) throw new Error('Unknown canary encoding')
      await write(args[1] === 'stderr' ? process.stderr : process.stdout, forms[args[0] ?? 'raw'])
      break
    }
    case 'signal':
      process.kill(process.pid, args[0] ?? 'SIGTERM')
      hold()
      break
    case 'upstream': {
      const fixtures = JSON.parse(await readFile(new URL('./fixtures/upstreams.json', import.meta.url), 'utf8'))
      const fixture = Object.hasOwn(fixtures, args[0]) && Object.hasOwn(fixtures[args[0]], args[1])
        ? fixtures[args[0]][args[1]] : undefined
      if (!fixture) throw new Error('Unknown synthetic upstream fixture')
      process.stdout.write(fixture.stdout)
      process.stderr.write(fixture.stderr)
      process.exitCode = fixture.exitCode
      break
    }
    default:
      throw new Error(`Unknown mode. Modes: ${modes.join(', ')}`)
  }
} catch (error) {
  console.log(`error: ${error.message}`)
  process.exitCode = 2
}
