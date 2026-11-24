// Small JSON files (sessions, settings, plugin state) read and replaced atomically.
//
// On Windows a file cannot be replaced while anything has it open, even just
// for reading. Reads and replacements of the same file are therefore queued
// behind each other here, and the replacement is retried briefly in case
// another program (a virus scanner, an indexer) is holding the file.

import { promises as fs } from 'node:fs'
import path from 'node:path'

const queues = new Map<string, Promise<unknown>>()

/** Runs `task` after every earlier task on the same file has finished. */
function queued<T>(file: string, task: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(file)
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  const result = (queues.get(key) ?? Promise.resolve()).then(task, task)
  const tail = result.catch(() => {})
  queues.set(key, tail)
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return result
}

/** Reads a JSON file; resolves with null when it is missing or unreadable. */
export function readJson<T>(file: string): Promise<T | null> {
  return queued(file, async () => {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as T
    } catch {
      return null
    }
  })
}

let writeCounter = 0

export async function writeJson(file: string, value: unknown): Promise<void> {
  return writeJsonText(file, JSON.stringify(value, null, 2))
}

/** `writeJson` for a value already written out as JSON: what is saved is the value as it was when it was written out. */
export async function writeJsonText(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  // Write to a temp file first so a crash mid-write cannot corrupt the original.
  // The name is unique per write, so two writers of one file never share a temp file.
  const tmp = `${file}.${process.pid}.${writeCounter++}.tmp`
  await fs.writeFile(tmp, text, 'utf8')
  try {
    await queued(file, () => renameOver(tmp, file))
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

async function renameOver(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.rename(from, to)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const busy = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
      if (!busy || attempt >= 12) throw err
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)))
    }
  }
}
