// The files an answer points to: pictures that the page shows in the conversation, and files a
// link in it opens. Only what lies in the folder of the conversation is ever read or opened,
// like everything the tools do. Nothing in this file depends on Electron.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writtenAddress } from '../shared/links.ts'
import type { FileProblem, ImagePreview } from '../shared/types.ts'
import { OutsideWorkspace, workspacePath } from './tools.ts'

/** The kinds of picture the page can draw, with the type each is handed over as. */
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif'
}

/** A picture goes to the page whole, in one message: beyond this size it is opened outside the app instead. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/**
 * Kinds of file that the program the system opens them with shows or plays. Every other kind is
 * pointed out in its folder and not opened: a link in an answer that says "open the report" may
 * lead to a script, and opening that would run it. Nothing that is a shortcut to something else.
 * Office documents and RTF are pointed out too: the files of a cloned repository or an unpacked
 * folder carry no mark of the web, so Office opens them outside its Protected View, and these
 * formats have long been a way in for attacks. So are web pages and SVG pictures, which run
 * scripts in the browser; the page shows an SVG picture itself, without running anything.
 */
const SHOWN_WHEN_OPENED = new Set([
  ...['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'tif', 'tiff', 'heic'],
  ...['pdf', 'txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini'],
  ...['mp3', 'wav', 'ogg', 'flac', 'm4a', 'mp4', 'webm', 'mov', 'mkv', 'avi']
])

const extension = (file: string): string => path.extname(file).slice(1).toLowerCase()

/** The paths an address in an answer may stand for, the likeliest first. */
export function pathsNamed(address: string): string[] {
  const written = writtenAddress(address)
  // "report.html#summary" names report.html, unless a file is really called that.
  const forms = [written, written.split('#')[0], written.split(/[?#]/)[0], address]
  const asPath = (form: string): string => {
    if (!/^file:/i.test(form)) return form
    try {
      return fileURLToPath(form)
    } catch {
      return ''
    }
  }
  return [...new Set(forms.map(asPath).filter(Boolean))]
}

export interface NamedFile {
  full: string
  directory: boolean
  size: number
}

/**
 * The file or folder in the workspace that an address in an answer names: `outside` when none of
 * the paths it may stand for lies in the workspace, `missing` when none of those that do is there.
 */
export async function findNamed(workspace: string, address: string): Promise<NamedFile | FileProblem> {
  // Without a folder of its own a path would be read against wherever the app happens to run.
  if (!workspace || !path.isAbsolute(workspace)) return 'outside'
  let inside = false
  for (const candidate of pathsNamed(address)) {
    let full: string
    try {
      // Followed through links as well: a link in the workspace may lead anywhere.
      full = await workspacePath(workspace, candidate)
    } catch (err) {
      // Whatever else goes wrong (the folder itself is gone) leaves a file that is missing.
      if (!(err instanceof OutsideWorkspace)) inside = true
      continue
    }
    inside = true
    const stat = await fs.stat(full).catch(() => null)
    if (stat) return { full, directory: stat.isDirectory(), size: stat.size }
  }
  return inside ? 'missing' : 'outside'
}

/** A picture in the workspace as an address the page can draw, or why there is none to show. */
export async function readImage(workspace: string, address: string): Promise<ImagePreview> {
  const found = await findNamed(workspace, address)
  if (typeof found === 'string') return { ok: false, reason: found }
  const type = found.directory ? undefined : IMAGE_TYPES[extension(found.full)]
  if (!type) return { ok: false, reason: 'not-image' }
  if (found.size > MAX_IMAGE_BYTES) return { ok: false, reason: 'too-large' }
  const data = await fs.readFile(found.full)
  return { ok: true, url: `data:${type};base64,${data.toString('base64')}` }
}

/**
 * What a press on a link to a file does: `open` it with the program the system has for it, or
 * `reveal` it in its folder and leave the opening to the person. A folder is opened, unless its
 * name has an extension: on a Mac such a folder may be an application.
 */
export function howToOpen(file: Pick<NamedFile, 'full' | 'directory'>): 'open' | 'reveal' {
  const kind = extension(file.full)
  if (file.directory) return kind ? 'reveal' : 'open'
  return SHOWN_WHEN_OPENED.has(kind) ? 'open' : 'reveal'
}
