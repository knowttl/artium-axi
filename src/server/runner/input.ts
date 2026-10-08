import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runInputSchema } from '../../shared/api.js'
import type { RunInput } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'

export interface RunnerInput extends RunInput {
  // Only the adapter's reviewed parser supplies argument positions, after normalizing flag values.
  fileArguments?: readonly number[]
}

export function validateInput(args: readonly string[], input: RunnerInput): RunnerInput {
  const { fileArguments = [], ...body } = input
  const parsed = runInputSchema.safeParse(body)
  if (!parsed.success) throw new ArtiumError('INVALID_INPUT')
  for (const index of fileArguments) {
    if (!Number.isInteger(index) || index < 0 || !parsed.data.files?.some(file => file.name === args[index])) {
      throw new ArtiumError('UNSUPPORTED_INPUT')
    }
  }
  return { ...parsed.data, fileArguments }
}

export async function writeInput(directory: string, args: readonly string[], input: RunnerInput): Promise<string[]> {
  const paths = new Map<string, string>()
  try {
    if (input.files?.length) {
      const inputs = join(directory, 'inputs')
      await mkdir(inputs, { mode: 0o700 })
      for (const file of input.files) {
        const path = join(inputs, file.name)
        await writeFile(path, Buffer.from(file.contentBase64, 'base64'), { mode: 0o600, flag: 'wx' })
        paths.set(file.name, path)
      }
    }
  } catch {
    throw new ArtiumError('TEMP_UNAVAILABLE')
  }
  const result = [...args]
  for (const index of input.fileArguments ?? []) result[index] = paths.get(args[index])!
  return result
}
