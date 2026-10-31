import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

// Synthetic connection protocol over the runner's private inherited stdin.
// Every inspect resolves the profile anew, including after a previous command.
const commands = createInterface({ input: process.stdin })
commands.on('line', command => {
  const path = join(process.env.XDG_CONFIG_HOME, 'mg-axi/config.json')
  const profile = JSON.parse(readFileSync(path, 'utf8'))
  const secret = process.env[profile.profiles.artium.clientSecret.env]
  if (command === 'inspect') {
    const directories = Object.fromEntries(['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
      'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR'].map(name => [name, {
      path: process.env[name], mode: statSync(process.env[name]).mode & 0o777,
    }]))
    console.log(JSON.stringify({ pid: process.pid, profile, profileMode: statSync(path).mode & 0o777,
      resolved: secret === 'CANARY-selected secret"/+', directories,
      homeFiles: readdirSync(process.env.HOME), environmentNames: Object.keys(process.env).sort() }))
  } else if (command === 'crash') {
    process.kill(process.pid, 'SIGKILL')
  } else if (command === 'close') {
    process.exit(0)
  } else {
    const [stream, form] = command.split(':')
    const value = { raw: secret, url: encodeURIComponent(secret), base64: Buffer.from(secret).toString('base64'),
      json: JSON.stringify(secret).slice(1, -1) }[form]
    process[stream].write(value)
  }
})
