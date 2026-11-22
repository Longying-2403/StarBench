// Decoding the output of child processes. On Windows, console programs write in
// the system code page (GBK on a Chinese system, for example), not UTF-8.

import { execFileSync } from 'node:child_process'
import { system32 } from './program-path.ts'

/** Windows code pages and the TextDecoder label that reads them. */
const CODE_PAGES: Record<number, string> = {
  866: 'ibm866',
  874: 'windows-874',
  932: 'shift_jis',
  936: 'gb18030',
  949: 'euc-kr',
  950: 'big5',
  65001: 'utf-8'
}

let legacyEncoding: string | undefined

/** The encoding console programs use on this machine when they are not writing UTF-8. */
function detectLegacyEncoding(): string {
  if (legacyEncoding) return legacyEncoding
  legacyEncoding = 'windows-1252'
  if (process.platform === 'win32') {
    try {
      // Prints e.g. "Active code page: 936"; the label is localised, the number is not.
      // By its full path, like every program of Windows the app starts (program-path.ts).
      const out = execFileSync(system32('chcp.com'), { encoding: 'latin1', windowsHide: true, timeout: 3000 })
      const page = Number(/(\d+)\D*$/.exec(out)?.[1])
      if (CODE_PAGES[page]) legacyEncoding = CODE_PAGES[page]
      else if (page >= 1250 && page <= 1258) legacyEncoding = `windows-${page}`
    } catch {
      // Keep the default: garbled text is better than no text.
    }
  }
  return legacyEncoding
}

/** Decodes process output as UTF-8 when it is valid UTF-8, and as the system code page otherwise. */
export function decodeOutput(data: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    // Not UTF-8.
  }
  try {
    return new TextDecoder(detectLegacyEncoding()).decode(data)
  } catch {
    return data.toString('utf8')
  }
}

/** Keeps the most recent output of a process, for explaining why it failed. */
export class OutputTail {
  private chunks: Buffer[] = []
  private size = 0
  private limit: number

  constructor(limit: number) {
    this.limit = limit
  }

  push(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.size += chunk.length
    // Whole chunks are dropped, never split, so a multi-byte character is not cut in half.
    while (this.chunks.length > 1 && this.size - this.chunks[0].length >= this.limit) {
      this.size -= this.chunks.shift()!.length
    }
  }

  text(): string {
    return decodeOutput(Buffer.concat(this.chunks)).trim().slice(-this.limit)
  }
}
