import fs from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { syncBuiltinESMExports } from 'node:module'

const [failure, launcher, ...args] = process.argv.slice(2)
const index = args.indexOf('--result-file')
const result = index < 0 ? undefined : args[index + 1]
const original = { ...fs.promises }
const fail = () => { throw Object.assign(new Error('synthetic result storage failure'), { code: 'ENOSPC' }) }
let destinations = 0
fs.promises.mkdir = async (path, ...options) => {
  if (result && path === dirname(result)) {
    destinations++
    if (failure === 'destination' && destinations === 2) fail()
  }
  return original.mkdir(path, ...options)
}
fs.promises.open = async (path, flags, ...options) => {
  const payload = result && String(path).startsWith(result + '.')
  const parent = result && path === dirname(result) && typeof flags === 'number' && (flags & fs.constants.O_DIRECTORY) !== 0
  if (payload && failure === 'open' || parent && failure === 'parent-open') fail()
  const handle = await original.open(path, flags, ...options)
  for (const method of ['writeFile', 'sync', 'close']) {
    if (payload && failure === method || parent && failure === 'parent-' + method) {
      const close = handle.close.bind(handle)
      handle[method] = async () => {
        if (method === 'close') await close()
        fail()
      }
    }
  }
  return handle
}
fs.promises.rename = async (from, to) => {
  if (result && to === result && failure === 'rename') fail()
  return original.rename(from, to)
}
syncBuiltinESMExports()
process.argv = [process.execPath, launcher, ...args]
await import(pathToFileURL(resolve(launcher)).href)
