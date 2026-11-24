// Looks whether a newer build of StarBench has been published. One request to one address at
// GitHub, with nothing of the person in it: no key, no sign-in, no name of a folder or a model.
// GitHub sees what any web server sees of a visitor, the computer's address on the network, and
// that the question comes from StarBench. What the answer means is worked out in
// shared/update.ts. The app downloads and installs nothing: it says that there is a newer build
// and where its page is.
//
// What was learned is kept in a small file of its own in the app's data folder, so that the app
// looks once a day at most however often it is started, and still knows of a newer build after a
// restart. Nothing in this file depends on Electron.

import { ABOUT } from '../shared/about.ts'
import { AUTO_CHECK_DEFAULT, RECHECK_AFTER_MS, autoCheckDue, buildName, buildOf, buildOfTag, findingFor, findingFromTag, newestRelease, releasesIn } from '../shared/update.ts'
import type { Build, Release, UpdateEvent, UpdateFailure, UpdateState } from '../shared/update.ts'
import { readJson, writeJson } from './json-file.ts'

/** The repository's owner and name, out of its address (about.ts): the releases asked about are its own. */
const REPOSITORY = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)$/.exec(ABOUT.repo.url)?.[1]
if (!REPOSITORY) throw new Error('The address of the repository is not one on GitHub.')

/**
 * The one address that is asked: the list of published releases, the latest twenty. Pre-releases
 * are in it, which is what every revision of the Beta is published as; drafts are not shown to
 * someone who has not signed in.
 */
export const RELEASES_URL = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=20`

/** How long GitHub is given to answer. */
const TIMEOUT_MS = 10_000
/** The most that is read of an answer, in bytes. Twenty releases with their notes and files come to a fraction of it. */
const MAX_BYTES = 1_000_000

/** A look that came to nothing, with the kind of reason the page words. */
export class UpdateCheckError extends Error {
  readonly reason: UpdateFailure
  constructor(reason: UpdateFailure, message: string) {
    super(message)
    this.name = 'UpdateCheckError'
    this.reason = reason
  }
}

export interface AskOptions {
  /** Who is asking, as GitHub requires every request to say: "StarBench/0.1.0". */
  agent: string
  /** Another address to ask, for tests. The app passes none once it is packaged. */
  url?: string
  timeoutMs?: number
  maxBytes?: number
  signal?: AbortSignal
}

/**
 * Asks for the list of releases and resolves with those whose tags name a build. The request
 * carries no credentials and is not sent on anywhere: a redirect ends it. The answer is read up
 * to a limit, piece by piece, and is given up on beyond it.
 */
export async function askReleases(options: AskOptions): Promise<Release[]> {
  const limit = options.maxBytes ?? MAX_BYTES
  const timeout = AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(options.url ?? RELEASES_URL, {
      method: 'GET',
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': options.agent },
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
    })
  } catch (err) {
    const said = err instanceof Error ? `${err.message}${err.cause instanceof Error ? `: ${err.cause.message}` : ''}` : String(err)
    // Sent on to another address, which is not followed: GitHub answered, only not with the list.
    throw new UpdateCheckError(/redirect/i.test(said) ? 'refused' : 'offline', said)
  }
  try {
    // Too many questions from this address within the hour: GitHub says so with 429, or with 403 and nothing left of the hour's count.
    if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
      throw new UpdateCheckError('limited', `GitHub answered ${response.status}: no more requests from this address for now.`)
    }
    if (response.status !== 200) throw new UpdateCheckError('refused', `GitHub answered ${response.status}.`)
    const told = Number(response.headers.get('content-length'))
    if (Number.isFinite(told) && told > limit) throw new UpdateCheckError('unreadable', 'The answer is longer than a list of releases can be.')
    const text = await readUpTo(response, limit)
    let answer: unknown
    try {
      answer = JSON.parse(text)
    } catch {
      throw new UpdateCheckError('unreadable', 'The answer is not JSON.')
    }
    try {
      return releasesIn(answer)
    } catch (err) {
      throw new UpdateCheckError('unreadable', err instanceof Error ? err.message : String(err))
    }
  } catch (err) {
    // Whatever is left of the answer is not read.
    await response.body?.cancel().catch(() => {})
    if (err instanceof UpdateCheckError) throw err
    // The connection broke, or the time ran out, while the answer was being read.
    throw new UpdateCheckError('offline', err instanceof Error ? err.message : String(err))
  }
}

/** The text of an answer, read piece by piece and given up on once it is longer than `limit` bytes. */
async function readUpTo(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const pieces: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => {})
      throw new UpdateCheckError('unreadable', 'The answer is longer than a list of releases can be.')
    }
    pieces.push(value)
  }
  return Buffer.concat(pieces).toString('utf8')
}

/** What is kept between runs. */
interface Kept {
  /** The person's choice of whether the app looks by itself. Absent until they make one. */
  auto?: boolean
  /** When the app last looked and got an answer. */
  checked?: number
  /** The newest build that look found published: its tag and day. `null` when nothing was published. Absent until a look has succeeded. */
  seen?: { tag: string; published?: number } | null
  /** The tag of the newer build the person has been told of, so that they are told once. */
  told?: string
}

export type { UpdateEvent }

export interface UpdateCheckerOptions {
  /** Where what was learned is kept: a file in the app's data folder. */
  file: string
  /** The version of the app that is running, and its revision (about.ts). */
  version: string
  revision?: number
  /** Asks GitHub. Tests put a list in its place. */
  ask: () => Promise<Release[]>
  emit?: (event: UpdateEvent) => void
  now?: () => number
}

/** Reads what a kept file says, leaving out whatever is not as it should be. */
function cleanKept(raw: unknown): Kept {
  const from = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const kept: Kept = {}
  if (typeof from.auto === 'boolean') kept.auto = from.auto
  if (typeof from.checked === 'number' && Number.isFinite(from.checked) && from.checked > 0) kept.checked = from.checked
  if (from.seen === null) kept.seen = null
  else if (typeof from.seen === 'object') {
    const { tag, published } = from.seen as { tag?: unknown; published?: unknown }
    if (buildOfTag(tag)) kept.seen = { tag: tag as string, ...(typeof published === 'number' && Number.isFinite(published) ? { published } : {}) }
  }
  if (buildOfTag(from.told)) kept.told = from.told as string
  // A look that is said to have found something, without the time it was made at, is no look.
  if (kept.checked === undefined) delete kept.seen
  return kept
}

/** Keeps what is known about updates, and looks when asked to or when it is time. */
export class UpdateChecker {
  private readonly opts: UpdateCheckerOptions
  private readonly current: Build
  private kept: Kept = {}
  private loaded: Promise<void> | null = null
  private running: Promise<UpdateState> | null = null
  private failure: UpdateFailure | undefined
  /** One look of its own per run when the looks fail: the next start tries again. */
  private triedByItself = false
  private writing: Promise<void> = Promise.resolve()

  constructor(opts: UpdateCheckerOptions) {
    this.opts = opts
    const current = buildOf(opts.version, opts.revision)
    if (!current) throw new Error(`"${opts.version}" is not a version this app can compare.`)
    this.current = current
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  /** Reads what was kept. Everything else waits for it; a file that is missing or broken counts as empty. */
  init(): Promise<void> {
    this.loaded ??= (async () => {
      this.kept = cleanKept(await readJson(this.opts.file))
    })()
    return this.loaded
  }

  /**
   * Writes what is kept. One write after another, each with what is known when its turn comes: a
   * switch flipped while a look runs and what that look finds both end up in the file, whichever
   * is written last. A write that fails is not tried again: the app then looks once more than it
   * had to, after its next start.
   */
  private keep(): Promise<void> {
    this.writing = this.writing.then(() =>
      writeJson(this.opts.file, this.kept).catch((err: unknown) => {
        console.error('[update] could not keep what was learned:', err instanceof Error ? err.message : err)
      })
    )
    return this.writing
  }

  private get auto(): boolean {
    return this.kept.auto ?? AUTO_CHECK_DEFAULT
  }

  private snapshot(): UpdateState {
    const { checked, seen } = this.kept
    const finding = seen === undefined ? undefined : seen === null ? ({ state: 'none' } as const) : findingFromTag(this.current, seen.tag, seen.published)
    return {
      current: buildName(this.current),
      auto: this.auto,
      checking: this.running !== null,
      ...(checked !== undefined ? { checked } : {}),
      ...(finding ? { finding } : {}),
      ...(this.failure ? { failure: this.failure } : {})
    }
  }

  async state(): Promise<UpdateState> {
    await this.init()
    return this.snapshot()
  }

  /** Whether the app looks by itself: the person's choice, kept from then on. */
  async setAuto(on: boolean): Promise<UpdateState> {
    await this.init()
    this.kept = { ...this.kept, auto: on }
    await this.keep()
    const state = this.snapshot()
    this.opts.emit?.({ type: 'state', state })
    return state
  }

  /**
   * Looks now. Asked for by the person ('person'), it looks unless it got an answer a moment ago;
   * by the app itself ('app'), only where the person lets it and a day has gone by since the last
   * answer. Two looks never run at once: whoever asks while one runs gets that one's outcome.
   * Always resolves: a look that fails is told in the state, not thrown.
   */
  async check(by: 'person' | 'app'): Promise<UpdateState> {
    await this.init()
    if (this.running) return this.running
    const now = this.now()
    if (by === 'app') {
      if (this.triedByItself || !autoCheckDue(this.auto, this.kept.checked, now)) return this.snapshot()
      this.triedByItself = true
    } else if (this.kept.checked !== undefined && !this.failure && now >= this.kept.checked && now - this.kept.checked < RECHECK_AFTER_MS) {
      return this.snapshot()
    }
    this.running = this.look(by).finally(() => {
      this.running = null
    })
    // The page shows that a look is under way.
    this.opts.emit?.({ type: 'state', state: this.snapshot() })
    const state = await this.running
    this.opts.emit?.({ type: 'state', state })
    return state
  }

  private async look(by: 'person' | 'app'): Promise<UpdateState> {
    let releases: Release[]
    try {
      releases = await this.opts.ask()
    } catch (err) {
      this.failure = err instanceof UpdateCheckError ? err.reason : 'offline'
      console.error('[update] the look for a newer build came to nothing:', err instanceof Error ? err.message : err)
      return { ...this.snapshot(), checking: false }
    }
    this.failure = undefined
    const finding = findingFor(this.current, releases)
    const newest = newestRelease(releases)
    const telling = finding.state === 'newer' && this.kept.told !== finding.tag
    this.kept = {
      ...this.kept,
      checked: this.now(),
      seen: newest ? { tag: newest.tag, ...(newest.published !== undefined ? { published: newest.published } : {}) } : null,
      // Seen on the page when the person asked, said in a notice when the app looked: told either way.
      ...(finding.state === 'newer' ? { told: finding.tag } : {})
    }
    await this.keep()
    if (telling && by === 'app' && finding.state === 'newer') this.opts.emit?.({ type: 'found', current: buildName(this.current), finding })
    return { ...this.snapshot(), checking: false }
  }
}

/** What the main process's IPC needs of `ipcMain`. */
interface Handles {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void
}

/** The page's way to the look for updates (the About page of the settings). */
export function registerUpdateIpc(ipc: Handles, updates: UpdateChecker): void {
  ipc.handle('updates:state', () => updates.state())
  ipc.handle('updates:check', () => updates.check('person'))
  // The page says it is up and listening: now is when a look of the app's own can tell it something.
  ipc.handle('updates:auto', () => updates.check('app'))
  ipc.handle('updates:setAuto', (_e, on: unknown) => updates.setAuto(on === true))
}
