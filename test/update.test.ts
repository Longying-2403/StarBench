// The look for a newer build: which tags name a build and how builds compare (shared/update.ts),
// the one request to GitHub against a stand-in that answers as GitHub does and as it must not
// (main/update-check.ts), and what the app keeps of a look between its runs.
// Run with: node --test test/update.test.ts
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { RELEASES_URL, UpdateCheckError, UpdateChecker, askReleases } from '../src/main/update-check.ts'
import type { UpdateEvent } from '../src/main/update-check.ts'
import { ABOUT, buildLabel } from '../src/shared/about.ts'
import {
  AUTO_CHECK_DEFAULT,
  AUTO_CHECK_EVERY_MS,
  RECHECK_AFTER_MS,
  autoCheckDue,
  buildName,
  buildOf,
  buildOfTag,
  compareBuilds,
  findingFor,
  findingFromTag,
  newestRelease,
  releasePage,
  releasesIn
} from '../src/shared/update.ts'
import type { Release, UpdateFailure } from '../src/shared/update.ts'

test('a tag names a build only when it is written as the releases are tagged', () => {
  assert.deepEqual(buildOfTag('v0.1.0-r.11'), { major: 0, minor: 1, patch: 0, revision: 11 })
  assert.deepEqual(buildOfTag('v0.2.0'), { major: 0, minor: 2, patch: 0 })
  assert.deepEqual(buildOfTag('v12.34.56-r.7'), { major: 12, minor: 34, patch: 56, revision: 7 })
  const none = [
    // As revisions were written before 2026-11-24, without the dot: no release was ever tagged so.
    'v0.1.0-r11',
    '0.1.0-r.11',
    'V0.1.0-r.11',
    'v0.1.0-r.',
    'v0.1.0-r.11-preview_2',
    'v0.1.0-r.10-preview',
    'v0.1.0-beta1',
    'v0.1.0-r.1e3',
    'v0.1.0-r.-1',
    'v0.1-r.3',
    'v0.1.0.0',
    'v0.1.0-r.11\n',
    ' v0.1.0-r.11',
    'v0.1.0-r.11/../../x',
    'v0.1.0-r.11?x=1',
    'v0.1.0-r.1234567',
    'v123456.0.0',
    '',
    11,
    null,
    undefined,
    { tag: 'v0.1.0-r.11' }
  ]
  for (const tag of none) assert.equal(buildOfTag(tag), undefined, JSON.stringify(tag))

  // The build that is running is told from the app's version and the revision it was given.
  assert.deepEqual(buildOf('0.1.0', 11), { major: 0, minor: 1, patch: 0, revision: 11 })
  assert.deepEqual(buildOf('1.0.0'), { major: 1, minor: 0, patch: 0 })
  assert.equal(buildOf('0.1.0-r.11', 11), undefined, 'the version is the three numbers alone')
  assert.equal(buildOf('next', 1), undefined)
  // A build is written for a person as the About page writes it, and its tag is that with a v.
  assert.equal(buildName({ major: 0, minor: 1, patch: 0, revision: 12 }), '0.1.0-r.12')
  assert.equal(buildName({ major: 0, minor: 1, patch: 0, revision: 12 }), buildLabel('0.1.0', 12))
  assert.equal(buildName({ major: 0, minor: 2, patch: 0 }), '0.2.0')
  assert.deepEqual(buildOfTag(`v${buildLabel('0.1.0', ABOUT.revision)}`), buildOf('0.1.0', ABOUT.revision), 'what the About page shows is what a tag is read as')
})

test('builds are compared by version, then by the number of the revision, and a finished version comes last', () => {
  const order = ['v0.1.0-r.1', 'v0.1.0-r.9', 'v0.1.0-r.10', 'v0.1.0-r.11', 'v0.1.0-r.100', 'v0.1.0', 'v0.1.1-r.1', 'v0.1.1', 'v0.2.0-r.1', 'v0.10.0-r.1', 'v1.0.0-r.2', 'v1.0.0']
  const builds = order.map((tag) => buildOfTag(tag)!)
  for (let a = 0; a < builds.length; a++) {
    for (let b = 0; b < builds.length; b++) {
      assert.equal(Math.sign(compareBuilds(builds[a], builds[b])), Math.sign(a - b), `${order[a]} against ${order[b]}`)
    }
  }
  // Whatever order they come in, the newest is the same one.
  const shuffled = [5, 0, 11, 3, 8, 1, 10, 2, 9, 4, 7, 6].map((at): Release => ({ tag: order[at], build: builds[at] }))
  assert.equal(newestRelease(shuffled)?.tag, 'v1.0.0')
  assert.equal(newestRelease([]), undefined)
})

/** One release as GitHub lists it, with more around the tag than the app reads. */
const listed = (tag: unknown, more: Record<string, unknown> = {}): Record<string, unknown> => ({
  url: 'https://api.github.com/repos/Longying-2403/StarBench/releases/1',
  html_url: 'https://example.invalid/not-where-the-app-goes',
  tag_name: tag,
  name: `StarBench ${String(tag)}`,
  draft: false,
  prerelease: true,
  published_at: '2026-11-30T04:05:06Z',
  body: '[click here](https://example.invalid/) <script>alert(1)</script>',
  assets: [{ name: 'StarBench-setup.exe', browser_download_url: 'https://example.invalid/file.exe' }],
  ...more
})

test('of what GitHub lists, only the tags that name a build are taken, and nothing else of an entry but its day', () => {
  const releases = releasesIn([
    listed('v0.1.0-r.12'),
    listed('v0.1.0-r.11', { published_at: 'not a day' }),
    listed('v0.1.0-r.10-preview_2'),
    listed('nightly'),
    listed(undefined),
    listed(13),
    'a string',
    null,
    42,
    [listed('v9.9.9')]
  ])
  assert.deepEqual(releases, [
    { tag: 'v0.1.0-r.12', build: { major: 0, minor: 1, patch: 0, revision: 12 }, published: Date.parse('2026-11-30T04:05:06Z') },
    { tag: 'v0.1.0-r.11', build: { major: 0, minor: 1, patch: 0, revision: 11 } }
  ])
  assert.deepEqual(releasesIn([]), [])
  for (const answer of [{ message: 'Not Found' }, 'text', null, undefined, 7]) assert.throws(() => releasesIn(answer), /not a list/)
})

test('what the releases mean for the build that is running: newer, the latest, or nothing published', () => {
  const current = buildOf('0.1.0', 11)!
  const releases = releasesIn([listed('v0.1.0-r.10'), listed('v0.1.0-r.12'), listed('v0.1.0-r.11')])
  assert.deepEqual(findingFor(current, releases), {
    state: 'newer',
    tag: 'v0.1.0-r.12',
    name: '0.1.0-r.12',
    // Made by the app from the tag, and not the address the answer gave.
    page: 'https://github.com/Longying-2403/StarBench/releases/tag/v0.1.0-r.12',
    published: Date.parse('2026-11-30T04:05:06Z')
  })
  const newer = findingFor(current, releases)
  assert.equal(newer.state === 'newer' && newer.page.startsWith(`${ABOUT.repo.url}/releases/tag/`), true)
  assert.deepEqual(findingFor(current, releasesIn([listed('v0.1.0-r.11'), listed('v0.1.0-r.9')])), { state: 'latest' })
  // A build newer than anything published, as the author runs before a release.
  assert.deepEqual(findingFor(buildOf('0.1.0', 13)!, releases), { state: 'latest' })
  assert.deepEqual(findingFor(current, []), { state: 'none' })
  assert.deepEqual(findingFor(current, releasesIn([listed('v0.1.0-r.12-preview_1'), listed('nightly')])), { state: 'none' })
  // The finished version of what is running counts as newer than it; the next version too.
  assert.equal(findingFor(current, releasesIn([listed('v0.1.0')])).state, 'newer')
  assert.equal(findingFor(buildOf('0.1.0')!, releasesIn([listed('v0.1.0-r.99')])).state, 'latest')
  assert.equal(findingFor(current, releasesIn([listed('v0.2.0-r.1')])).state, 'newer')

  // A page is made for the tag of a build and for nothing else.
  assert.equal(releasePage('v0.2.0'), 'https://github.com/Longying-2403/StarBench/releases/tag/v0.2.0')
  for (const tag of ['v0.1.0-r.12/../../../other/repo', 'https://example.invalid', 'v0.1.0-r.12#x', '']) assert.throws(() => releasePage(tag), /Not the tag/)

  // What an earlier look found, weighed again for the build that runs now.
  assert.equal(findingFromTag(current, 'v0.1.0-r.12')?.state, 'newer')
  assert.deepEqual(findingFromTag(buildOf('0.1.0', 12)!, 'v0.1.0-r.12'), { state: 'latest' })
  assert.equal(findingFromTag(current, 'v0.1.0-r12'), undefined)
})

test('the app is due to look by itself once a day, and only where the person lets it', () => {
  const now = 1_800_000_000_000
  assert.equal(AUTO_CHECK_DEFAULT, false, 'it does not look by itself until the person switches that on')
  assert.equal(autoCheckDue(false, undefined, now), false)
  assert.equal(autoCheckDue(false, now - 10 * AUTO_CHECK_EVERY_MS, now), false)
  assert.equal(autoCheckDue(true, undefined, now), true)
  assert.equal(autoCheckDue(true, now - AUTO_CHECK_EVERY_MS + 1, now), false)
  assert.equal(autoCheckDue(true, now - AUTO_CHECK_EVERY_MS, now), true)
  // A look said to lie in the future is none: the clock was set back since.
  assert.equal(autoCheckDue(true, now + 60_000, now), true)
})

// ───────────────────────── The request ─────────────────────────

interface Asked {
  path: string
  method: string
  headers: http.IncomingHttpHeaders
}
const asked: Asked[] = []
const big = Buffer.alloc(300_000, 0x20)
const server = http.createServer((req, res) => {
  asked.push({ path: req.url ?? '', method: req.method ?? '', headers: req.headers })
  const json = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers }).end(typeof body === 'string' ? body : JSON.stringify(body))
  }
  switch (req.url) {
    case '/ok':
      return json(200, [listed('v0.1.0-r.12'), listed('v0.1.0-r.11'), listed('nightly')])
    case '/empty':
      return json(200, [])
    case '/redirect':
      return void res.writeHead(302, { location: '/moved' }).end()
    case '/moved':
      return json(200, [listed('v9.9.9')])
    case '/limited':
      return json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' })
    case '/forbidden':
      return json(403, { message: 'Forbidden' }, { 'x-ratelimit-remaining': '41' })
    case '/too-many':
      return json(429, { message: 'Too many requests' })
    case '/missing':
      return json(404, { message: 'Not Found' })
    case '/broken':
      return json(500, 'oops')
    case '/not-json':
      return json(200, '<!doctype html><title>Sign in</title>')
    case '/not-a-list':
      return json(200, { message: 'hello' })
    case '/long-told':
      // Says beforehand how long it is.
      return void res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(2_000_000) }).end(Buffer.alloc(2_000_000, 0x20))
    case '/long': {
      // Does not say, and goes on for as long as it is listened to.
      res.writeHead(200, { 'content-type': 'application/json' })
      const more = (): void => {
        if (res.destroyed) return
        res.write(big, () => setTimeout(more, 5))
      }
      return more()
    }
    case '/silent':
      // Takes the question and never answers.
      return
    default:
      return json(404, { message: 'Not Found' })
  }
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
// Closed whatever the tests come to: a server left open keeps the run from ending.
after(() => {
  server.closeAllConnections()
  server.close()
})
const at = (route: string): string => `http://127.0.0.1:${(server.address() as AddressInfo).port}${route}`
const agent = 'StarBench/0.1.0'

/** The reason a look that must fail fails with. */
async function failure(route: string, more: { timeoutMs?: number; maxBytes?: number } = {}): Promise<UpdateFailure> {
  try {
    await askReleases({ agent, url: at(route), ...more })
  } catch (err) {
    assert.ok(err instanceof UpdateCheckError, `${route}: ${String(err)}`)
    return err.reason
  }
  assert.fail(`${route} was taken for an answer`)
}

test('the question goes to GitHub\'s list of this repository\'s releases, and carries nothing of the person', async () => {
  assert.equal(RELEASES_URL, 'https://api.github.com/repos/Longying-2403/StarBench/releases?per_page=20')
  assert.ok(RELEASES_URL.startsWith(`https://api.github.com/repos/${ABOUT.repo.url.replace('https://github.com/', '')}/`), 'the repository asked about is the app\'s own')

  asked.length = 0
  const releases = await askReleases({ agent, url: at('/ok') })
  assert.deepEqual(releases.map((release) => release.tag), ['v0.1.0-r.12', 'v0.1.0-r.11'])
  assert.equal(asked.length, 1)
  const [{ method, headers }] = asked
  assert.equal(method, 'GET')
  assert.equal(headers['user-agent'], 'StarBench/0.1.0')
  assert.equal(headers.accept, 'application/vnd.github+json')
  for (const name of ['authorization', 'cookie', 'x-api-key', 'referer', 'origin']) assert.equal(headers[name], undefined, `no ${name} is sent`)
  assert.deepEqual(await askReleases({ agent, url: at('/empty') }), [])
})

test('an answer that is no list of releases is not taken for one, and a redirect is not followed', async () => {
  asked.length = 0
  // Sent elsewhere: the app does not go there, wherever it is.
  assert.equal(await failure('/redirect'), 'refused')
  assert.deepEqual(asked.map((request) => request.path), ['/redirect'], 'the place it was sent on to was never asked')

  assert.equal(await failure('/limited'), 'limited')
  assert.equal(await failure('/too-many'), 'limited')
  assert.equal(await failure('/forbidden'), 'refused')
  assert.equal(await failure('/missing'), 'refused')
  assert.equal(await failure('/broken'), 'refused')
  assert.equal(await failure('/not-json'), 'unreadable')
  assert.equal(await failure('/not-a-list'), 'unreadable')
  // Longer than a list of releases can be: given up on, whether or not the answer said how long it is.
  assert.equal(await failure('/long-told'), 'unreadable')
  assert.equal(await failure('/long', { maxBytes: 1_000_000 }), 'unreadable')
  // No answer in time, and nobody listening at all.
  assert.equal(await failure('/silent', { timeoutMs: 300 }), 'offline')
  const unused = await new Promise<number>((resolve) => {
    const probe = http.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => resolve(port))
    })
  })
  await assert.rejects(askReleases({ agent, url: `http://127.0.0.1:${unused}/ok`, timeoutMs: 2000 }), (err: unknown) => err instanceof UpdateCheckError && err.reason === 'offline')
  // A look that is called off ends at once.
  const stop = new AbortController()
  const pending = askReleases({ agent, url: at('/silent'), signal: stop.signal })
  stop.abort()
  await assert.rejects(pending, (err: unknown) => err instanceof UpdateCheckError && err.reason === 'offline')
})

// ───────────────────────── What is kept ─────────────────────────

const folder = await mkdtemp(path.join(os.tmpdir(), 'starbench-update-'))
after(() => rm(folder, { recursive: true, force: true }))
let files = 0

/** A checker over a file of its own, a clock that is moved by hand, and a list put in GitHub's place. */
function rig(start: { revision?: number; kept?: unknown } = {}) {
  const file = path.join(folder, `updates-${++files}.json`)
  const clock = { now: 1_800_000_000_000 }
  const world: { releases: Release[] | UpdateCheckError; asks: number; hold?: Promise<void> } = { releases: [], asks: 0 }
  const events: UpdateEvent[] = []
  const make = (revision = start.revision ?? 11): UpdateChecker =>
    new UpdateChecker({
      file,
      version: '0.1.0',
      revision,
      now: () => clock.now,
      emit: (event) => events.push(event),
      ask: async () => {
        world.asks++
        await world.hold
        if (world.releases instanceof Error) throw world.releases
        return world.releases
      }
    })
  const ready = start.kept !== undefined ? writeFile(file, typeof start.kept === 'string' ? start.kept : JSON.stringify(start.kept)) : Promise.resolve()
  const found = (): string[] => events.flatMap((event) => (event.type === 'found' ? [event.finding.tag] : []))
  return { file, clock, world, events, make, ready, found, kept: async () => JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown> }
}
const published = (...tags: string[]): Release[] => releasesIn(tags.map((tag) => listed(tag)))

test('a look the person asks for says what it found, keeps it, and is not repeated within the minute', async () => {
  const { clock, world, make, kept, found, events } = rig()
  const updates = make()
  assert.deepEqual(await updates.state(), { current: '0.1.0-r.11', auto: false, checking: false }, 'nothing is known before the first look')

  world.releases = published('v0.1.0-r.11', 'v0.1.0-r.10')
  const first = await updates.check('person')
  assert.deepEqual(first, { current: '0.1.0-r.11', auto: false, checking: false, checked: clock.now, finding: { state: 'latest' } })
  assert.deepEqual(await kept(), { checked: clock.now, seen: { tag: 'v0.1.0-r.11', published: Date.parse('2026-11-30T04:05:06Z') } })
  // While it ran the page was told so, and then what came of it.
  assert.deepEqual(events.map((event) => event.type === 'state' && event.state.checking), [true, false])

  // Pressed again at once: answered from the look just made, without asking GitHub again.
  world.releases = published('v0.1.0-r.12')
  clock.now += RECHECK_AFTER_MS - 1
  assert.equal((await updates.check('person')).finding?.state, 'latest')
  assert.equal(world.asks, 1)
  // A minute on it looks again.
  clock.now += 1
  const second = await updates.check('person')
  assert.equal(world.asks, 2)
  assert.deepEqual(second.finding, { state: 'newer', tag: 'v0.1.0-r.12', name: '0.1.0-r.12', page: 'https://github.com/Longying-2403/StarBench/releases/tag/v0.1.0-r.12', published: Date.parse('2026-11-30T04:05:06Z') })
  assert.equal(second.checked, clock.now)
  // Seen on the page, so no notice is owed for it.
  assert.deepEqual(found(), [])
  assert.equal((await kept()).told, 'v0.1.0-r.12')

  // Two presses while a look runs are one look.
  clock.now += RECHECK_AFTER_MS
  let release!: () => void
  world.hold = new Promise<void>((resolve) => (release = resolve))
  const [a, b] = [updates.check('person'), updates.check('person')]
  assert.equal((await updates.state()).checking, true)
  release()
  assert.deepEqual(await a, await b)
  assert.equal(world.asks, 3)
  assert.equal((await updates.state()).checking, false)
})

test('the app looks by itself only when the person lets it, once a day, and tells of a newer build once', async () => {
  const { clock, world, make, found, kept } = rig()
  let updates = make()
  world.releases = published('v0.1.0-r.12')
  // Not switched on: the app asks nobody.
  assert.equal((await updates.check('app')).finding, undefined)
  assert.equal(world.asks, 0)

  assert.equal((await updates.setAuto(true)).auto, true)
  assert.equal((await kept()).auto, true)
  const first = await updates.check('app')
  assert.equal(world.asks, 1)
  assert.equal(first.finding?.state, 'newer')
  assert.deepEqual(found(), ['v0.1.0-r.12'], 'the person is told')

  // Started again an hour later: it knows of the newer build without asking, and says nothing twice.
  clock.now += 60 * 60 * 1000
  updates = make()
  assert.equal((await updates.state()).finding?.state, 'newer')
  assert.equal((await updates.check('app')).checked, clock.now - 60 * 60 * 1000)
  assert.equal(world.asks, 1)

  // A day after the look it looks again. The same build is no news; a newer one is.
  clock.now += AUTO_CHECK_EVERY_MS
  updates = make()
  await updates.check('app')
  assert.equal(world.asks, 2)
  assert.deepEqual(found(), ['v0.1.0-r.12'])
  clock.now += AUTO_CHECK_EVERY_MS
  world.releases = published('v0.1.0-r.13', 'v0.1.0-r.12')
  await make().check('app')
  assert.deepEqual(found(), ['v0.1.0-r.12', 'v0.1.0-r.13'])

  // Once the person runs that build, what was kept reads as being up to date.
  assert.deepEqual((await make(13).state()).finding, { state: 'latest' })

  // Switched off again, it stops.
  await updates.setAuto(false)
  clock.now += 5 * AUTO_CHECK_EVERY_MS
  const before = world.asks
  await make().check('app')
  assert.equal(world.asks, before)
})

test('a look that fails says why, keeps what was known, and is tried again', async () => {
  const { clock, world, make, found, kept } = rig()
  const updates = make()
  await updates.setAuto(true)
  world.releases = published('v0.1.0-r.11')
  await updates.check('person')
  const known = await kept()

  clock.now += AUTO_CHECK_EVERY_MS
  for (const reason of ['offline', 'limited', 'refused', 'unreadable'] as const) {
    world.releases = new UpdateCheckError(reason, 'no')
    const state = await updates.check('person')
    assert.equal(state.failure, reason)
    assert.deepEqual([state.finding, state.checked], [{ state: 'latest' }, known.checked], 'what the last answer said still stands, with its time')
  }
  assert.deepEqual(await kept(), known, 'a failure is not written down as a look')
  // An error that is not one of the look's own is told as not having got through.
  world.releases = new Error('boom') as UpdateCheckError
  assert.equal((await updates.check('person')).failure, 'offline')

  // After a failure the person may try again at once, and a look that succeeds clears it.
  world.releases = published('v0.1.0-r.12')
  const again = await updates.check('person')
  assert.deepEqual([again.failure, again.finding?.state], [undefined, 'newer'])

  // Of its own accord the app tries once in a run; started again, once more.
  const next = rig()
  await next.make().setAuto(true)
  next.world.releases = new UpdateCheckError('offline', 'no')
  const running = next.make()
  await running.check('app')
  await running.check('app')
  assert.equal(next.world.asks, 1)
  await next.make().check('app')
  assert.equal(next.world.asks, 2)
  assert.deepEqual(next.found(), [])
  assert.deepEqual(found(), [])
})

test('a switch flipped while a look runs is kept together with what the look finds', async () => {
  const { world, make, kept } = rig()
  const updates = make()
  world.releases = published('v0.1.0-r.12')
  let release!: () => void
  world.hold = new Promise<void>((resolve) => (release = resolve))
  // The look is under way when the switch is flipped, twice; both write the same file.
  const looking = updates.check('person')
  const switched = [updates.setAuto(true), updates.setAuto(false), updates.setAuto(true)]
  release()
  const [state] = await Promise.all([looking, ...switched])
  assert.equal(state.finding?.state, 'newer')
  assert.equal((await updates.state()).auto, true)
  const file = await kept()
  assert.deepEqual([file.auto, file.seen, file.told], [true, { tag: 'v0.1.0-r.12', published: Date.parse('2026-11-30T04:05:06Z') }, 'v0.1.0-r.12'])
  // Started anew, it reads back what both left.
  assert.deepEqual([(await make().state()).auto, (await make().state()).finding?.state], [true, 'newer'])
  // No half-written file is left lying beside it.
  assert.deepEqual((await readdir(folder)).filter((name) => name.endsWith('.tmp')), [])
})

test('a kept file that is missing, broken or written by someone else counts for no more than it should', async () => {
  for (const kept of ['not json', '[]', 'null', { auto: 'yes', checked: 'soon', seen: { tag: 'v0.1.0-r12' }, told: 'x' }, { seen: { tag: 'v0.1.0-r.12' } }]) {
    const broken = rig({ kept })
    await broken.ready
    assert.deepEqual(await broken.make().state(), { current: '0.1.0-r.11', auto: false, checking: false }, JSON.stringify(kept))
  }
  // A tag that names no build is not turned into a page, wherever it came from.
  const planted = rig({ kept: { auto: true, checked: 1_799_999_999_000, seen: { tag: 'v0.1.0-r.12/../../../evil/repo', published: 5 }, told: 'v0.1.0-r.12?x' } })
  await planted.ready
  assert.deepEqual(await planted.make().state(), { current: '0.1.0-r.11', auto: true, checking: false, checked: 1_799_999_999_000 })
  // Nothing published at the last look is kept as that, and read back as that.
  const empty = rig()
  empty.world.releases = []
  assert.deepEqual((await empty.make().check('person')).finding, { state: 'none' })
  assert.deepEqual((await empty.make().state()).finding, { state: 'none' })
  assert.equal((await empty.kept()).seen, null)
  // A version that is not three numbers cannot be compared: the checker says so at once.
  assert.throws(() => new UpdateChecker({ file: empty.file, version: 'next', ask: async () => [] }), /not a version/)
})
