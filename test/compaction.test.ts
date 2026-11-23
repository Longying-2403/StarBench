// Run with: node --test test/compaction.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CARRY_ON, SAID_BEFORE, carriedTokens, compact, dropThinking, fitTokens, saysTooLong, sendable, storedWeight, summaryPrompt, windowSaid } from '../src/main/compaction.ts'
import type { CompactJob } from '../src/main/compaction.ts'
import { weigh } from '../src/main/meter.ts'
import { chatMessages } from '../src/main/providers/chat.ts'
import { thinkingReturns } from '../src/main/providers/history.ts'
import type { Connection } from '../src/main/providers/index.ts'
import { itemsFromMessages, itemsReducer, lastSummaryAt } from '../src/renderer/src/items.ts'
import type { Item } from '../src/renderer/src/items.ts'
import { COMPACTION_DEFAULTS, SUMMARY_CLOSE, SUMMARY_OPEN, compactFrom, readShare } from '../src/shared/compaction.ts'
import { addCompaction, addStep, contextView, emptyStats, estimateTokens, expected, fitParts, fitTo, halves, partsTotal } from '../src/shared/stats.ts'
import type { Fit } from '../src/shared/stats.ts'
import type { ChatMessage, CompactionMark, StoredMessage, ToolCall } from '../src/shared/types.ts'

type Assistant = Extract<ChatMessage, { role: 'assistant' }>
type Result = Extract<ChatMessage, { role: 'tool' }>

const user = (content: string): StoredMessage => ({ role: 'user', content })
const reads = (id: string, file: string): ToolCall => ({ id, name: 'read_file', arguments: JSON.stringify({ path: file }) })
const says = (content: string, calls: ToolCall[] = [], origin?: Assistant['origin']): Assistant => ({
  role: 'assistant',
  content,
  ...(calls.length ? { tool_calls: calls } : {}),
  ...(origin ? { origin } : {})
})
const result = (id: string, content: string): Result => ({ role: 'tool', tool_call_id: id, content })
/** The line that stands in the place of a cleared result that was `chars` long. */
const note = (chars: number): string => `[Result cleared to save room in the context: ${chars} characters. Read or run it again if it is needed.]`
/** A text of that many tokens, as the app guesses: four Latin letters to a token. */
const words = (tokens: number, start = ''): string => start + 'x'.repeat(tokens * 4 - start.length)

/** A compaction of `messages` that asks no model unless a test hands one over. */
const job = (messages: StoredMessage[], over: Partial<CompactJob> = {}): CompactJob => ({
  messages,
  base: 1000,
  scale: 1,
  window: 10_000,
  limit: 6000,
  signal: new AbortController().signal,
  summarize: () => Promise.reject(new Error('no summary was to be asked for here')),
  now: () => 1234,
  ...over
})

/** A summary as a mark holds it, for the tests that only look at what is sent. */
const summed = (sent: string): CompactionMark => ({ role: 'compaction', at: 1, before: 9000, after: 3000, summary: { text: 'gist', sent, covers: 2, said: 1, files: 0 } })

test('what is sent starts at the summary in force, and has a line where a result was cleared', () => {
  const first = says('', [reads('c1', 'a.ts')])
  const last = says('done')
  // Nothing compacted: the messages themselves, but for the cleared result.
  assert.deepEqual(sendable([user('go'), first, { ...result('c1', 'a long file'), cleared: '[gone]' }, last]), [user('go'), first, result('c1', '[gone]'), last])

  // A summary goes into the message of the person that follows it: one message, so the turns still alternate.
  const mark = summed(`${SUMMARY_OPEN}\nwhat happened\n${SUMMARY_CLOSE}`)
  const sent = mark.summary!.sent
  assert.deepEqual(sendable([user('old'), says('old answer'), mark, user('and now?')]), [{ role: 'user', content: `${sent}\n\nand now?` }])
  // With a skill picked for that message, the skill's text stays where it was: before what was typed.
  assert.deepEqual(sendable([mark, { role: 'user', content: 'use it', skill: { name: 'tidy', prompt: 'Tidy up.' } }]), [{ role: 'user', content: `${sent}\n\nTidy up.\n\nuse it` }])
  // In the middle of a task the model's own step follows: the summary is a message of its own, and says to carry on.
  const step = says('', [reads('c2', 'b.ts')])
  assert.deepEqual(sendable([user('old'), mark, step, result('c2', 'text')]), [{ role: 'user', content: `${sent}\n\n${CARRY_ON}` }, step, result('c2', 'text')])
  // With nothing after it at all, the same.
  assert.deepEqual(sendable([user('old'), mark]), [{ role: 'user', content: `${sent}\n\n${CARRY_ON}` }])

  // A mark of cleared results is not a message; and of two summaries the later one is in force.
  const cleared: CompactionMark = { role: 'compaction', at: 2, before: 8000, after: 2000, cleared: 3 }
  const later = summed(`${SUMMARY_OPEN}\nlater\n${SUMMARY_CLOSE}`)
  assert.deepEqual(sendable([user('a'), mark, user('b'), says('c'), cleared, later, user('d'), cleared, says('e')]), [{ role: 'user', content: `${later.summary!.sent}\n\nd` }, says('e')])
})

test('a tool result is cut to fit before it is sent, and says how much is missing', () => {
  const long = 'a'.repeat(4000)
  const cut = fitTokens(long, 500)
  assert.ok(estimateTokens(cut) <= 500, `it fits: ${estimateTokens(cut)} tokens`)
  // Room is left for the note, and what is kept is the beginning.
  assert.ok(cut.startsWith('a'.repeat(1840) + '\n… [cut here to fit the model\'s context: 2160 more characters.'), cut.slice(1830, 1920))
  assert.equal(fitTokens(long, 1000), long, 'what fits is left alone')
  assert.equal(fitTokens('', 10), '')

  // Chinese is weighed by the character.
  const chinese = fitTokens('字'.repeat(1000), 300)
  assert.ok(chinese.startsWith('字'.repeat(260) + '\n… [cut here'))
  assert.ok(estimateTokens(chinese) <= 300)

  // Never in the middle of a character that takes two places in a string.
  const faces = fitTokens('😀'.repeat(2000), 300)
  assert.doesNotMatch(faces.split('\n')[0], /[\uD800-\uDBFF]$/)
})

/** Three files read one after another in one turn: 3000, 3000 and 1000 tokens of results. */
const threeReads = (origin?: Assistant['origin']): StoredMessage[] => [
  user('do it'),
  says('', [reads('c1', 'a.ts')], origin),
  result('c1', words(3000)),
  says('', [reads('c2', 'b.ts')], origin),
  result('c2', words(3000)),
  says('', [reads('c3', 'c.ts')], origin),
  result('c3', words(1000))
]

test('old tool results are cleared where that is enough, and no model is asked', async () => {
  const messages = threeReads()
  // The person's words weigh 2, each call 7: its name and its arguments.
  assert.deepEqual(messages.map(storedWeight), [2, 7, 3000, 7, 3000, 7, 1000])
  const done = await compact(job(messages))

  // A quarter of the 8023 tokens stays as it is: the last call and its result. The two results before it go.
  const saved = 2 * (3000 - estimateTokens(note(12_000)))
  // What is left is a guess, and says so, until a service has counted it.
  assert.deepEqual(done, { mark: { role: 'compaction', at: 1234, before: 8023, after: 8023 - saved, window: 10_000, rough: true, cleared: 2 } })
  assert.equal(messages.length, 8, 'the mark stands where it was done: at the end')
  assert.equal(messages[7], done.mark)
  assert.deepEqual(
    messages.map((m) => (m.role === 'tool' ? m.cleared : undefined)),
    [undefined, undefined, note(12_000), undefined, note(12_000), undefined, undefined, undefined]
  )
  // What was read is still there for the person to see.
  assert.equal((messages[2] as Result).content, words(3000))
  // And what is sent has the line in its place.
  assert.deepEqual(sendable(messages).map((m) => (m.role === 'tool' ? m.content.length : null)), [null, null, note(12_000).length, null, note(12_000).length, null, 4000])

  // Asked to go much further, it clears what was kept as the latest part before, and no result
  // twice. (A summary is called for as well, which this test has nobody to ask for.)
  const again = await compact(job(messages, { limit: 100 }))
  assert.equal(again.mark?.cleared, 1)
  assert.equal(again.problem, 'no summary was to be asked for here')
  assert.equal((messages[6] as Result).cleared, note(4000))
  // And then there is nothing left that is worth it.
  assert.deepEqual(await compact(job(messages, { limit: 100 })), {})
  assert.equal(messages.length, 9)
})

test('a skill that was loaded is not cleared: the model is following it', async () => {
  const messages: StoredMessage[] = [
    user('do it'),
    says('', [{ id: 's1', name: 'load_skill', arguments: '{"name":"tidy"}' }]),
    result('s1', words(3000)),
    says('', [reads('c2', 'b.ts')]),
    result('c2', words(3000)),
    says('', [reads('c3', 'c.ts')]),
    result('c3', words(1000))
  ]
  const done = await compact(job(messages))
  assert.equal(done.mark?.cleared, 1)
  assert.equal((messages[2] as Result).cleared, undefined)
  assert.equal((messages[4] as Result).cleared, note(12_000))
})

test("Claude's thinking from after a change is no longer sent back; what came before it, and what others wrote, is", async () => {
  const thought = (id: string): unknown[] => [
    { type: 'thinking', thinking: 'hm', signature: 'sig' },
    { type: 'redacted_thinking', data: 'zzz' },
    { type: 'text', text: 'so' },
    { type: 'tool_use', id, name: 'read_file', input: { path: 'a.ts' } }
  ]
  const claude = (id: string): Assistant['origin'] => ({ provider: 'anthropic', kind: 'anthropic', model: 'claude', replay: thought(id) })
  const messages = threeReads()
  for (const [at, id] of [[1, 'c1'], [3, 'c2'], [5, 'c3']] as const) (messages[at] as Assistant).origin = claude(id)
  await compact(job(messages))

  const replayed = (at: number): unknown => (messages[at] as Assistant).origin?.replay
  // The first result that was cleared is the third message. What was thought before it stood before the change.
  assert.deepEqual(replayed(1), thought('c1'))
  // After it, the text and the calls go back exactly as they came, without the thinking.
  assert.deepEqual(replayed(3), thought('c2').slice(2))
  assert.deepEqual(replayed(5), thought('c3').slice(2))

  // Encrypted reasoning of the Responses API is bound to nothing before it, and stays.
  const items = [{ type: 'reasoning', encrypted_content: 'abc' }, { type: 'function_call', call_id: 'c1' }]
  const other: StoredMessage[] = [says('', [], { provider: 'openai', kind: 'openai-responses', model: 'gpt', replay: items }), says('', [], { provider: 'deepseek', kind: 'openai-chat', model: 'ds', replay: { thinking: 'reasoning' } })]
  dropThinking(other, 0)
  assert.deepEqual((other[0] as Assistant).origin?.replay, items)
  assert.deepEqual((other[1] as Assistant).origin?.replay, { thinking: 'reasoning' })
})

/** Ten turns of talk with no tools: the person writes 100 tokens, the model answers with 700. */
const tenTurns = (): StoredMessage[] => Array.from({ length: 10 }, (_, i) => [user(words(100, `u${i + 1} `)), says(words(700, `a${i + 1} `))]).flat()

test('where clearing is not enough, a summary takes the place of all but the latest part', async () => {
  const messages = tenTurns()
  const asked: { system: string; record: string }[] = []
  let told = 0
  const done = await compact(
    job(messages, {
      language: 'Chinese',
      onSummarizing: () => told++,
      summarize: async (system, record) => {
        asked.push({ system, record })
        return `  The gist. ${SUMMARY_CLOSE} \n`
      }
    })
  )

  // A quarter of the 9000 tokens is kept: the last two turns, 1600 tokens. The eight before them are summed up.
  assert.equal(asked.length, 1)
  assert.equal(told, 1, 'said before the model is asked: from there on it takes a while')
  // The summary may take six hundredths of what the conversation weighed: 540 tokens.
  assert.equal(asked[0].system, summaryPrompt(540, 'Chinese'))
  assert.match(asked[0].system, /under about 400 words \(in Chinese, Japanese or Korean: about 500 characters\)/)
  // The headings are handed over in the language of the conversation, where the app knows it.
  assert.match(asked[0].system, /in this order, written exactly as they stand here\./)
  assert.match(asked[0].system, /\n1\. 目标: what the user wants.*\n2\. 决定和约束: .*\n3\. 已做的事: .*\n4\. 问题: .*\n5\. 状态: /)
  assert.match(asked[0].system, /- Write the summary in Chinese; names, code and commands stay as they are\./)
  assert.match(summaryPrompt(540, 'Japanese'), /\n5\. 現状: /)
  assert.match(summaryPrompt(540), /\n1\. Goal: .*\n[^]*Write the summary in the language the user writes in, the headings included;/)
  assert.match(summaryPrompt(540, 'Klingon'), /\n1\. Goal: [^]*Write the summary in Klingon, the headings included;/)
  assert.ok(asked[0].record.startsWith(`<record>\n[user]\n${words(100, 'u1 ')}\n\n[assistant]\n${words(700, 'a1 ')}\n\n[user]\nu2 `))
  assert.ok(asked[0].record.endsWith(`[assistant]\n${words(700, 'a8 ')}\n</record>\n\nWrite the summary of this record now.`))

  const mark = messages[16] as CompactionMark
  assert.equal(done.mark, mark, 'the mark stands where the summary ends and the kept part begins')
  assert.equal(messages.length, 21)
  assert.deepEqual(messages[17], user(words(100, 'u9 ')))
  // The tags that mark the summary are the app's to write, wherever the model put any.
  assert.equal(mark.summary?.text, 'The gist.')
  assert.equal(mark.summary?.covers, 16)
  // Of what the person wrote: the first, and as many of the latest as weigh 270 tokens with it.
  assert.equal(mark.summary?.said, 2)
  assert.equal(
    mark.summary?.sent,
    [
      SUMMARY_OPEN,
      'The earlier part of this conversation was compacted to save room in your context. This summary stands in its place; what comes after it is the latest part of the conversation, unchanged.',
      '',
      'The gist.',
      '',
      SAID_BEFORE,
      `1. ${words(100, 'u1 ')}`,
      '[… 6 more messages left out here …]',
      `8. ${words(100, 'u8 ')}`,
      SUMMARY_CLOSE
    ].join('\n')
  )
  const sent = mark.summary!.sent
  assert.deepEqual(sendable(messages), [{ role: 'user', content: `${sent}\n\n${words(100, 'u9 ')}` }, messages[18], messages[19], messages[20]])
  // Before, and what the next request weighs: instructions and tools, the summary, and the part that was kept.
  assert.equal(mark.before, 9000)
  assert.equal(mark.after, 1000 + estimateTokens(sent) + estimateTokens(`\n\n${words(100, 'u9 ')}`) + 700 + 100 + 700)
  assert.ok(mark.after < 3200, String(mark.after))
  assert.equal(mark.window, 10_000)
  assert.equal(mark.cleared, undefined)
})

test('a second summary continues the first, and counts everything above it', async () => {
  const messages = tenTurns()
  await compact(job(messages, { summarize: async () => 'First gist.' }))
  // Eight more turns, and the conversation is as long as before.
  for (let i = 11; i <= 18; i++) messages.push(user(words(100, `u${i} `)), says(words(700, `a${i} `)))
  const records: string[] = []
  const done = await compact(
    job(messages, {
      summarize: async (_system, record) => {
        records.push(record)
        return 'Second gist.'
      }
    })
  )
  // What the first summary said goes in front of what is new, and not the messages it stood for.
  assert.ok(records[0].startsWith(`<record>\n[summary of what came before this record]\nFirst gist.\n\n[user]\n${words(100, 'u9 ')}`), records[0].slice(0, 120))
  assert.doesNotMatch(records[0], /u1 xx/)
  const mark = done.mark!
  assert.equal(mark.summary?.text, 'Second gist.')
  // What the person wrote is quoted from the whole conversation, the first message still first.
  assert.match(mark.summary!.sent, /\n1\. u1 x+\n\[… \d+ more messages left out here …\]\n\d+\. u\d+ /)
  assert.equal(mark.summary?.covers, messages.indexOf(mark) - 1, 'every message above it but the first mark')
  assert.ok(sendable(messages)[0].content.startsWith(`${mark.summary!.sent}\n\nu`))
  assert.equal(sendable(messages).length, messages.length - messages.indexOf(mark) - 1)
})

test('a summary that could not be had leaves the results cleared, and a stop leaves everything as it was', async () => {
  // Clearing brings these 8023 tokens to 2075, which is not under 1500: a summary is called for.
  const failed = threeReads()
  const done = await compact(job(failed, { limit: 1500, summarize: () => Promise.reject(new Error('the service is down')) }))
  assert.equal(done.problem, 'the service is down')
  assert.equal(done.mark?.cleared, 2)
  assert.equal(done.mark?.summary, undefined)
  assert.equal(failed.length, 8)

  // The model answered with nothing.
  const empty = threeReads()
  assert.equal((await compact(job(empty, { limit: 1500, summarize: async () => '  \n' }))).problem, 'The model returned no summary.')

  // With nothing to clear either, nothing is changed at all.
  const talk = tenTurns()
  const before = structuredClone(talk)
  assert.deepEqual(await compact(job(talk, { summarize: () => Promise.reject(new Error('no')) })), { problem: 'no' })
  assert.deepEqual(talk, before)

  // The person stops while the summary is written.
  const stopping = new AbortController()
  const stopped = threeReads()
  const kept = structuredClone(stopped)
  const outcome = await compact(
    job(stopped, {
      limit: 1500,
      signal: stopping.signal,
      summarize: async () => {
        stopping.abort()
        return 'half a summary'
      }
    })
  )
  assert.deepEqual(outcome, {})
  assert.deepEqual(stopped, kept)
})

test('the summary ends before a message of the person or a step of the model, and never takes what is being asked', async () => {
  const gist = async (): Promise<string> => 'Gist.'
  // In the middle of a task: the files read so far weigh more than may be kept, so the kept part
  // begins at a step of the model's, and the summary says to carry on.
  const working = threeReads()
  const done = await compact(job(working, { limit: 1500, summarize: gist }))
  const at = working.indexOf(done.mark!)
  assert.equal(at, 5, 'before the last call, not between a call and its result')
  assert.equal(done.mark?.cleared, undefined, 'nothing is cleared where a summary is made')
  const sent = sendable(working)
  assert.deepEqual(sent.map((m) => m.role), ['user', 'assistant', 'tool'])
  assert.ok(sent[0].content.endsWith(`${SUMMARY_CLOSE}\n\n${CARRY_ON}`))
  // What was asked is in the summary's own words of the person, and so are the files.
  assert.match(done.mark!.summary!.sent, /\n1\. do it\n\nFiles read: a\.ts, b\.ts\n<\/conversation-summary>$/)
  assert.equal(done.mark?.summary?.files, 2)

  // A new message that alone weighs more than may be kept is still not summed up: it is what is asked.
  const asking: StoredMessage[] = [...tenTurns(), user(words(5000, 'the new question '))]
  const kept = await compact(job(asking, { window: 20_000, limit: 9000, summarize: gist }))
  assert.equal(asking.indexOf(kept.mark!), 20)
  assert.deepEqual(sendable(asking), [{ role: 'user', content: `${kept.mark!.summary!.sent}\n\n${words(5000, 'the new question ')}` }])

  // A kept part that would begin in the middle of an old turn begins at the next message of the person's instead.
  const turns: StoredMessage[] = [
    ...tenTurns().slice(0, 10),
    user(words(100, 'u7 ')),
    says(words(700, 'thinking it over ')),
    says(words(300, 'a7 ')),
    user(words(100, 'u8 ')),
    says(words(700, 'a8 '))
  ]
  // 6900 tokens with the instructions: 1725 may be kept, which reaches back to "a7" but not to the step before it.
  const tidy = await compact(job(turns, { limit: 100, summarize: gist }))
  assert.equal((turns[turns.indexOf(tidy.mark!) + 1] as ChatMessage).content, words(100, 'u8 '))
})

test('a long conversation is given to the model that sums it up in less detail, and at worst without its beginning', async () => {
  // Thirty steps, each a call with a long argument and a result of 9000 characters.
  const steps = (): StoredMessage[] => [
    user('go'),
    ...Array.from({ length: 30 }, (_, i) => [
      says(`step ${i + 1}`, [{ id: `c${i}`, name: 'write_file', arguments: JSON.stringify({ path: `f${i}.ts`, content: 'y'.repeat(3000) }) }]),
      result(`c${i}`, 'z'.repeat(9000))
    ]).flat()
  ]
  const record = async (over: Partial<CompactJob>): Promise<string> => {
    let seen = ''
    await compact(
      job(steps(), {
        limit: 100,
        summarize: async (_system, text) => {
          seen = text
          return 'Gist.'
        },
        ...over
      })
    )
    return seen
  }
  // Room enough: results are given by their first 2000 characters, arguments by their first 1000.
  const roomy = await record({ window: 200_000 })
  assert.match(roomy, /\[result of write_file\]\nz{2000} … \[7000 more characters\]/)
  assert.match(roomy, /\[assistant\]\nstep 1\n\[assistant calls write_file\] \{"path":"f0\.ts","content":"y{973} … \[2029 more characters\]/)
  // Less room: less of each.
  const tight = await record({ window: 12_000 })
  assert.match(tight, /\[result of write_file\]\nz{800} … \[8200 more characters\]/)
  assert.ok(tight.startsWith('<record>\n[user]\ngo\n\n[assistant]\nstep 1\n'))
  // Hardly any: the oldest steps are left out, and the record says so.
  const cramped = await record({ window: 3000 })
  assert.ok(cramped.startsWith('<record>\n[The beginning of this part of the conversation is left out here: it did not fit.]\n\n[assistant]\nstep '), cramped.slice(0, 140))
  assert.ok(estimateTokens(cramped) <= 3000 * 0.7)
})

test('nothing is done where it would not be worth it', async () => {
  // A short conversation: a summary would not be much shorter than what it stood for.
  const short: StoredMessage[] = [user('hello'), says(words(200)), user('thanks'), says(words(200))]
  assert.deepEqual(await compact(job(short, { limit: 0, summarize: async () => 'Gist.' })), {})
  assert.equal(short.length, 4)
  // Results that are small are left where they are.
  const small: StoredMessage[] = [user('go'), says('', [reads('c1', 'a.ts')]), result('c1', 'short'), says(words(900)), user('more'), says(words(900))]
  assert.deepEqual(await compact(job(small, { limit: 0, summarize: () => Promise.reject(new Error('down')) })), { problem: 'down' })
  assert.equal((small[2] as Result).cleared, undefined)
})

test('what a guess weighs is brought to what the service counts', async () => {
  // The service counts twice what the app guesses: the same conversation weighs twice as much, and more of it has to go.
  const messages = threeReads()
  const done = await compact(job(messages, { scale: 2, base: 2000, window: 20_000, limit: 12_000 }))
  const saved = 2 * 2 * (3000 - estimateTokens(note(12_000)))
  assert.deepEqual([done.mark?.before, done.mark?.after, done.mark?.cleared], [2000 + 2 * 7023, 2000 + 2 * 7023 - saved, 2])
})

test('a reply the service counts far more of than its text is seen for what it weighs', async () => {
  // Little text, and one reply that came with 10,000 tokens of thinking, which the service keeps
  // with it and counts again every time the reply is sent back.
  const heavy = says(words(300, 'the long answer '))
  const talk = (): StoredMessage[] => [user(words(50, 'u1 ')), says(words(100, 'a1 ')), user(words(50, 'u2 ')), heavy, user('and the key number?')]
  const gist = async (): Promise<string> => 'Gist.'
  // Weighed by its text there is nothing to compact, however full the context: all of it is the latest part.
  const byText = talk()
  assert.deepEqual(await compact(job(byText, { base: 12_000, limit: 4500, summarize: gist })), {})
  assert.equal(byText.length, 5)

  // Weighed by what the service counted, that reply is most of the conversation, and is summed up.
  const messages = talk()
  const done = await compact(job(messages, { base: 2000, limit: 4500, weigh: (m) => storedWeight(m) + (m === heavy ? 10_000 : 0), summarize: gist }))
  const mark = done.mark!
  assert.equal(mark.before, 2000 + 505 + 10_000)
  assert.equal(messages.indexOf(mark), 4, 'everything but what is being asked')
  assert.equal(mark.summary?.covers, 4)
  assert.deepEqual(sendable(messages), [{ role: 'user', content: `${mark.summary!.sent}\n\nand the key number?` }])
  assert.ok(mark.after < 2400, String(mark.after))

  // A heavy reply that is the latest thing said is kept only while it fits what may be kept; a
  // result that follows it is not what gets cleared in its place.
  const working: StoredMessage[] = [user('go'), says('', [reads('c1', 'a.ts')]), result('c1', words(900)), heavy, user('more')]
  const cleared = await compact(job(working, { base: 2000, limit: 4500, weigh: (m) => storedWeight(m) + (m === heavy ? 10_000 : 0), summarize: gist }))
  assert.equal(cleared.mark?.cleared, undefined)
  assert.equal(working.indexOf(cleared.mark!), 4)
})

test('a refusal for length is told from other refusals, and the size it names is read', () => {
  const cases: [string, number | undefined][] = [
    ["This model's maximum context length is 8192 tokens. However, your messages resulted in 9001 tokens. Please reduce the length of the messages.", 8192],
    ['prompt is too long: 215000 tokens > 200000 maximum', 200_000],
    ["This model's maximum prompt length is 131072 but the request contains 140000 tokens.", 131_072],
    ['the request exceeds the available context size, try increasing it', undefined],
    ['Trying to keep the first 5000 tokens when context the overflows. However, the model is loaded with context length of only 4,096 tokens', 4096],
    ['The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).', undefined],
    ['Requested tokens (9000) exceed context window of 8192', 8192]
  ]
  for (const [message, window] of cases) {
    assert.equal(saysTooLong(new Error(message)), true, message)
    assert.equal(windowSaid(new Error(message)), window, message)
  }
  assert.equal(saysTooLong(Object.assign(new Error('400 status code (no body)'), { code: 'context_length_exceeded' })), true)
  for (const other of ['Incorrect API key provided', 'context deadline exceeded', 'Rate limit reached for requests', 'does not support tools', '']) {
    assert.equal(saysTooLong(new Error(other)), false, other)
  }
  assert.equal(saysTooLong(undefined), false)
  assert.equal(windowSaid(new Error('maximum context length is 12 tokens')), undefined, 'not a size a context has')
})

test('from where on a conversation is compacted by itself follows what the person set', () => {
  assert.deepEqual(COMPACTION_DEFAULTS, { auto: true, share: 0.8, cap: null })
  assert.equal(compactFrom(COMPACTION_DEFAULTS, 200_000), 160_000)
  assert.equal(compactFrom({ auto: true, share: 0.6, cap: null }, 1_000_000), 600_000)
  // A cap counts where it is lower, whatever the model holds, and also where that is not known.
  assert.equal(compactFrom({ auto: true, share: 0.8, cap: 200_000 }, 1_000_000), 200_000)
  assert.equal(compactFrom({ auto: true, share: 0.8, cap: 200_000 }, 32_000), 25_600)
  assert.equal(compactFrom({ auto: true, share: 0.8, cap: 200_000 }, undefined), 200_000)
  // Never: switched off, or nothing to go by.
  assert.equal(compactFrom({ auto: false, share: 0.8, cap: 200_000 }, 1_000_000), undefined)
  assert.equal(compactFrom(COMPACTION_DEFAULTS, undefined), undefined)
  // A share is kept to what can be set, in whole percent.
  assert.deepEqual([0.8, 0.2, 0.99, 0.666, Number.NaN, 'x'].map(readShare), [0.8, 0.5, 0.95, 0.67, 0.8, 0.8])
})

test('the numbers of a conversation take a compaction in', () => {
  const measured = { ms: 5000, firstMs: 1000, pieces: 40, parts: { system: 300, tools: 600, messages: 4100 }, provider: 'p1', model: 'm1' }
  let stats = addStep(emptyStats(), { ...measured, usage: { input: 1000, cacheRead: 5000, output: 100 } })
  // The service counted 6000 tokens of what was guessed at 5000, nearly all of it conversation.
  const fit: Fit = { base: 1.2, said: 1.2, last: { sent: 6000, tokens: 6100, base: 900, said: 4100, reply: 0 } }
  assert.deepEqual(stats.context?.fit, fit)
  // A request the service says nothing of leaves what was learned from the one before, for the same model.
  stats = addStep(stats, { ...measured, usage: undefined })
  assert.deepEqual(stats.context?.fit, fit)
  assert.equal(addStep(stats, { ...measured, model: 'm2', usage: undefined }).context?.fit, undefined)

  const parts = fitParts({ system: 300, tools: 600, summary: 250, messages: 400, skills: 0 }, fit)
  assert.deepEqual(parts, { system: 360, tools: 720, summary: 300, messages: 480 })
  assert.equal(partsTotal(parts), 1860)
  const after = addCompaction(stats, { parts, provider: 'p1', model: 'm1', fit, cost: { ms: 9000, pieces: 0, usage: { input: 4000, output: 300 }, parts: {}, provider: 'p1', model: 'm1' } })
  assert.equal(after.compactions, 1)
  assert.equal(addCompaction(after, { parts, provider: 'p1', model: 'm1' }).compactions, 2)
  // The summary cost tokens and time, and was no step of the conversation.
  assert.deepEqual([after.steps, after.modelMs, after.usage], [2, 19_000, { input: 5000, cacheRead: 5000, output: 400 }])
  // The context is what the next request is expected to weigh: a guess, shown as one, with the summary a part of its own.
  // What was learned of the guesses stays; the last request that was counted does not: the next one is not that one grown.
  assert.deepEqual(after.context, { parts, provider: 'p1', model: 'm1', fit: { base: 1.2, said: 1.2 } })
  const view = contextView(after.context!, 10_000)
  assert.deepEqual([view.tokens, view.exact, view.share], [1860, false, 0.186])
  assert.deepEqual(view.parts.map((p) => [p.part, p.tokens]), [['messages', 480], ['summary', 300], ['tools', 720], ['system', 360]])
})

test('the next request is expected to weigh what the last one was counted at, with its reply and with what was added since', () => {
  // The counts of a real service (xAI, in round numbers): the instructions and tools at 2.3 times
  // their text, what the tools return at about the guess, and a reply at what the service said it
  // cost with its thinking, which is far more than its text.
  const base = { system: 300, tools: 700 }
  const first = { ...base, messages: 40 }
  assert.deepEqual(halves(first), { base: 1000, said: 40 })
  // Nothing counted yet: a guess is all there is.
  assert.deepEqual(expected(first, undefined), { tokens: 1040, base: 1000, scale: 1 })

  // The first request: 2340 tokens for what was guessed at 1040, and 74 for a reply that is one tool call.
  let fit = fitTo(undefined, { sent: 2340, output: 74 }, first, 10, true)
  // The conversation has hardly begun and is taken at its guess; what is over is the instructions and
  // tools. No reply was in it yet, so this is what they weigh, and it is kept for as long as the tools stay.
  assert.deepEqual(fit, { base: 2.3, pinned: 1000, said: 1, last: { sent: 2340, tokens: 2414, base: 1000, said: 40, reply: 10 } })
  // The next request carries that call and a result of 1500 guessed tokens: not twice as heavy as it is.
  const second = { ...base, messages: 40, toolResults: 1510 }
  assert.deepEqual(expected(second, fit), { tokens: 3914, base: 2364, scale: 1 })

  // It was counted at 3764: the result weighs nine tenths of its guess.
  fit = fitTo(fit, { sent: 3764, output: 74 }, second, 10)
  assert.deepEqual(fit, { base: 2.3, pinned: 1000, said: 0.9, learned: true, last: { sent: 3764, tokens: 3838, base: 1000, said: 1550, reply: 10 } })
  const third = { ...base, messages: 40, toolResults: 3020 }
  assert.deepEqual(expected(third, fit), { tokens: 5188, base: 2434, scale: 0.9 })
  // The next result weighs its guess: evened out with what was learned before, since one may be all code and the next all Chinese.
  fit = fitTo(fit, { sent: 5338, output: 277 }, third, 60)
  assert.deepEqual(fit, { base: 2.3, pinned: 1000, said: 0.95, learned: true, last: { sent: 5338, tokens: 5615, base: 1000, said: 3060, reply: 60 } })

  // The reply to that was 60 guessed tokens of text and cost 277 with its thinking: the 277 are what the next request carries.
  const fourth = { ...base, messages: 140, toolResults: 3020 }
  assert.deepEqual(expected(fourth, fit), { tokens: 5653, base: 2651, scale: 0.95 })
  // A long answer with long thinking, and little added since: nothing is learned from that about what text weighs.
  fit = fitTo(fit, { sent: 5650, output: 1364 }, fourth, 280)
  assert.deepEqual(fit, { base: 2.3, pinned: 1000, said: 0.95, learned: true, last: { sent: 5650, tokens: 7014, base: 1000, said: 3160, reply: 280 } })
  assert.equal(expected({ ...base, messages: 460, toolResults: 3020 }, fit).tokens, 7014 + Math.round(0.95 * 40))

  // After a compaction the next request is not the last one grown: each half is brought to what the counts made of it.
  const { last: _gone, ...kept } = fit!
  assert.deepEqual(expected({ ...base, messages: 500, toolResults: 80 }, kept), { tokens: 2300 + 551, base: 2300, scale: 0.95 })
  // So is a request with other tools than the last one had.
  const others = { ...base, tools: 1400, messages: 460, toolResults: 3020 }
  assert.deepEqual(expected(others, fit), { tokens: Math.round(2.3 * 1700) + 3306, base: Math.round(2.3 * 1700), scale: 0.95 })
  // What those other tools weigh was not seen by itself: it is what their count holds beyond the text, replies' thinking and all.
  assert.deepEqual(fitTo(fit, { sent: 9000, output: 10 }, others, 5), { base: 3.349, said: 0.95, learned: true, last: { sent: 9000, tokens: 9010, base: 1700, said: 3480, reply: 5 } })
  // Nor where the first message is longer than the instructions, as with a file pasted into it: its count says more of the file.
  assert.equal(fitTo(undefined, { sent: 9000 }, { ...base, messages: 5000 }, 0, true)?.pinned, undefined)
  // Nor is it where a conversation is first counted with replies already in it.
  assert.deepEqual(fitTo(undefined, { sent: 2340, output: 74 }, first, 10), { base: 2.3, said: 1, last: { sent: 2340, tokens: 2414, base: 1000, said: 40, reply: 10 } })

  // A request the service did not count changes nothing.
  assert.equal(fitTo(fit, { sent: undefined }, fourth, 5), fit)
  assert.equal(fitTo(undefined, { sent: undefined }, first), undefined)
  // A count that is far off is not believed all the way: not for the instructions, not for what was added.
  assert.deepEqual(fitTo(undefined, { sent: 90_000 }, first), { base: 8, said: 1, last: { sent: 90_000, tokens: 90_000, base: 1000, said: 40, reply: 0 } })
  const wild = fitTo(fitTo(undefined, { sent: 2340, output: 74 }, first, 10), { sent: 20_000 }, second, 10)
  assert.equal(wild?.said, 2.5)
  // A conversation that is already long when it is first counted: the count speaks of little else, and both halves are taken alike.
  assert.deepEqual(fitTo(undefined, { sent: 30_000, output: 100 }, { ...base, messages: 19_000 }), { base: 1.5, said: 1.5, last: { sent: 30_000, tokens: 30_100, base: 1000, said: 19_000, reply: 0 } })

  // Each part is shown at what it is expected to be counted as.
  assert.deepEqual(fitParts({ system: 300, tools: 700, messages: 100, summary: 200 }, { base: 2, said: 1.5 }), { messages: 150, summary: 300, tools: 1400, system: 600 })
  assert.deepEqual(fitParts({ system: 300, messages: 100 }, undefined), { messages: 100, system: 300 })
})

test('a context that is mostly thinking is shown as that, and not as heavy tools', () => {
  // As a real service counted one: 13,586 tokens after a reply that came with 10,900 of thinking.
  const parts = { system: 324, tools: 685, messages: 400 }
  const counted = { tokens: 13_586, parts, provider: 'xai', model: 'grok' }
  // Shared out in proportion to the guesses, the tools would seem to hold half of it.
  const blind = contextView(counted, 500_000)
  assert.ok(blind.parts.find((p) => p.part === 'tools')!.tokens > 6000)
  // Where it is known what the instructions and tools weigh, they are shown at that, and what the
  // count holds beyond them and the text is with the messages: the thinking kept with the replies.
  const view = contextView({ ...counted, fit: { base: 2, pinned: 1009, said: 1 } }, 500_000)
  assert.deepEqual(view.parts.map((p) => [p.part, p.tokens]), [['messages', 13_586 - 1370 - 648], ['tools', 1370], ['system', 648]])
  assert.deepEqual([view.tokens, view.exact], [13_586, true])
  // Not where the tools are others than those that were weighed, nor where the count is less than what is known adds up to.
  assert.deepEqual(contextView({ ...counted, fit: { base: 2, pinned: 3000, said: 1 } }, 500_000), blind)
  const under = contextView({ ...counted, tokens: 1209, fit: { base: 2, pinned: 1009, said: 1 } })
  assert.deepEqual(under.parts.map((p) => [p.part, p.tokens]), [['messages', 200], ['tools', 685], ['system', 324]])

  // What is over holds two things: the reply to the last request, which is no part of that request
  // yet, and the thinking. Where the service has counted thinking, and the count is of the request
  // whose reply is known by its text (300 guessed tokens here), they are shown apart: the reply
  // with the messages, the rest as thinking, right after them.
  const last = { sent: 2718, tokens: 13_586, base: 1009, said: 400, reply: 300 }
  const apart = contextView({ ...counted, fit: { base: 2, pinned: 1009, said: 1, last } }, 500_000, true)
  assert.deepEqual(apart.parts.map((p) => [p.part, p.tokens]), [['messages', 400 + 300], ['thinking', 13_586 - 1370 - 648 - 700], ['tools', 1370], ['system', 648]])
  assert.equal(apart.parts.reduce((sum, p) => sum + p.tokens, 0), 13_586)
  // The reply is weighed like the other text of the conversation.
  const heavier = contextView({ ...counted, fit: { base: 2, pinned: 1009, said: 1.5, last } }, 500_000, true)
  assert.deepEqual(heavier.parts.slice(0, 2).map((p) => [p.part, p.tokens]), [['messages', 600 + 450], ['thinking', 13_586 - 1370 - 648 - 1050]])
  // Not where the service has counted no thinking: what is over may then be anything, and stays with the messages.
  assert.deepEqual(contextView({ ...counted, fit: { base: 2, pinned: 1009, said: 1, last } }, 500_000), view)
  // Nor where the count is of another request than the one whose reply is known.
  assert.deepEqual(contextView({ ...counted, fit: { base: 2, pinned: 1009, said: 1, last: { ...last, tokens: 9000 } } }, 500_000, true), view)
  // A reply that weighs all that is over leaves no thinking to show.
  const plain = contextView({ ...counted, tokens: 2718, fit: { base: 2, pinned: 1009, said: 1, last: { ...last, tokens: 2718 } } }, 500_000, true)
  assert.deepEqual(plain.parts.map((p) => [p.part, p.tokens]), [['messages', 700], ['tools', 1370], ['system', 648]])
})

test('the summary is weighed apart from what the person wrote after it', () => {
  const sent = `${SUMMARY_OPEN}\n${'s'.repeat(400)}\n${SUMMARY_CLOSE}`
  const parts = weigh({ system: 'sys!', messages: [{ role: 'user', content: `${sent}\n\n${'q'.repeat(398)}` }, { role: 'assistant', content: 'a'.repeat(40) }], tools: [] })
  assert.deepEqual(parts, { messages: 100 + 10, summary: estimateTokens(sent), system: 1 })
  // A message that only looks like one, with no end to the summary, is a message.
  assert.deepEqual(weigh({ system: '', messages: [{ role: 'user', content: `${SUMMARY_OPEN} and so on` }], tools: [] }), { messages: 8 })
})

test('the page shows a compacted conversation whole: a line where it was done, and a word on the results that were cleared', () => {
  const cleared: CompactionMark = { role: 'compaction', at: 1, before: 8000, after: 2000, cleared: 1 }
  const mark = summed('the summary as it is sent')
  const messages: StoredMessage[] = [user('one'), says('', [reads('c1', 'a.ts')]), { ...result('c1', 'what the file held'), cleared: '[gone]' }, cleared, says('answer'), mark, user('two'), says('reply')]
  const items = itemsFromMessages(messages)
  assert.deepEqual(items, [
    { kind: 'user', text: 'one', skill: undefined },
    // The result is shown as it was, and said to be cleared.
    { kind: 'tool', call: reads('c1', 'a.ts'), output: 'what the file held', cleared: true },
    { kind: 'mark', mark: cleared },
    { kind: 'assistant', reasoning: '', text: 'answer', open: false },
    { kind: 'mark', mark },
    { kind: 'user', text: 'two', skill: undefined },
    { kind: 'assistant', reasoning: '', text: 'reply', open: false }
  ])
  // What stands above the last summary is no longer sent; a mark of cleared results draws no such line.
  assert.equal(lastSummaryAt(items), 4)
  assert.equal(lastSummaryAt(items.slice(0, 4)), -1)

  // Told of a compaction while a turn runs, the page shows the conversation as it is kept now.
  const live: Item[] = [{ kind: 'user', text: 'one' }, { kind: 'notice', text: 'something to know' }, { kind: 'assistant', reasoning: '', text: 'a reply that was given up', open: true }]
  assert.deepEqual(itemsReducer(live, { type: 'event', event: { type: 'compacted', messages } }), items)
  assert.equal(itemsReducer(items, { type: 'event', event: { type: 'compacting', on: true } }), items, 'that a summary is being written changes nothing in the list')
  // What a compaction left is a guess on its line until the service has counted it.
  const guessed: Item[] = [{ kind: 'mark', mark: { ...cleared, rough: true } }, { kind: 'mark', mark: { ...mark, at: 7, rough: true } }]
  assert.deepEqual(itemsReducer(guessed, { type: 'event', event: { type: 'compaction_counted', at: 7, after: 2600 } }), [guessed[0], { kind: 'mark', mark: { ...mark, at: 7, after: 2600 } }])
  assert.deepEqual(itemsReducer([], { type: 'event', event: { type: 'notice', code: 'compaction-failed', message: 'in English', detail: '400 down' } }), [
    { kind: 'notice', text: '上下文快满了，但没能让模型把较早的对话写成摘要，对话按现在的样子继续。（服务返回：400 down）' }
  ])
})

test('of what a reply cost, the next request carries all, but for thinking that stays behind', () => {
  type Reply = Extract<ChatMessage, { role: 'assistant' }>
  const origin = { provider: 'p1', kind: 'openai-chat' as const, model: 'm1' }
  /** An answer guessed at 100 tokens with thinking guessed at 900, and how the thinking came. */
  const reply = (replay?: { thinking: 'inline' | 'reasoning' }): Reply => ({ role: 'assistant', content: 'y'.repeat(400), reasoning_content: 'x'.repeat(3600), origin: { ...origin, ...(replay ? { replay } : {}) } })

  // Thinking that came inside the answer is not sent back: the count is shared by what answer and thinking are guessed to weigh.
  assert.equal(carriedTokens(reply({ thinking: 'inline' }), 1150), 115)
  // Thinking that came in a field of its own goes back in it, or is kept by the service: the whole count.
  assert.equal(carriedTokens(reply({ thinking: 'reasoning' }), 1150), 1150)
  assert.equal(carriedTokens(reply(), 1150), 1150)
  // No thinking, nothing to share; and nothing to share by either.
  assert.equal(carriedTokens({ role: 'assistant', content: 'y'.repeat(400), origin }, 1150), 1150)
  assert.equal(carriedTokens({ role: 'assistant', content: '', reasoning_content: '', origin: { ...origin, replay: { thinking: 'inline' } } }, 1150), 1150)
  // A reply that is all thinking leaves nothing for the next request to carry.
  assert.equal(carriedTokens({ role: 'assistant', content: '', reasoning_content: 'x'.repeat(3600), origin: { ...origin, replay: { thinking: 'inline' } } }, 1150), 0)

  // The line is drawn in the same place as where the conversation is written out for the service:
  // what is taken not to come back is what is not sent, under either name.
  const connection: Connection = { provider: 'p1', kind: 'openai-chat', apiKey: 'k', baseURL: 'http://127.0.0.1:1/v1', model: 'm1', reasoningEffort: 'default' }
  const sent = (message: Reply): Record<string, unknown> => chatMessages({ messages: [{ role: 'user', content: 'q' }, message], connection, system: 's' })[2] as unknown as Record<string, unknown>
  for (const [replay, field] of [[{ thinking: 'inline' }, undefined], [{ thinking: 'reasoning' }, 'reasoning'], [undefined, 'reasoning_content']] as const) {
    const message = reply(replay)
    const wire = sent(message)
    assert.equal(thinkingReturns(message), field !== undefined)
    assert.deepEqual([wire.reasoning, wire.reasoning_content], [field === 'reasoning' ? message.reasoning_content : undefined, field === 'reasoning_content' ? message.reasoning_content : undefined])
  }
})

test('the record a summary is made from names the web searches a service did by itself', async () => {
  const messages = tenTurns()
  // The second reply was written after a search and a page read of the service's own, the fourth after a search that failed.
  ;(messages[3] as Assistant).web = [
    {
      id: 's1',
      kind: 'search',
      queries: ['electron latest', 'electron 45'],
      status: 'done',
      sources: [{ url: 'https://example.com/a', title: 'Releases' }, { url: 'https://example.com/b' }]
    },
    { id: 'o1', kind: 'open', url: 'https://example.com/a', status: 'done' }
  ]
  ;(messages[7] as Assistant).web = [{ id: 's2', kind: 'search', queries: ['q'], status: 'failed', error: 'unavailable' }]
  // A reply that is nothing but a search is still in the record.
  messages[5] = { role: 'assistant', content: '', web: [{ id: 'o2', kind: 'open', status: 'done', sources: [{ url: 'https://example.com/c', title: 'Changelog' }] }] }
  let record = ''
  await compact(
    job(messages, {
      summarize: async (_system, given) => {
        record = given
        return 'The gist.'
      }
    })
  )
  // The searches stand before what was written with them: what was looked for, and what was found.
  assert.ok(
    record.includes(
      '[assistant searched the web for "electron latest", "electron 45"] Pages found: Releases <https://example.com/a>; <https://example.com/b>\n[assistant read the web page https://example.com/a]\n[assistant]\na2 '
    )
  )
  assert.ok(record.includes('[assistant searched the web for "q", which failed]\n[assistant]\na4 '))
  assert.ok(record.includes('\n\n[assistant read the web page Changelog <https://example.com/c>]\n\n[user]\nu4 '))
  // A reply without a search is written as it always was.
  assert.ok(record.startsWith(`<record>\n[user]\n${words(100, 'u1 ')}\n\n[assistant]\n${words(700, 'a1 ')}\n\n[user]\nu2 `))
})
