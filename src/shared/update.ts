// Whether a newer build of StarBench has been published: how a build is told from its tag, how
// two builds compare, and which of the releases GitHub lists is the newest. Nothing in this file
// talks to the network; asking GitHub is main/update-check.ts.
//
// A build is named by the version of the package and, while the Beta lasts, the number of the
// revision: "0.1.0-r.11" (about.ts writes it). Its release on GitHub carries the tag
// "v0.1.0-r.11". A tag written any other way names no build as far as this file is concerned,
// and its release is passed over.

import { ABOUT, buildLabel } from './about.ts'

/** A build as the author counts them. */
export interface Build {
  major: number
  minor: number
  patch: number
  /** Absent for the finished version, which comes after every revision of it. */
  revision?: number
}

/**
 * The only tags that name a build: v1.2.3 and v1.2.3-r.45. The numbers are kept short, so that
 * none can be more than a number holds, and nothing else can stand in a tag that passes: such a
 * tag is safe to put into an address.
 */
const TAG = /^v(\d{1,5})\.(\d{1,5})\.(\d{1,5})(?:-r\.(\d{1,6}))?$/
const VERSION = /^(\d{1,5})\.(\d{1,5})\.(\d{1,5})$/

/** The build a tag names, or undefined where it names none. */
export function buildOfTag(tag: unknown): Build | undefined {
  if (typeof tag !== 'string') return undefined
  const found = TAG.exec(tag)
  if (!found) return undefined
  return { major: Number(found[1]), minor: Number(found[2]), patch: Number(found[3]), ...(found[4] !== undefined ? { revision: Number(found[4]) } : {}) }
}

/** The build that is running: the version the app says it is, and the revision it was given (about.ts). Undefined for a version that is not three numbers. */
export function buildOf(version: string, revision?: number): Build | undefined {
  const found = VERSION.exec(version)
  if (!found) return undefined
  const counted = revision !== undefined && Number.isInteger(revision) && revision >= 0
  return { major: Number(found[1]), minor: Number(found[2]), patch: Number(found[3]), ...(counted ? { revision } : {}) }
}

/** A build as it is written for a person: "0.1.0-r.12", or "0.2.0" for a finished version. */
export function buildName(build: Build): string {
  const version = `${build.major}.${build.minor}.${build.patch}`
  return build.revision !== undefined ? buildLabel(version, build.revision) : version
}

/**
 * The page of a release, where its files are, for a tag that names a build. Made here from the
 * tag and the address of the repository, and not taken from what a server said: the app opens it
 * in the person's browser.
 */
export function releasePage(tag: string): string {
  if (!buildOfTag(tag)) throw new Error('Not the tag of a build.')
  return `${ABOUT.repo.url}/releases/tag/${tag}`
}

/**
 * Which of two builds is the newer: below zero when it is `b`, above when it is `a`, zero when
 * they are the same. The version counts first. Of the same version, the build without a revision
 * is the newer, as the finished version comes after its revisions; otherwise the higher revision,
 * by its number ("r.9" comes before "r.10").
 */
export function compareBuilds(a: Build, b: Build): number {
  const byVersion = a.major - b.major || a.minor - b.minor || a.patch - b.patch
  if (byVersion !== 0) return byVersion
  if (a.revision === undefined || b.revision === undefined) return (a.revision === undefined ? 1 : 0) - (b.revision === undefined ? 1 : 0)
  return a.revision - b.revision
}

/** What the app keeps of one release as GitHub lists it. */
export interface Release {
  /** Its tag, as GitHub has it: one that names a build. */
  tag: string
  build: Build
  /** When it was published, in milliseconds, where the list says so. */
  published?: number
}

/**
 * The releases in what GitHub answered when asked for the list: an array of objects, of each of
 * which only the tag is read, and the day it was published. What is not a release with a tag that
 * names a build is passed over: the answer is somebody else's, and is trusted with nothing more.
 * Throws where the answer is no list at all.
 */
export function releasesIn(answer: unknown): Release[] {
  if (!Array.isArray(answer)) throw new Error('The answer is not a list of releases.')
  const releases: Release[] = []
  for (const entry of answer) {
    if (typeof entry !== 'object' || entry === null) continue
    const { tag_name: tag, published_at: at } = entry as { tag_name?: unknown; published_at?: unknown }
    const build = buildOfTag(tag)
    if (!build) continue
    const published = typeof at === 'string' ? Date.parse(at) : Number.NaN
    releases.push({ tag: tag as string, build, ...(Number.isFinite(published) ? { published } : {}) })
  }
  return releases
}

/** The newest of some releases, if there are any. */
export function newestRelease(releases: readonly Release[]): Release | undefined {
  return releases.reduce<Release | undefined>((newest, release) => (!newest || compareBuilds(release.build, newest.build) > 0 ? release : newest), undefined)
}

/** What a look at the published releases came to. */
export type UpdateFinding =
  /** A newer build than the one running is published. `tag` is its release's; `name` and `page` are made from the tag. */
  | { state: 'newer'; tag: string; name: string; page: string; published?: number }
  /** The newest build that is published is the one running, or an older one. */
  | { state: 'latest' }
  /** Nothing is published yet. */
  | { state: 'none' }

/** What the releases GitHub lists mean for the build that is running. */
export function findingFor(current: Build, releases: readonly Release[]): UpdateFinding {
  const newest = newestRelease(releases)
  if (!newest) return { state: 'none' }
  if (compareBuilds(newest.build, current) <= 0) return { state: 'latest' }
  return { state: 'newer', tag: newest.tag, name: buildName(newest.build), page: releasePage(newest.tag), ...(newest.published !== undefined ? { published: newest.published } : {}) }
}

/**
 * What a newer build that an earlier look found means now, for the build that is running: still
 * newer, or caught up with once the person has installed it. For what was kept from before the
 * app was last started.
 */
export function findingFromTag(current: Build, tag: unknown, published?: number): UpdateFinding | undefined {
  const build = buildOfTag(tag)
  if (!build) return undefined
  return findingFor(current, [{ tag: tag as string, build, ...(published !== undefined && Number.isFinite(published) ? { published } : {}) }])
}

/** Why a look did not come to anything. */
export type UpdateFailure =
  /** GitHub could not be reached, or did not answer in time. */
  | 'offline'
  /** GitHub answers this computer's address no more for now: too many questions from it within the hour. */
  | 'limited'
  /** GitHub answered with something other than the list. */
  | 'refused'
  /** The answer was not a list of releases, or too long to be one. */
  | 'unreadable'

/** What the page is told about updates. */
export interface UpdateState {
  /** The build that is running, as it is written: "0.1.0-r.11". */
  current: string
  /** Whether the app looks by itself after it starts. */
  auto: boolean
  /** A look is under way. */
  checking: boolean
  /** When the app last looked and got an answer, in milliseconds. */
  checked?: number
  /** What it found then, or what a newer build known from an earlier look still means for this one. */
  finding?: UpdateFinding
  /** Why the latest look came to nothing. Absent once a later one succeeds. */
  failure?: UpdateFailure
}

/** What the app says to its page about updates, unasked. */
export type UpdateEvent =
  /** Something the page shows has changed. */
  | { type: 'state'; state: UpdateState }
  /** A look of the app's own found a newer build the person has not been told of yet. */
  | { type: 'found'; current: string; finding: Extract<UpdateFinding, { state: 'newer' }> }

/**
 * Whether the app looks by itself until the person says otherwise. It does not: a look tells
 * GitHub the computer's address on the network and that StarBench runs there, which is for the
 * person to switch on.
 */
export const AUTO_CHECK_DEFAULT = false

/** How long the app waits between two looks of its own: a day. */
export const AUTO_CHECK_EVERY_MS = 24 * 60 * 60 * 1000
/**
 * A look the person asks for within this long of the last answer is answered from that one:
 * GitHub answers an address sixty times an hour, and a button is easily pressed twice.
 */
export const RECHECK_AFTER_MS = 60 * 1000

/** Whether the app is due to look by itself. */
export function autoCheckDue(auto: boolean, checked: number | undefined, now: number): boolean {
  if (!auto) return false
  // A time that has not come yet is no time at which it looked: the clock was set back since.
  return checked === undefined || checked > now || now - checked >= AUTO_CHECK_EVERY_MS
}
