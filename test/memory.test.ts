// Run with: node --test test/memory.test.ts
// The memory: notes the model keeps from one conversation to the next (src/shared/memory.ts,
// src/main/memory.ts). What a note's file holds; which notes a conversation goes on seeing once it
// has begun, so that the start of its requests stays the same for the services' caches; how much
// of the list fits; what looks sensitive; the tools a model gets, by what the person let its
// service do; and the commands that come with it (memory-commands/).
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { runTurn, systemPrompt } from '../src/main/agent.ts'
import type { TurnOptions } from '../src/main/agent.ts'
import { MemoryService } from '../src/main/memory.ts'
import type { MemoryTurn } from '../src/main/memory.ts'
import { weigh } from '../src/main/meter.ts'
import { SkillStore, loadSkillTool, parseSkill, skillsPrompt } from '../src/main/skills.ts'
import { ToolRegistry, registerBuiltinTools } from '../src/main/tools.ts'
import {
  LOCAL_UNKNOWN_BUDGET,
  TEXT_MAX,
  cleanMemorySettings,
  findSensitive,
  lineOf,
  listLimit,
  memoryPrompt,
  readEntryFile,
  refreshSnapshot,
  sensitiveLabels,
  writeEntryFile
} from '../src/shared/memory.ts'
import type { MemoryEntry, MemoryEvent, SnapshotEntry } from '../src/shared/memory.ts'
import { VIEW_ONLY_RESULT } from '../src/shared/permissions.ts'
import { estimateTokens } from '../src/shared/stats.ts'
import type { AgentEvent, ToolCall } from '../src/shared/types.ts'

const signal = new AbortController().signal

const entry = (over: Partial<MemoryEntry> & Pick<MemoryEntry, 'id'>): MemoryEntry => ({
  scope: 'global',
  kind: 'feedback',
  text: `note ${over.id}`,
  created: 1000,
  updated: 1000,
  ...over
})

const snap = (over: Partial<SnapshotEntry> & Pick<SnapshotEntry, 'id'>): SnapshotEntry => ({
  scope: 'global',
  kind: 'feedback',
  text: `note ${over.id}`,
  created: 1000,
  updated: 1000,
  ...over
})

// ───────────────────────── The file of a note ─────────────────────────

test("a note's file keeps everything about it, and reads back as it was", () => {
  const note = entry({
    id: 'k3f9',
    kind: 'user',
    text: '写简体中文，人在台湾："不需要" 大陆网络的变通办法',
    details: '第一行\n第二行: 带冒号',
    localOnly: true,
    created: Date.parse('2026-11-24T06:40:00.000Z'),
    updated: Date.parse('2026-11-24T06:41:00.000Z'),
    byUser: Date.parse('2026-11-24T06:42:00.000Z'),
    source: { conversation: 'abc-123', provider: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-flash', local: true }
  })
  const text = writeEntryFile(note)
  assert.match(text, /^---\nname: k3f9\ndescription: ".*"\ntype: user\n/)
  assert.deepEqual(readEntryFile(text, { id: 'k3f9', scope: 'global' }), note)
  // As Git checks it out on Windows.
  assert.deepEqual(readEntryFile(text.replace(/\n/g, '\r\n'), { id: 'k3f9', scope: 'global' }), note)
})

test('a note changed by hand is read as well as can be, and a file that is no note is passed over', () => {
  const read = readEntryFile('---\nname: whatever\ndescription: 手写的一条: 没有引号\ntype: nonsense\n---\n', { id: 'ab12', scope: 'workspace', workspace: 'D:\\w', modified: 5 })
  assert.deepEqual(read, { id: 'ab12', scope: 'workspace', workspace: 'D:\\w', kind: 'project', text: '手写的一条: 没有引号', created: 5, updated: 5 })
  assert.equal(readEntryFile('no front matter at all', { id: 'x', scope: 'global' }), null)
  assert.equal(readEntryFile('---\ntype: user\n---\n', { id: 'x', scope: 'global' }), null, 'a note needs its line')
  const long = readEntryFile(`---\ndescription: ${'长'.repeat(400)}\n---\n${'细'.repeat(2500)}\n`, { id: 'x', scope: 'global' })
  // Kept whole, not refused and not cut: a note read may be written back, and nothing of it may go then.
  assert.equal(long?.text.length, 400)
  assert.equal(long?.details?.length, 2500)
  // In the instructions it takes no more room than a line may, and says that recall has the rest.
  const line = lineOf({ id: 'x', kind: 'user', text: long!.text })
  assert.equal(line, `- [user] ${'长'.repeat(TEXT_MAX - 1)}… #x +`)
})

// ───────────────────────── What a conversation goes on seeing ─────────────────────────

test('a conversation takes in the notes at its first turn and goes on with those, as long as nobody changes them on the page', () => {
  const first = refreshSnapshot(null, [entry({ id: 'a' }), entry({ id: 'b' })], 2000)
  assert.equal(first.changed, true)
  assert.deepEqual(
    first.snapshot.entries.map((e) => e.id),
    ['a', 'b']
  )
  // A model kept one more, and changed one, after the conversation began: it sees neither change.
  const later = refreshSnapshot(first.snapshot, [entry({ id: 'a', text: 'changed by a model', updated: 3000 }), entry({ id: 'b' }), entry({ id: 'c', created: 3000, updated: 3000 })], 4000)
  assert.equal(later.changed, false)
  assert.equal(later.snapshot, first.snapshot, 'the very same notes: the instructions stay as they were')
})

test("what the person wrote or changed on the page counts at the next turn, and a note that is gone is gone, whoever took it away", () => {
  const begun = { takenAt: 2000, entries: [snap({ id: 'a' }), snap({ id: 'b' }), snap({ id: 'gone' })] }
  const now = [
    entry({ id: 'a', text: 'the person changed it', updated: 3000, byUser: 3000 }),
    entry({ id: 'b', text: 'a model changed it', updated: 3000 }),
    entry({ id: 'c', text: 'the person wrote it', created: 3000, updated: 3000, byUser: 3000, source: { user: true } }),
    entry({ id: 'd', text: 'a model wrote it', created: 3000, updated: 3000 }),
    entry({ id: 'e', text: 'a model wrote it, the person changed it', created: 2500, updated: 3500, byUser: 3500 })
  ]
  const { snapshot, changed } = refreshSnapshot(begun, now, 4000)
  assert.equal(changed, true)
  assert.equal(snapshot.takenAt, 4000)
  assert.deepEqual(
    snapshot.entries.map((e) => [e.id, e.text]),
    [
      ['a', 'the person changed it'],
      ['b', 'note b'],
      ['c', 'the person wrote it'],
      ['e', 'a model wrote it, the person changed it']
    ]
  )
})

// ───────────────────────── The list in the instructions ─────────────────────────

test('the list says what the model may do, names each note, and leaves out what was kept for models of one\'s own', () => {
  const entries = [snap({ id: 'g1', text: '回答里不要用表情符号' }), snap({ id: 'w1', scope: 'workspace', kind: 'project', text: '版本写作 0.1.0-rN', details: true, created: 1100 }), snap({ id: 'l1', text: '私事', localOnly: true, created: 1200 })]
  const cloud = memoryPrompt(entries, { mode: 'rw', local: false, limit: 3000 })
  assert.ok(cloud.text?.startsWith('Memory\n'))
  assert.match(cloud.text!, /with remember/)
  assert.match(cloud.text!, /Notes that hold everywhere:\n- \[feedback\] 回答里不要用表情符号 #g1\nNotes about this workspace:\n- \[project\] 版本写作 0\.1\.0-rN #w1 \+$/)
  assert.doesNotMatch(cloud.text!, /私事/)
  assert.deepEqual(cloud.listed, ['g1', 'w1'])
  assert.equal(cloud.left, 0)
  const local = memoryPrompt(entries, { mode: 'rw', local: true, limit: 3000 })
  assert.match(local.text!, /私事 #l1/)
  const readOnly = memoryPrompt(entries, { mode: 'ro', local: false, limit: 3000 })
  assert.doesNotMatch(readOnly.text!, /remember/)
  assert.match(readOnly.text!, /recall/)
  assert.equal(memoryPrompt([], { mode: 'ro', local: false, limit: 3000 }).text, undefined, 'nothing to read and nothing to keep: nothing is said')
  assert.match(memoryPrompt([], { mode: 'rw', local: false, limit: 3000 }).text!, /No notes yet\./)
})

test('when the notes do not fit, those changed longest ago are left out, and the model is told how many it can still find', () => {
  const entries = Array.from({ length: 30 }, (_, i) => snap({ id: `n${String(i).padStart(2, '0')}`, text: `第 ${i} 条，${'字'.repeat(20)}`, created: 1000 + i, updated: 5000 - i }))
  const limit = 200
  const prompt = memoryPrompt(entries, { mode: 'rw', local: false, limit })
  assert.ok(prompt.tokens <= limit)
  assert.ok(prompt.left > 0)
  assert.equal(prompt.listed.length + prompt.left, 30)
  // The newest are kept: n00 was changed last.
  assert.ok(prompt.listed.includes('n00'))
  assert.ok(!prompt.listed.includes('n29'))
  assert.match(prompt.text!, new RegExp(`${prompt.left} more notes are not listed here; recall finds them\\.$`))
  // The same notes always give the same text: listed in the order they were written.
  assert.equal(memoryPrompt([...entries].reverse(), { mode: 'rw', local: false, limit }).text, prompt.text)
})

test('the list may weigh what the person set, but a share of a small context at most, and a modest amount on a server of one\'s own nobody knows the size of', () => {
  assert.equal(listLimit(3000, 128_000, false), 3000)
  assert.equal(listLimit(3000, 32_768, true), 1638)
  assert.equal(listLimit(3000, 8192, true), 409)
  assert.equal(listLimit(500, 32_768, false), 500)
  assert.equal(listLimit(3000, undefined, true), LOCAL_UNKNOWN_BUDGET)
  assert.equal(listLimit(3000, undefined, false), 3000)
})

test('the settings of the memory are read as they should be, whatever the file says', () => {
  assert.deepEqual(cleanMemorySettings(null), { enabled: true, budget: 3000, providers: {} })
  assert.deepEqual(cleanMemorySettings({ enabled: false, budget: 3240, providers: { a: 'ro', b: 'off', c: 'rw', d: 'nonsense' } }), { enabled: false, budget: 3000, providers: { a: 'ro', b: 'off' } })
  assert.equal(cleanMemorySettings({ budget: 99_999 }).budget, 10_000)
  assert.equal(cleanMemorySettings({ budget: 1 }).budget, 500)
})

// ───────────────────────── What looks sensitive ─────────────────────────

test('keys, tokens, passwords and personal data are found where they stand', () => {
  const found = (text: string): string[] => sensitiveLabels(findSensitive(text))
  assert.deepEqual(found('测试用的 Key 是 sk-4f9cA81bE2d7c3F0aa91e21a，放在 .env 里'), ['API Key'])
  assert.deepEqual(found('token ghp_abcdefghijklmnopqrstuvwxyz0123456789'), ['API Key'])
  assert.deepEqual(found('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'), ['令牌'])
  assert.deepEqual(found('-----BEGIN OPENSSH PRIVATE KEY-----'), ['私钥'])
  assert.deepEqual(found('服务器密码：hunter22'), ['密码'])
  assert.deepEqual(found('邮件发到 someone@example.com'), ['电子邮箱'])
  assert.deepEqual(found('身份证 A123456789'), ['身份证号'])
  assert.deepEqual(found('身份证 11010519491231002X'), ['身份证号'])
  assert.deepEqual(found('卡号 4111 1111 1111 1111'), ['信用卡号'])
  assert.deepEqual(found('手机 0912-345-678'), ['手机号'])
  assert.deepEqual(found('手机13812345678'), ['手机号'])
  assert.deepEqual(found('Ab3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vWx'), ['长串随机字符'])
  const marked = findSensitive('key sk-4f9cA81bE2d7c3F0aa91e21a end')[0]
  assert.equal('key sk-4f9cA81bE2d7c3F0aa91e21a end'.slice(marked.start, marked.end), 'sk-4f9cA81bE2d7c3F0aa91e21a')
})

test('what only looks like it at a glance is not taken for sensitive', () => {
  for (const text of [
    '提交是 6127c95e3b1f0a2d4c6e8f0a1b2c3d4e5f6a7b8c',
    '版本写作 0.1.0-r11，N 由用户来定',
    'CI 在 Windows 上检出为 CRLF',
    '身份证 A123456788',
    '卡号 4111 1111 1111 1112',
    '发布在 https://github.com/Longying-2403/StarBench/releases',
    'sk- 开头的是 DeepSeek 和 OpenAI 的 Key'
  ]) {
    assert.deepEqual(findSensitive(text), [], text)
  }
})

// ───────────────────────── The memory at work ─────────────────────────

/** A memory in a fresh folder, with what it tells the page. */
async function freshMemory(options: { now?: () => number; workspaces?: string[] } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'starbench-memory-'))
  const events: MemoryEvent[] = []
  const added: string[] = []
  const skills = {
    addRoot(root: string) {
      added.push(root)
      return () => added.splice(added.indexOf(root), 1)
    }
  }
  const memory = new MemoryService({
    dir,
    commandsDir: path.join(dir, 'commands'),
    skills,
    windows: true,
    ...(options.workspaces ? { workspaces: async () => options.workspaces! } : {}),
    emit: (event) => events.push(event),
    ...(options.now ? { now: options.now } : {})
  })
  await memory.init()
  return { memory, dir, events, added }
}

const turnOf = (over: Partial<MemoryTurn> = {}): MemoryTurn => ({
  session: 'session-1',
  workspace: 'D:\\Projects\\Demo',
  provider: { id: 'cloud', name: 'Cloud', local: false },
  model: 'model-1',
  ...over
})

function baseTools(): ToolRegistry {
  const tools = new ToolRegistry()
  registerBuiltinTools(tools)
  return tools
}

const ctx = { workspace: 'D:\\Projects\\Demo', signal }

test('a model keeps, changes, finds and removes notes; each change is told to the conversation it was made in', async () => {
  const { memory, dir, events } = await freshMemory()
  const { tools, prompt } = await memory.forTurn(turnOf(), baseTools())
  assert.match(prompt!, /No notes yet\./)
  const names = tools.specs().map((t) => t.name)
  for (const name of ['remember', 'forget', 'recall', 'read_file']) assert.ok(names.includes(name), name)
  assert.equal(tools.needsPermission('remember'), false)
  assert.equal(tools.accessOf?.('remember'), 'read', 'never refused, whatever the conversation is set to')

  const saved = await tools.execute('remember', JSON.stringify({ text: '回答里不要用表情符号', kind: 'feedback' }), ctx)
  const id = /#([a-z0-9]{4})/.exec(saved)?.[1]
  assert.ok(id, saved)
  assert.deepEqual(await readdir(path.join(dir, 'global')), [`${id}.md`], 'feedback holds everywhere by default')
  const notice = events.find((e) => e.type === 'notice')
  assert.ok(notice && notice.type === 'notice')
  assert.equal(notice.sessionId, 'session-1')
  assert.equal(notice.change.action, 'saved')
  assert.equal(notice.change.entry.text, '回答里不要用表情符号')

  assert.match(await tools.execute('remember', JSON.stringify({ text: '回答里不要用表情符号', kind: 'feedback' }), ctx), new RegExp(`already note #${id}`))
  const project = await tools.execute('remember', JSON.stringify({ text: '打包前先复制上一版安装包', kind: 'project', details: '因为 npm run dist 会覆盖它' }), ctx)
  const pid = /#([a-z0-9]{4})/.exec(project)![1]
  const folders = await readdir(path.join(dir, 'workspaces'))
  assert.equal(folders.length, 1, 'a project note goes with its workspace')
  assert.match(folders[0], /^Demo-[0-9a-f]{10}$/)

  assert.match(await tools.execute('recall', JSON.stringify({ name: `#${pid}` }), ctx), /因为 npm run dist 会覆盖它/)
  assert.match(await tools.execute('recall', JSON.stringify({ query: '表情' }), ctx), new RegExp(`#${id}`))
  assert.equal(await tools.execute('recall', JSON.stringify({ query: '没有这种东西' }), ctx), 'No note matches.')

  assert.match(await tools.execute('remember', JSON.stringify({ text: '回答里可以用表情符号', kind: 'feedback', replaces: id }), ctx), new RegExp(`Updated note #${id}`))
  assert.match(await readFile(path.join(dir, 'global', `${id}.md`), 'utf8'), /可以用表情符号/)

  assert.match(await tools.execute('remember', JSON.stringify({ text: '太长'.repeat(TEXT_MAX), kind: 'user' }), ctx), /^Error: .*at most 150 characters/)
  assert.match(await tools.execute('remember', JSON.stringify({ text: 'x', kind: 'user', details: '长'.repeat(2001) }), ctx), /^Error: The details/)
  assert.match(await tools.execute('forget', JSON.stringify({ name: 'zzzz' }), ctx), /^Error: There is no note named zzzz/)
  assert.match(await tools.execute('forget', JSON.stringify({ name: id }), ctx), new RegExp(`Removed note #${id}`))
  assert.deepEqual(await readdir(path.join(dir, 'global')), [])
  const last = events.filter((e): e is Extract<MemoryEvent, { type: 'notice' }> => e.type === 'notice').at(-1)
  assert.equal(last?.change.action, 'deleted')
})

test('a conversation keeps the list it began with while models keep notes, so the instructions stay the same; what the person writes counts at the next turn', async () => {
  let clock = 10_000
  const { memory } = await freshMemory({ now: () => clock })
  await memory.save({ scope: 'global', kind: 'user', text: '人在台湾' })
  clock += 10
  const first = await memory.forTurn(turnOf(), baseTools())
  assert.match(first.prompt!, /人在台湾/)
  clock += 10
  await first.tools.execute('remember', JSON.stringify({ text: '回答里不要用表情符号', kind: 'feedback' }), ctx)
  clock += 10
  const second = await memory.forTurn(turnOf(), baseTools())
  assert.equal(second.prompt, first.prompt, 'what the model kept joins from the next conversation on')
  const other = await memory.forTurn(turnOf({ session: 'session-2' }), baseTools())
  assert.match(other.prompt!, /回答里不要用表情符号/)
  clock += 10
  await memory.save({ scope: 'global', kind: 'feedback', text: '提交和推送只在开口后做' })
  clock += 10
  const third = await memory.forTurn(turnOf(), baseTools())
  assert.match(third.prompt!, /提交和推送只在开口后做/)
  assert.doesNotMatch(third.prompt!, /表情符号/, 'what a model kept is still not taken in')
})

test('what a model of one\'s own keeps is for models of one\'s own, unless the person says otherwise', async () => {
  const { memory } = await freshMemory()
  const local = await memory.forTurn(turnOf({ provider: { id: 'qwen', local: true } }), baseTools())
  await local.tools.execute('remember', JSON.stringify({ text: '下个月要去医院复诊', kind: 'user' }), ctx)
  const cloud = await memory.forTurn(turnOf({ session: 'cloud-1' }), baseTools())
  assert.doesNotMatch(cloud.prompt!, /复诊/)
  assert.equal(await cloud.tools.execute('recall', JSON.stringify({ query: '复诊' }), ctx), 'No note matches.')
  const again = await memory.forTurn(turnOf({ session: 'local-2', provider: { id: 'qwen', local: true } }), baseTools())
  assert.match(again.prompt!, /复诊/)
})

test('a service may be let read and write, only read, or neither', async () => {
  const { memory } = await freshMemory()
  await memory.save({ scope: 'global', kind: 'user', text: '人在台湾' })
  await memory.setProviderMode('cloud', 'ro')
  const readOnly = await memory.forTurn(turnOf(), baseTools())
  const names = readOnly.tools.specs().map((t) => t.name)
  assert.ok(names.includes('recall'))
  assert.ok(!names.includes('remember') && !names.includes('forget'))
  assert.doesNotMatch(readOnly.prompt!, /remember/)
  await memory.setProviderMode('cloud', 'off')
  const none = await memory.forTurn(turnOf(), baseTools())
  assert.equal(none.prompt, undefined)
  assert.ok(!none.tools.specs().some((t) => ['remember', 'forget', 'recall'].includes(t.name)))
  await memory.setProviderMode('cloud', 'rw')
  assert.deepEqual((await memory.state()).providers, {})
})

test('switched off, the memory says nothing, offers no tool and takes its commands away; switched on, they are back', async () => {
  const { memory, added } = await freshMemory()
  assert.equal(added.length, 1, 'the commands are offered while it is on')
  await memory.setEnabled(false)
  assert.equal(added.length, 0)
  const off = await memory.forTurn(turnOf(), baseTools())
  assert.equal(off.prompt, undefined)
  assert.ok(!off.tools.specs().some((t) => t.name === 'remember'))
  await memory.setEnabled(true)
  assert.equal(added.length, 1)
})

test('a note that looks sensitive has to be asked about first; any other call is as it was', async () => {
  const { memory } = await freshMemory()
  const { tools } = await memory.forTurn(turnOf(), baseTools())
  assert.equal(tools.mustAsk?.('remember', JSON.stringify({ text: 'Key 是 sk-4f9cA81bE2d7c3F0aa91e21a', kind: 'reference' })), true)
  assert.equal(tools.mustAsk?.('remember', JSON.stringify({ text: '普通的一条', kind: 'reference', details: '邮件 someone@example.com' })), true)
  assert.equal(tools.mustAsk?.('remember', JSON.stringify({ text: '普通的一条', kind: 'reference' })), false)
  assert.equal(tools.mustAsk?.('read_file', JSON.stringify({ path: 'sk-4f9cA81bE2d7c3F0aa91e21a' })), false)
  assert.equal(tools.mustAsk?.('remember', 'not json'), false)
})

test('a change can be undone: a note kept goes, one removed comes back, as the person\'s doing', async () => {
  let clock = 1000
  const { memory, dir, events } = await freshMemory({ now: () => clock })
  const { tools } = await memory.forTurn(turnOf(), baseTools())
  await tools.execute('remember', JSON.stringify({ text: '一条', kind: 'user' }), ctx)
  const saved = events.find((e): e is Extract<MemoryEvent, { type: 'notice' }> => e.type === 'notice')!
  assert.equal(await memory.undo(saved.change.id), true)
  assert.deepEqual(await readdir(path.join(dir, 'global')), [])
  assert.equal(await memory.undo(saved.change.id), false, 'once only')
  const kept = await memory.save({ scope: 'global', kind: 'user', text: '另一条' })
  clock = 2000
  const change = await memory.remove({ id: kept.id, scope: 'global' })
  clock = 3000
  assert.equal(await memory.undo(change), true)
  const back = readEntryFile(await readFile(path.join(dir, 'global', `${kept.id}.md`), 'utf8'), { id: kept.id, scope: 'global' })
  assert.equal(back?.text, '另一条')
  assert.equal(back?.byUser, 3000)
})

test('two changes of one note are undone only from the last back: the first version does not come back', async () => {
  let clock = 1000
  const { memory, events } = await freshMemory({ now: () => clock })
  const { tools } = await memory.forTurn(turnOf(), baseTools())
  const saved = await tools.execute('remember', JSON.stringify({ text: '第一版', kind: 'project' }), ctx)
  const id = /#(\w+)/.exec(saved)![1]
  clock = 2000
  await tools.execute('remember', JSON.stringify({ text: '第二版', kind: 'project', replaces: id }), ctx)
  const [keep, change] = events.filter((e): e is Extract<MemoryEvent, { type: 'notice' }> => e.type === 'notice').map((e) => e.change)
  const notes = async () => (await memory.list(turnOf().workspace, null)).workspaces.flatMap((w) => w.entries).filter((e) => e.id === id)
  // The keeping first: refused, the note stays as it is.
  assert.equal(await memory.undo(keep.id), false)
  assert.deepEqual((await notes()).map((e) => e.text), ['第二版'])
  // From the last back, each goes.
  assert.equal(await memory.undo(change.id), true)
  assert.deepEqual((await notes()).map((e) => e.text), ['第一版'])
  assert.equal(await memory.undo(keep.id), true)
  assert.deepEqual(await notes(), [])
})

test('a note made longer by hand comes back whole when its deletion is undone', async () => {
  const { memory, dir, events } = await freshMemory()
  await mkdir(path.join(dir, 'global'), { recursive: true })
  const line = '长'.repeat(300)
  const details = '细'.repeat(2500)
  await writeFile(path.join(dir, 'global', 'hand.md'), `---\nname: hand\ndescription: "${line}"\ntype: user\nsource: user\n---\n${details}\n`)
  const { tools } = await memory.forTurn(turnOf(), baseTools())
  assert.match(await tools.execute('forget', JSON.stringify({ name: 'hand' }), ctx), /Removed note #hand/)
  const gone = events.filter((e): e is Extract<MemoryEvent, { type: 'notice' }> => e.type === 'notice').at(-1)!
  assert.equal(await memory.undo(gone.change.id), true)
  const back = readEntryFile(await readFile(path.join(dir, 'global', 'hand.md'), 'utf8'), { id: 'hand', scope: 'global' })
  assert.equal(back?.text, line)
  assert.equal(back?.details, details)
})

test('the page sees every note, which workspaces were taken out of the list, and what a new conversation would carry', async () => {
  const { memory } = await freshMemory({ workspaces: ['d:/projects/demo'] })
  await memory.save({ scope: 'global', kind: 'user', text: '人在台湾' })
  await memory.save({ scope: 'workspace', workspace: 'D:\\Projects\\Demo', kind: 'project', text: '版本写作 0.1.0-rN' })
  await memory.save({ scope: 'workspace', workspace: 'D:\\Old', kind: 'project', text: '旧项目' })
  const listing = await memory.list('D:\\Projects\\Demo', { provider: { id: 'cloud', name: 'Cloud', local: false }, window: 128_000 })
  assert.equal(listing.global.length, 1)
  const present = Object.fromEntries(listing.workspaces.map((w) => [w.folder, w.present]))
  assert.deepEqual(present, { 'D:\\Projects\\Demo': true, 'D:\\Old': false }, 'the same folder however it is spelled on Windows')
  assert.equal(listing.use?.listed.length, 2)
  assert.equal(listing.use?.limit, 3000)
  assert.ok((listing.use?.tokens ?? 0) > 0)
})

test("a note the person writes or changes on the page is checked like a model's, and a deleted conversation leaves no list behind", async () => {
  const { memory, dir } = await freshMemory()
  await assert.rejects(memory.save({ scope: 'global', kind: 'user', text: '   ' }), /needs a line/)
  await assert.rejects(memory.save({ scope: 'global', kind: 'nonsense', text: 'x' }), /kinds/)
  await assert.rejects(memory.save({ scope: 'workspace', kind: 'user', text: 'x' }), /folder/)
  const kept = await memory.save({ scope: 'global', kind: 'user', text: '一条' })
  const moved = await memory.save({ id: kept.id, from: { scope: 'global' }, scope: 'workspace', workspace: 'D:\\Projects\\Demo', kind: 'project', text: '一条，改了' })
  assert.equal(moved.scope, 'workspace')
  assert.deepEqual(await readdir(path.join(dir, 'global')), [], 'moved, not copied')
  await memory.forTurn(turnOf(), baseTools())
  assert.deepEqual(await readdir(path.join(dir, 'snapshots')), ['session-1.json'])
  await memory.dropSession('session-1')
  assert.deepEqual(await readdir(path.join(dir, 'snapshots')), [])
})

test('a note written into the folder by hand is a note like the others', async () => {
  const { memory, dir } = await freshMemory()
  await mkdir(path.join(dir, 'global'), { recursive: true })
  await writeFile(path.join(dir, 'global', 'hand.md'), '---\ndescription: 我自己写进文件的一条\ntype: feedback\n---\n')
  await writeFile(path.join(dir, 'global', 'notes.txt'), 'not a note')
  const { prompt } = await memory.forTurn(turnOf(), baseTools())
  assert.match(prompt!, /我自己写进文件的一条 #hand/)
})

// ───────────────────────── In the instructions and in a turn ─────────────────────────

test('what the memory says goes last in the instructions, after the skills, also where the person\'s own prompt stands in place of the app\'s', () => {
  const own = systemPrompt({ workspace: 'D:\\w', extra: 'Skills:\n- a: b', memory: 'Memory\nnotes' })
  assert.ok(own.endsWith('Skills:\n- a: b\n\nMemory\nnotes'))
  const replaced = systemPrompt({ workspace: 'D:\\w', custom: { text: 'Mine', replace: true }, extra: 'Skills:\n- a: b', memory: 'Memory\nnotes' })
  assert.ok(replaced.startsWith('Mine'))
  assert.ok(replaced.endsWith('Memory\nnotes'))
  assert.equal(systemPrompt({ workspace: 'D:\\w' }), systemPrompt({ workspace: 'D:\\w', memory: '' }), 'nothing to say adds nothing')
})

test("the memory's part of the instructions is counted as a part of its own", () => {
  const memory = 'Memory\n- [user] 人在台湾 #ab12'
  const parts = weigh({ system: `App\n\n${memory}`, messages: [], tools: [] }, { memory })
  assert.equal(parts.memory, estimateTokens(memory))
  assert.equal(parts.system, estimateTokens(`App\n\n${memory}`) - estimateTokens(memory))
})

/** A model server that answers each request with the next of the scripted tool calls, then with words. */
async function scriptedModel(t: { after(fn: () => unknown): void }, calls: { name: string; args: object }[]) {
  let served = 0
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      const next = calls[served++]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: object): string => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta }] })}\n\n`
      if (next) res.write(chunk({ tool_calls: [{ index: 0, id: `c${served}`, type: 'function', function: { name: next.name, arguments: JSON.stringify(next.args) } }] }))
      else res.write(chunk({ content: 'done' }))
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function turnWith(baseURL: string, tools: TurnOptions['tools'], mode: 'view' | 'full', asked: ToolCall[]): TurnOptions & { results: string[] } {
  const results: string[] = []
  return {
    results,
    connection: { provider: 'test', kind: 'openai-chat', apiKey: 'test', baseURL, model: 'fake', reasoningEffort: 'default' },
    workspace: os.tmpdir(),
    messages: [{ role: 'user', content: 'go' }],
    signal,
    tools,
    alwaysAllowed: new Set(),
    permissionMode: () => mode,
    emit: (event: AgentEvent) => {
      if (event.type === 'tool_result') results.push(event.output)
    },
    requestPermission: async (call) => {
      asked.push(call)
      return 'always'
    },
    checkpoint: () => {}
  }
}

test('a call that has to be asked about is asked about although the conversation lets everything run, and every time', async (t) => {
  const baseURL = await scriptedModel(t, [
    { name: 'probe', args: { n: 1 } },
    { name: 'probe', args: { n: 2 } }
  ])
  const registry = new ToolRegistry()
  registry.register({ name: 'probe', description: 'A tool that only reads.', needsPermission: false, run: () => 'ran' }, 'test')
  const tools: TurnOptions['tools'] = {
    specs: () => registry.specs(),
    needsPermission: (name) => registry.needsPermission(name),
    execute: (name, raw, c) => registry.execute(name, raw, c),
    accessOf: (name) => registry.accessOf(name),
    mustAsk: (name) => name === 'probe'
  }
  const asked: ToolCall[] = []
  const turn = turnWith(baseURL, tools, 'full', asked)
  await runTurn(turn)
  assert.equal(asked.length, 2, '"always" does not let the next one through unasked')
  assert.deepEqual(turn.results, ['ran', 'ran'])
})

test('a call the conversation does not let run is not run, whether or not it would have to be asked about', async (t) => {
  const baseURL = await scriptedModel(t, [{ name: 'changer', args: {} }])
  const registry = new ToolRegistry()
  registry.register({ name: 'changer', description: 'A tool that changes things.', needsPermission: true, run: () => 'ran' }, 'test')
  const tools: TurnOptions['tools'] = {
    specs: () => registry.specs(),
    needsPermission: (name) => registry.needsPermission(name),
    execute: (name, raw, c) => registry.execute(name, raw, c),
    accessOf: (name) => registry.accessOf(name),
    mustAsk: () => true
  }
  const asked: ToolCall[] = []
  const turn = turnWith(baseURL, tools, 'view', asked)
  await runTurn(turn)
  assert.equal(asked.length, 0)
  assert.deepEqual(turn.results, [VIEW_ONLY_RESULT])
})

// ───────────────────────── Commands ─────────────────────────

test('a skill only the person picks is a command: listed for them, kept from the model, and not loaded by it', async () => {
  assert.equal(parseSkill('---\nname: a\ndescription: d\nuser-only: true\n---\nB').userOnly, true)
  assert.equal(parseSkill('---\nname: a\ndescription: d\ndisable-model-invocation: true\n---\nB').userOnly, true)
  assert.equal(parseSkill('---\nname: a\ndescription: d\n---\nB').userOnly, undefined)
  const root = await mkdtemp(path.join(os.tmpdir(), 'starbench-commands-'))
  await mkdir(path.join(root, 'cmd'), { recursive: true })
  await writeFile(path.join(root, 'cmd', 'SKILL.md'), '---\nname: cmd\ndescription: A command.\nuser-only: true\n---\nDo it.')
  await mkdir(path.join(root, 'skill'), { recursive: true })
  await writeFile(path.join(root, 'skill', 'SKILL.md'), '---\nname: skill\ndescription: A skill.\n---\nDo that.')
  const store = new SkillStore(root)
  const listed = await store.list()
  assert.deepEqual(
    listed.map((s) => [s.name, Boolean(s.userOnly)]),
    [
      ['cmd', true],
      ['skill', false]
    ]
  )
  const prompt = skillsPrompt(listed)
  assert.match(prompt, /- skill: A skill\./)
  assert.doesNotMatch(prompt, /cmd/)
  assert.equal(skillsPrompt(listed.filter((s) => s.userOnly)), '', 'only commands: no list at all')
  const load = loadSkillTool(store)
  await assert.rejects(Promise.resolve(load.run({ name: 'cmd' }, ctx)), /only the user picks/)
  assert.match(String(await load.run({ name: 'skill' }, ctx)), /Do that\./)
  // What the person picks is still loaded for them, as before.
  assert.match(await store.load('cmd'), /Do it\./)
})

test('the commands that come with the memory are commands, found under their names, and say briefly what they are for', async () => {
  const dir = path.resolve('memory-commands')
  const folders = (await readdir(dir)).sort()
  assert.deepEqual(folders, ['memory', 'memory-add', 'memory-del', 'memory-edit'])
  const listed = await new SkillStore(path.join(await mkdtemp(path.join(os.tmpdir(), 'starbench-none-')), 'skills'), dir).list()
  assert.deepEqual(listed.map((s) => s.name).sort(), folders)
  for (const skill of listed) {
    assert.equal(skill.userOnly, true, `${skill.name} is only the person's to pick`)
    const parsed = parseSkill(await readFile(path.join(dir, skill.name, 'SKILL.md'), 'utf8'))
    assert.equal(parsed.name, skill.name)
    assert.ok(skill.description.length >= 20 && skill.description.length <= 200, `${skill.name}: ${skill.description.length}`)
    // Each tells the model which of the memory's tools to use.
    assert.match(parsed.body, /`(remember|forget|recall)`/)
  }
})

test("a note's line is what the instructions show of it", () => {
  assert.equal(lineOf({ id: 'ab12', kind: 'user', text: '人在台湾' }), '- [user] 人在台湾 #ab12')
  assert.equal(lineOf({ id: 'ab12', kind: 'project', text: 'x', details: true }), '- [project] x #ab12 +')
})
