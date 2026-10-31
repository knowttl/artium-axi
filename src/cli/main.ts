import { cliVersion } from '../shared/version.js'

const args = process.argv.slice(2)
if (args.length === 1 && ['--version', '-v', '-V'].includes(args[0])) {
  process.stdout.write(`${cliVersion}\n`)
} else {
  await import('./commands.js')
}
