// The record of what was asked of the model services and the balances DeepSeek tells: how the
// record adds up and what it keeps (shared/usage.ts), the one request to DeepSeek against a
// stand-in that answers as DeepSeek does and as it must not, and what the app keeps and says
// between the requests (main/usage.ts).
// Run with: node --test test/usage.test.ts
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { BalanceError, UsageService, askDeepSeekBalance, registerUsageIpc } from '../src/main/usage.ts'
import type { UsageProvider } from '../src/main/usage.ts'
import {
  DEEPSEEK_BALANCE_URL,
  KEEP_MONTHS,
  addToLog,
  balanceServiceOf,
  balanceTone,
  cleanLog,
  dayKey,
  emptyLog,
  firstDayOf,
  firstKeptDay,
  formatMoney,
  isAlertAmount,
  otherBalances,
  pruneLog,
  readDeepSeekBalance,
  summarize,
  usagePageOf
} from '../src/shared/usage.ts'
import type { UsageEvent, UsageLog } from '../src/shared/usage.ts'

const dirs: string[] = []
const servers: http.Server[] = []
after(async () => {
  for (const server of servers) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})
const tempFile = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'starbench-usage-'))
  dirs.push(dir)
  return path.join(dir, 'usage.json')
}

/** A moment by the computer's own calendar: noon of the day given. */
const at = (year: number, month: number, day: number, hour = 12): number => new Date(year, month - 1, day, hour).getTime()

test('days are told by the computer’s own calendar, and each stretch of time ends today', () => {
  assert.equal(dayKey(at(2026, 11, 24, 0)), '2026-11-24')
  assert.equal(dayKey(at(2026, 11, 24, 23)), '2026-11-24')
  assert.equal(dayKey(at(2026, 1, 5)), '2026-01-05')
  const now = at(2026, 11, 24)
  assert.equal(firstDayOf('today', now), '2026-11-24')
  assert.equal(firstDayOf('month', now), '2026-11-01')
  // Thirty days with today among them.
  assert.equal(firstDayOf('days30', now), '2026-10-26')
  assert.equal(firstDayOf('days30', at(2026, 3, 10)), '2026-02-09')
  assert.equal(KEEP_MONTHS, 12)
  assert.equal(firstKeptDay(now), '2025-11-24')
})

test('a request is counted by day, service and model, with what the service said it cost', () => {
  const start = emptyLog()
  let log = addToLog(start, { at: at(2026, 11, 24), provider: 'deepseek', name: 'DeepSeek', model: 'deepseek-flash', usage: { input: 100, cacheRead: 900, output: 50, reasoning: 20 } })
  log = addToLog(log, { at: at(2026, 11, 24, 18), provider: 'deepseek', name: 'DeepSeek', model: 'deepseek-flash', usage: { input: 10, cacheRead: 90, output: 5 } })
  // A service that says nothing of what a request cost: the request is counted, and that it said nothing.
  log = addToLog(log, { at: at(2026, 11, 24), provider: 'local', name: 'Ollama', model: 'qwen3.5:9b' })
  assert.deepEqual(start, emptyLog(), 'the record given is left as it was')
  assert.deepEqual(log.days['2026-11-24'].deepseek['deepseek-flash'], { requests: 2, input: 110, cacheRead: 990, output: 55, reasoning: 20 })
  assert.deepEqual(log.days['2026-11-24'].local['qwen3.5:9b'], { requests: 1, untold: 1 })
  assert.deepEqual(log.names, { deepseek: 'DeepSeek', local: 'Ollama' })
  // The latest name is the one kept.
  log = addToLog(log, { at: at(2026, 11, 25), provider: 'deepseek', name: 'DeepSeek（工作）', model: 'deepseek-flash', usage: { input: 1 } })
  assert.equal(log.names.deepseek, 'DeepSeek（工作）')
})

test('the name of a model or service is a key like any other, whatever it is', () => {
  let log = addToLog(emptyLog(), { at: at(2026, 11, 24), provider: '__proto__', name: 'odd', model: '__proto__', usage: { output: 3 } })
  log = addToLog(log, { at: at(2026, 11, 24), provider: 'constructor', model: 'toString', usage: { output: 4 } })
  assert.equal(Object.getPrototypeOf(log.days), Object.prototype)
  assert.deepEqual(Object.keys(log.days['2026-11-24']), ['__proto__', 'constructor'])
  const rows = summarize(cleanLog(JSON.parse(JSON.stringify(log))), 'today', at(2026, 11, 24)).rows
  // Each was asked once: in the order of their names, "constructor" (it has no other) before "odd".
  assert.deepEqual(
    rows.map((row) => [row.provider, row.name, row.model, row.output]),
    [
      ['constructor', 'constructor', 'toString', 4],
      ['__proto__', 'odd', '__proto__', 3]
    ]
  )
})

test('the record goes back twelve months, and forgets the names of services it no longer counts', () => {
  let log: UsageLog = emptyLog()
  log = addToLog(log, { at: at(2025, 11, 23), provider: 'old', name: 'Gone', model: 'm', usage: { input: 1 } })
  log = addToLog(log, { at: at(2025, 11, 24), provider: 'kept', name: 'Kept', model: 'm', usage: { input: 1 } })
  const pruned = pruneLog(log, at(2026, 11, 24))
  assert.deepEqual(Object.keys(pruned.days), ['2025-11-24'])
  assert.deepEqual(pruned.names, { kept: 'Kept' })
})

test('a stretch of time is added up by model, the services asked the most first', () => {
  let log = emptyLog()
  const add = (when: number, provider: string, name: string, model: string, usage?: { input?: number; output?: number }): void => {
    log = addToLog(log, { at: when, provider, name, model, ...(usage ? { usage } : {}) })
  }
  add(at(2026, 11, 24), 'gemini', 'Gemini', 'flash', { input: 5, output: 1 })
  add(at(2026, 11, 24), 'deepseek', 'DeepSeek', 'deepseek-flash', { input: 10, output: 2 })
  add(at(2026, 11, 23), 'deepseek', 'DeepSeek', 'deepseek-flash', { input: 10, output: 2 })
  add(at(2026, 11, 2), 'deepseek', 'DeepSeek', 'deepseek-pro', { input: 7, output: 7 })
  add(at(2026, 10, 30), 'deepseek', 'DeepSeek', 'deepseek-pro', { input: 1000, output: 1000 })
  add(at(2026, 9, 1), 'gemini', 'Gemini', 'flash', { input: 99, output: 99 })
  const now = at(2026, 11, 24)

  const today = summarize(log, 'today', now)
  assert.equal(today.from, '2026-11-24')
  assert.equal(today.to, '2026-11-24')
  assert.deepEqual(
    today.rows.map((row) => `${row.name}/${row.model}/${row.requests}`),
    ['DeepSeek/deepseek-flash/1', 'Gemini/flash/1']
  )

  const month = summarize(log, 'month', now)
  assert.deepEqual(
    month.rows.map((row) => `${row.name}/${row.model}/${row.requests}/${row.input}`),
    ['DeepSeek/deepseek-flash/2/20', 'DeepSeek/deepseek-pro/1/7', 'Gemini/flash/1/5']
  )
  assert.equal(month.since, '2026-09-01', 'the first day anything was counted on')

  const days30 = summarize(log, 'days30', now)
  // Two models asked as often: in the order of their names.
  assert.deepEqual(
    days30.rows.map((row) => `${row.model}/${row.requests}`),
    ['deepseek-flash/2', 'deepseek-pro/2', 'flash/1']
  )
  // A day that has not come yet (the clock was set back) is in no stretch.
  add(at(2026, 11, 30), 'gemini', 'Gemini', 'flash', { input: 1 })
  assert.equal(summarize(log, 'today', now).rows.length, 2)
})

test('what is read back from the file keeps only what is as it should be', () => {
  const log = cleanLog({
    days: {
      '2026-11-24': {
        deepseek: { 'deepseek-flash': { requests: 3, input: 30, output: -1, reasoning: 'many', untold: 0 }, broken: { requests: 0 }, worse: 'x' },
        '': { m: { requests: 1 } }
      },
      yesterday: { deepseek: { m: { requests: 1 } } },
      '2026-11-23': null
    },
    names: { deepseek: 'DeepSeek', empty: '  ', other: 4 }
  })
  assert.deepEqual(log, { days: { '2026-11-24': { deepseek: { 'deepseek-flash': { requests: 3, input: 30 } } } }, names: { deepseek: 'DeepSeek' } })
  assert.deepEqual(cleanLog(null), emptyLog())
  assert.deepEqual(cleanLog('text'), emptyLog())
})

test('DeepSeek’s answer is read as it writes it, amounts as text', () => {
  // As in DeepSeek's documentation of GET /user/balance.
  const told = readDeepSeekBalance({
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }]
  })
  assert.deepEqual(told, { available: true, balances: [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }] })
  // An entry that says no amount, or no currency, is left out; one with fewer parts is kept as far as it goes.
  const partial = readDeepSeekBalance({
    is_available: false,
    balance_infos: [{ currency: 'USD', total_balance: '0.00' }, { currency: 'usd', total_balance: '1' }, { total_balance: '3' }, null, { currency: 'CNY', total_balance: 'lots' }]
  })
  assert.deepEqual(partial, { available: false, balances: [{ currency: 'USD', total: 0 }] })
  // As DeepSeek answered for an account paid in yuan: the dollars it lists at nought come after, and get no line of their own.
  const both = readDeepSeekBalance({
    is_available: true,
    balance_infos: [
      { currency: 'USD', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' },
      { currency: 'CNY', total_balance: '42.10', granted_balance: '0.00', topped_up_balance: '42.10' }
    ]
  })
  assert.deepEqual(
    both.balances.map((b) => b.currency),
    ['CNY', 'USD']
  )
  assert.deepEqual(otherBalances(both.balances), [])
  const nothing = readDeepSeekBalance({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0.00' }, { currency: 'USD', total_balance: '0.00' }] })
  assert.deepEqual(
    nothing.balances.map((b) => b.currency),
    ['CNY', 'USD'],
    'with nothing anywhere, DeepSeek’s order'
  )
  assert.deepEqual(otherBalances([{ currency: 'CNY', total: 1 }, { currency: 'USD', total: 2 }]), [{ currency: 'USD', total: 2 }])
  assert.throws(() => readDeepSeekBalance({ balance_infos: [] }))
  assert.throws(() => readDeepSeekBalance({ is_available: true }))
  assert.throws(() => readDeepSeekBalance('110.00'))
})

test('only DeepSeek’s own service tells its balance, and never through a ChatGPT sign-in', () => {
  assert.equal(balanceServiceOf({ baseURL: 'https://api.deepseek.com' }), 'deepseek')
  assert.equal(balanceServiceOf({ baseURL: 'https://api.deepseek.com/v1' }), 'deepseek')
  assert.equal(balanceServiceOf({ baseURL: 'https://api.deepseek.com.example.com' }), undefined)
  assert.equal(balanceServiceOf({ baseURL: 'https://api.openai.com/v1' }), undefined)
  assert.equal(balanceServiceOf({ baseURL: 'http://localhost:11434/v1' }), undefined)
  assert.equal(balanceServiceOf({ baseURL: 'https://api.deepseek.com', auth: 'chatgpt' }), undefined)
  assert.equal(DEEPSEEK_BALANCE_URL, 'https://api.deepseek.com/user/balance')
})

test('the balance looks like an error while DeepSeek takes no calls, like a warning below the line', () => {
  const balances = [{ currency: 'CNY', total: 3.12 }]
  assert.equal(balanceTone(null), undefined)
  assert.equal(balanceTone({ provider: 'd', available: true, balances }), undefined)
  assert.equal(balanceTone({ provider: 'd', available: true, balances, alert: 5 }), 'warn')
  assert.equal(balanceTone({ provider: 'd', available: true, balances, alert: 3 }), undefined)
  assert.equal(balanceTone({ provider: 'd', available: false, balances, alert: 1 }), 'danger')
  assert.equal(formatMoney(23.475, 'CNY'), '¥23.48')
  assert.equal(formatMoney(5, 'USD'), '$5.00')
  assert.equal(formatMoney(1234.5, 'CNY'), '¥1,234.50')
  assert.equal(formatMoney(-2, 'USD'), '-$2.00')
  assert.equal(formatMoney(7, 'EUR'), 'EUR 7.00')
  assert.ok(isAlertAmount(5) && isAlertAmount(0.5))
  assert.ok(!isAlertAmount(0) && !isAlertAmount(-1) && !isAlertAmount(Number.NaN) && !isAlertAmount('5') && !isAlertAmount(2_000_000))
})

test('each service links the page where it shows what was used', () => {
  assert.equal(usagePageOf({ baseURL: 'https://api.deepseek.com' }), 'https://platform.deepseek.com/usage')
  assert.equal(usagePageOf({ baseURL: 'https://api.openai.com/v1' }), 'https://platform.openai.com/usage')
  assert.equal(usagePageOf({ baseURL: 'https://chatgpt.com/backend-api/codex', auth: 'chatgpt' }), 'https://chatgpt.com/settings/usage')
  assert.equal(usagePageOf({ baseURL: 'https://api.anthropic.com' }), 'https://platform.claude.com/usage')
  assert.equal(usagePageOf({ baseURL: 'https://us.api.x.ai/v1' }), 'https://console.x.ai/')
  assert.equal(usagePageOf({ baseURL: 'https://generativelanguage.googleapis.com/v1beta' }), 'https://aistudio.google.com/')
  assert.equal(usagePageOf({ baseURL: 'http://localhost:11434/v1' }), undefined)
})

// ── The request to DeepSeek, against a stand-in ─────────────────────────────────────────────

/** A stand-in for DeepSeek that answers each request with what `reply` says, and keeps what it was sent. */
async function standIn(reply: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ url: string; seen: { path?: string; auth?: string }[] }> {
  const seen: { path?: string; auth?: string }[] = []
  const server = http.createServer((req, res) => {
    seen.push({ ...(req.url ? { path: req.url } : {}), ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) })
    reply(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

test('the balance is asked with the key in its header, and the answer is read as it comes', async () => {
  const server = await standIn((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '23.48', granted_balance: '3.48', topped_up_balance: '20.00' }] }))
  })
  const answer = await askDeepSeekBalance('sk-test', { url: `${server.url}/user/balance` })
  assert.deepEqual(readDeepSeekBalance(answer).balances, [{ currency: 'CNY', total: 23.48, granted: 3.48, toppedUp: 20 }])
  assert.deepEqual(server.seen, [{ path: '/user/balance', auth: 'Bearer sk-test' }])
})

test('a key DeepSeek turns down, a refusal, an answer that is no balance and a redirect each come to nothing with their reason', async () => {
  const reason = async (reply: (res: http.ServerResponse) => void): Promise<string> => {
    const server = await standIn((_req, res) => reply(res))
    try {
      await askDeepSeekBalance('sk-test', { url: `${server.url}/user/balance` })
      return 'answered'
    } catch (err) {
      assert.ok(err instanceof BalanceError)
      assert.doesNotMatch(err.message, /sk-test/, 'the key is in no message')
      return err.problem
    }
  }
  assert.equal(await reason((res) => (res.writeHead(401), res.end('{"error":{"message":"Authentication Fails"}}'))), 'key')
  assert.equal(await reason((res) => (res.writeHead(429), res.end())), 'limited')
  assert.equal(await reason((res) => (res.writeHead(503), res.end())), 'refused')
  assert.equal(await reason((res) => (res.writeHead(200), res.end('<html>'))), 'unreadable')
  // Sent on to another address: not followed, so the key goes nowhere else.
  const elsewhere = await standIn((_req, res) => (res.writeHead(200), res.end('{}')))
  assert.equal(await reason((res) => (res.writeHead(302, { location: `${elsewhere.url}/steal` }), res.end())), 'offline')
  assert.deepEqual(elsewhere.seen, [])
})

// ── What the app keeps and says ─────────────────────────────────────────────────────────────

const DEEPSEEK: UsageProvider = { id: 'deepseek', name: 'DeepSeek', baseURL: 'https://api.deepseek.com', hasApiKey: true }
const OPENAI: UsageProvider = { id: 'openai', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', hasApiKey: true }

/**
 * A service with a stand-in for DeepSeek that answers with `totals` in turn, a clock that moves
 * when told, and what it said to the page. The looks at the balance are switched on, as the
 * person does on the usage page, unless `balance` is false.
 */
async function setUp(options: { totals?: (number | Error)[]; providers?: UsageProvider[]; key?: string | null; file?: string; balance?: boolean } = {}) {
  const file = options.file ?? (await tempFile())
  const clock = { now: at(2026, 11, 24) }
  const events: UsageEvent[] = []
  const asked: string[] = []
  const totals = [...(options.totals ?? [])]
  const service = new UsageService({
    file,
    providers: async () => options.providers ?? [DEEPSEEK, OPENAI],
    keyOf: async () => (options.key === undefined ? 'sk-test' : options.key),
    askBalance: async (key) => {
      asked.push(key)
      const next = totals.shift() ?? 10
      if (next instanceof Error) throw next
      return { is_available: next > 0, balance_infos: [{ currency: 'CNY', total_balance: next.toFixed(2) }] }
    },
    emit: (event) => events.push(event),
    now: () => clock.now
  })
  if (options.balance !== false) {
    await service.setBalance(true)
    events.length = 0
  }
  return { service, file, clock, events, asked }
}

test('the balance is not asked until the person switches that on, and the choice is kept', async () => {
  const { service, file, asked, events } = await setUp({ balance: false })
  assert.deepEqual(await service.settings(), { balance: false })
  assert.equal((await service.balance('deepseek')).problem, 'off')
  assert.equal((await service.balance('deepseek', true)).problem, 'off')
  // A line can be set meanwhile; it waits.
  await service.setAlert('deepseek', 5)
  await service.turnEnded('deepseek', true)
  assert.equal(asked.length, 0, 'nothing went to DeepSeek')
  assert.deepEqual(await service.setBalance(true), { balance: true })
  assert.deepEqual(
    events.filter((e) => e.type === 'settings'),
    [{ type: 'settings', settings: { balance: true } }]
  )
  assert.equal((await service.balance('deepseek')).balances?.[0].total, 10)
  assert.equal(asked.length, 1)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).balance, true)
  const again = await setUp({ file, balance: false })
  assert.deepEqual(await again.service.settings(), { balance: true }, 'kept across runs')
})

test('switched off, what DeepSeek said is forgotten and a look under way is not taken up', async () => {
  const events: UsageEvent[] = []
  let answer: (value: unknown) => void = () => {}
  const service = new UsageService({
    file: await tempFile(),
    providers: async () => [DEEPSEEK],
    keyOf: async () => 'sk-test',
    askBalance: () => new Promise((resolve) => (answer = resolve)),
    emit: (event) => events.push(event)
  })
  await service.setBalance(true)
  await service.setAlert('deepseek', 100)
  const pending = service.balance('deepseek')
  // Until the look has reached DeepSeek.
  await new Promise((resolve) => setImmediate(resolve))
  await service.setBalance(false)
  answer({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '5.00' }] })
  const state = await pending
  assert.equal(state.problem, 'off')
  assert.equal(state.balances, undefined)
  assert.deepEqual(
    events.filter((e) => e.type === 'low'),
    [],
    'below the line, and nobody is told'
  )
  assert.equal((await service.balance('deepseek')).balances, undefined)
})

test('what was counted is written to the file at once and read back by the next run', async () => {
  const { service, file, events } = await setUp()
  service.record({ provider: 'deepseek', model: 'deepseek-flash', usage: { input: 10, cacheRead: 90, output: 5 } }, 'DeepSeek')
  service.record({ provider: 'deepseek', model: 'deepseek-flash' }, 'DeepSeek')
  await service.settled()
  assert.deepEqual(
    events.filter((e) => e.type === 'changed'),
    [{ type: 'changed' }, { type: 'changed' }]
  )
  const kept = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(kept.days['2026-11-24'].deepseek['deepseek-flash'], { requests: 2, input: 10, cacheRead: 90, output: 5, untold: 1 })
  assert.doesNotMatch(JSON.stringify(kept), /sk-test/)
  const again = (await setUp({ file })).service
  assert.deepEqual((await again.summary('today')).rows.map((r) => [r.name, r.requests]), [['DeepSeek', 2]])
})

test('a balance stands for a minute, a press asks again after a few seconds, and two looks never run at once', async () => {
  const { service, clock, asked, events } = await setUp({ totals: [23.48, 20, 19] })
  const [one, two] = await Promise.all([service.balance('deepseek'), service.balance('deepseek')])
  assert.equal(asked.length, 1)
  assert.deepEqual(one, two)
  assert.deepEqual(one, { provider: 'deepseek', at: clock.now, available: true, balances: [{ currency: 'CNY', total: 23.48 }] })
  assert.deepEqual(
    events.map((e) => (e.type === 'balance' ? Boolean(e.state.checking) : e.type)),
    [true, false],
    'the page is told that a look began and how it ended'
  )
  clock.now += 2_000
  assert.equal((await service.balance('deepseek', true)).balances?.[0].total, 23.48, 'pressed again at once: the answer of a moment ago')
  clock.now += 2_000
  assert.equal((await service.balance('deepseek', true)).balances?.[0].total, 20)
  clock.now += 30_000
  assert.equal((await service.balance('deepseek')).balances?.[0].total, 20, 'by itself: not within the minute')
  clock.now += 31_000
  assert.equal((await service.balance('deepseek')).balances?.[0].total, 19)
  assert.equal(asked.length, 3)
  assert.deepEqual(asked, ['sk-test', 'sk-test', 'sk-test'])
})

test('a look that fails keeps what was known with its reason; a service without a balance or a key is not asked', async () => {
  const { service, clock, asked } = await setUp({ totals: [12, new BalanceError('offline', 'no network')] })
  await service.balance('deepseek')
  clock.now += 61_000
  const failed = await service.balance('deepseek')
  assert.equal(failed.problem, 'offline')
  assert.equal(failed.balances?.[0].total, 12)
  assert.equal(failed.at, at(2026, 11, 24))
  clock.now += 61_000
  const next = await service.balance('deepseek')
  assert.equal(next.problem, undefined, 'the reason goes with the next answer')
  assert.equal(asked.length, 3)

  assert.equal((await service.balance('openai')).problem, 'unsupported')
  assert.equal((await service.balance('missing')).problem, 'unsupported')
  assert.equal(asked.length, 3)
  const keyless = await setUp({ key: null })
  assert.equal((await keyless.service.balance('deepseek')).problem, 'key')
  assert.equal(keyless.asked.length, 0)
  const stored = await setUp({ providers: [{ ...DEEPSEEK, hasApiKey: false }] })
  assert.equal((await stored.service.balance('deepseek')).problem, 'key')
  assert.equal(stored.asked.length, 0)
  const unreadable = await setUp({ totals: [new Error('not a balance')] })
  assert.equal((await unreadable.service.balance('deepseek')).problem, 'unreadable')
})

test('below the line the person is told once, again only after it was above; a line just set says nothing', async () => {
  const { service, clock, events, file } = await setUp({ totals: [8, 4, 3, 9, 2] })
  const low = (): UsageEvent[] => events.filter((e) => e.type === 'low')
  const next = async (): Promise<void> => {
    clock.now += 61_000
    await service.balance('deepseek')
  }
  await service.balance('deepseek')
  // Set at 10 while the balance is 8: the two are side by side on the page, nothing more is said.
  const set = await service.setAlert('deepseek', 10)
  assert.equal(set.alert, 10)
  assert.equal(balanceTone(set), 'warn')
  assert.deepEqual(low(), [])
  await service.setAlert('deepseek', 5)
  await next() // 4: below 5
  assert.deepEqual(low(), [{ type: 'low', provider: 'deepseek', name: 'DeepSeek', balance: { currency: 'CNY', total: 4 }, alert: 5 }])
  await next() // 3: still below, already told
  assert.equal(low().length, 1)
  await next() // 9: above again
  // The line and what was said of it are kept across runs.
  await service.settled()
  const kept = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual([kept.alerts, kept.warned], [{ deepseek: 5 }, []])
  await next() // 2: below again
  assert.equal(low().length, 2)
  await service.setAlert('deepseek', null)
  assert.equal((await service.balance('deepseek')).alert, undefined)
  await assert.rejects(service.setAlert('deepseek', 0))
  await assert.rejects(service.setAlert('deepseek', '5'))
})

test('emptying the record keeps the lines', async () => {
  const { service, file } = await setUp()
  service.record({ provider: 'deepseek', model: 'm', usage: { input: 1 } }, 'DeepSeek')
  await service.setAlert('deepseek', 5)
  await service.clear()
  assert.deepEqual((await service.summary('month')).rows, [])
  const kept = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual([kept.days, kept.names, kept.alerts], [{}, {}, { deepseek: 5 }])
})

test('after a turn the balance is asked only where something shows it or a line waits on it', async () => {
  const hidden = await setUp()
  await hidden.service.turnEnded('deepseek', false)
  assert.equal(hidden.asked.length, 0)
  await hidden.service.turnEnded('deepseek', true)
  assert.equal(hidden.asked.length, 1)
  await hidden.service.turnEnded('openai', true)
  assert.equal(hidden.asked.length, 1)
  const lined = await setUp()
  await lined.service.setAlert('deepseek', 5)
  await lined.service.turnEnded('deepseek', false)
  assert.equal(lined.asked.length, 1)
})

test('a broken file counts as empty, and the record it is rebuilt into is kept', async () => {
  const file = await tempFile()
  await writeFile(file, '{ not json')
  const { service } = await setUp({ file })
  assert.deepEqual((await service.summary('month')).rows, [])
  service.record({ provider: 'deepseek', model: 'm', usage: { output: 1 } })
  await service.settled()
  assert.equal(JSON.parse(await readFile(file, 'utf8')).days['2026-11-24'].deepseek.m.output, 1)
})

test('the page reaches the record by the channels the preload script asks on', async () => {
  const handled = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const { service } = await setUp()
  registerUsageIpc({ handle: (channel, listener) => handled.set(channel, listener) }, service)
  const preload = await readFile(path.resolve('src/preload/index.ts'), 'utf8')
  const asked = [...preload.matchAll(/invoke\('(usage:[A-Za-z]+)'/g)].map((m) => m[1])
  assert.deepEqual(asked.sort(), [...handled.keys()].sort())
  // What arrives from the page is not trusted to be what it should be.
  assert.equal(((await handled.get('usage:summary')!(null, 'decade')) as { range: string }).range, 'month')
  assert.equal(((await handled.get('usage:balance')!(null, undefined)) as { problem: string }).problem, 'unsupported')
})
