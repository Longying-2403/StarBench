import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Reads a JSON file; resolves with null when it is missing or unreadable. */
export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  // Write to a temp file first so a crash mid-write cannot corrupt the original.
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(tmp, file)
}
