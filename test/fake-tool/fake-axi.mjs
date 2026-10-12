#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const [mode, ...args] = process.argv.slice(2)
const modes = ['env', 'print', 'sleep', 'stdout', 'stderr', 'memory', 'child',
  'descendant', 'child-exit', 'exit', 'split', 'leak', 'signal', 'upstream', 'hosted-profile']
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
