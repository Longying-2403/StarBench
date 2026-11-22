// Run with: node --test test/stats.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { knownContextWindow } from '../src/shared/context-windows.ts'
import {
  addStep,
  addToolTime,
  addTurn,
  cacheHitRate,
  contextView,
  emptyStats,
  estimateTokens,
  firstPieceAverage,
  formatCount,
  formatDuration,
  formatShare,
  formatShareFine,
  formatTokens,
  normalizeUsage,
  outputSpeed,
  readWindow,
  totalTokens
} from '../src/shared/stats.ts'
import type { StepMeasure } from '../src/shared/stats.ts'
import { weigh } from '../src/main/meter.ts'

test('what a service says a request cost is put into one shape, whichever way it counts', () => {
  // Chat completions: the whole input, and in a detail how much of it came from the cache.
  assert.deepEqual(
    normalizeUsage('openai-chat', { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 800 }, completion_tokens_details: { reasoning_tokens: 30 } }),
    { input: 200, cacheRead: 800, output: 50, reasoning: 30 }
  )
  // DeepSeek names the hits and the misses outright.
  assert.deepEqual(normalizeUsage('openai-chat', { prompt_tokens: 1100, completion_tokens: 6, prompt_cache_hit_tokens: 1000, prompt_cache_miss_tokens: 100 }), { input: 100, cacheRead: 1000, output: 6 })
  // A server that says nothing of a cache: the input is the input, and of the cache nothing is known.
  assert.deepEqual(normalizeUsage('openai-chat', { prompt_tokens: 420, completion_tokens: 12 }), { input: 420, output: 12 })
  // The Responses API, with its own names for the same.
  assert.deepEqual(
    normalizeUsage('openai-responses', { input_tokens: 1200, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 80, output_tokens_details: { reasoning_tokens: 30 }, total_tokens: 1280 }),
    { input: 200, cacheRead: 1000, output: 80, reasoning: 30 }
  )
  // The Messages API gives the three parts of the input side by side: `input_tokens` is only what was not cached.
  assert.deepEqual(normalizeUsage('anthropic', { input_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 40, output_tokens: 9 }), { input: 5, cacheRead: 900, cacheWrite: 40, output: 9 })
  assert.deepEqual(normalizeUsage('anthropic', { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 9 }), { input: 5, cacheRead: 0, cacheWrite: 0, output: 9 }, 'a cache that was asked and had nothing is nought, not unknown')
  // It tells the thinking in a detail of the output: what the model thought, not the summary that is shown.
  assert.deepEqual(
    normalizeUsage('anthropic', { input_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 40, output_tokens: 90, output_tokens_details: { thinking_tokens: 60 } }),
    { input: 5, cacheRead: 900, cacheWrite: 40, output: 90, reasoning: 60 }
  )
  // OpenAI's newer models tell what they wrote to the cache as well, which is charged more: a third part of the
  // input, beside what was read from the cache and what was neither (gpt-6.2-sol, as it answered on 2026-11-23).
  assert.deepEqual(
    normalizeUsage('openai-responses', {
      input_tokens: 4259,
      input_tokens_details: { cached_tokens: 2294, cache_write_tokens: 1670, cache_write_tokens_details: { ttl_30m_tokens: 1670, ttl_12h_tokens: 0 } },
      output_tokens: 21,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 4280
    }),
    { input: 295, cacheRead: 2294, cacheWrite: 1670, output: 21, reasoning: 0 }
  )
  // Nothing written is nought, as with what was read: with a ChatGPT sign-in the service says so of every request.
  assert.deepEqual(normalizeUsage('openai-responses', { input_tokens: 848, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 22 }), { input: 848, cacheRead: 0, cacheWrite: 0, output: 22 })
  assert.deepEqual(normalizeUsage('openai-chat', { prompt_tokens: 3000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 2000, cache_write_tokens: 600 } }), { input: 400, cacheRead: 2000, cacheWrite: 600, output: 10 })
  // One service (xAI) counts the thinking apart from the reply: its total gives that away, and the reply is counted with it.
  assert.deepEqual(
    normalizeUsage('openai-chat', { prompt_tokens: 5705, completion_tokens: 282, total_tokens: 7069, prompt_tokens_details: { cached_tokens: 5376 }, completion_tokens_details: { reasoning_tokens: 1082 } }),
    { input: 329, cacheRead: 5376, output: 1364, reasoning: 1082 }
  )
  // Read by the names of the kind it is, and by no others.
  assert.deepEqual(normalizeUsage('openai-chat', { input_tokens: 5, output_tokens: 9 }), undefined)
  // Nothing usable.
  for (const odd of [undefined, null, 'usage', 7, {}, { prompt_tokens: 'many', completion_tokens: -3 }, { prompt_tokens: Number.NaN }]) {
    assert.equal(normalizeUsage('openai-chat', odd), undefined, JSON.stringify(odd))
  }
})

/** One request as it was measured, with what a test wants different. */
const step = (over: Partial<StepMeasure> = {}): StepMeasure => ({
  ms: 5000,
  firstMs: 1000,
  pieces: 40,
  usage: { input: 200, cacheRead: 800, output: 100 },
  parts: { system: 300, tools: 600, messages: 100 },
  provider: 'p1',
  model: 'm1',
  ...over
})

test('the numbers of a conversation add up request by request', () => {
  let stats = addTurn(emptyStats())
  stats = addStep(stats, step())
  stats = addToolTime(stats, 1500)
  stats = addStep(stats, step({ ms: 3000, firstMs: 500, usage: { input: 150, cacheRead: 1000, output: 50, reasoning: 20 }, parts: { system: 300, tools: 600, messages: 400 } }))
  stats = addToolTime(addTurn(stats), 250)

  assert.deepEqual([stats.turns, stats.steps, stats.modelMs, stats.toolMs], [2, 2, 8000, 1750])
  assert.deepEqual(stats.usage, { input: 350, cacheRead: 1800, output: 150, reasoning: 20 })
  assert.equal(totalTokens(stats.usage), 2300)
  assert.equal(cacheHitRate(stats.usage), 1800 / 2150)
  assert.equal(firstPieceAverage(stats), 750)
  // 150 tokens in the 6.5 seconds after the first pieces came.
  assert.deepEqual(outputSpeed(stats), { perSecond: 150_000 / 6500, rough: false })
  // The context is as the last request left it: what was sent, and what came back. With it is
  // kept how the guesses compare with the counts: 300 guessed tokens were added to the
  // conversation and the count grew by 50 beyond the last reply, which is believed down to a half
  // and no further; what the count then holds beyond the conversation is the instructions and tools.
  assert.deepEqual(stats.context, {
    tokens: 1200,
    parts: { system: 300, tools: 600, messages: 400 },
    provider: 'p1',
    model: 'm1',
    fit: { base: 1.056, said: 0.5, learned: true, last: { sent: 1150, tokens: 1200, base: 900, said: 400, reply: 0 } }
  })
  assert.equal(stats.partial, undefined)
  assert.equal(emptyStats(true).partial, true, 'a conversation that was under way before says so')

  // Nothing is changed in place: what the page holds is what it was handed.
  const before = emptyStats()
  addStep(before, step())
  assert.deepEqual(before, emptyStats())
})

test('thinking that does not come back with a reply is counted in what the reply cost, and not in what the next request holds', () => {
  // 900 tokens were written, of which the next request carries 100: the rest was thinking that stays behind.
  const stats = addStep(emptyStats(), step({ usage: { input: 1000, output: 900 }, carried: 100, reply: 80 }))
  assert.equal(stats.usage.output, 900, 'what it cost')
  assert.deepEqual(outputSpeed(stats), { perSecond: 900_000 / 4000, rough: false }, 'and how fast it came: all 900 in the four seconds after the first piece')
  assert.deepEqual([stats.context?.tokens, stats.context?.fit?.last?.tokens], [1100, 1100], 'the context after it, and what the next request is expected to grow from')
  // With no word on it, all of a reply is taken to come back.
  const whole = addStep(emptyStats(), step({ usage: { input: 1000, output: 900 }, reply: 80 }))
  assert.deepEqual([whole.context?.tokens, whole.context?.fit?.last?.tokens], [1900, 1900])
})

test('what a service did not tell stays unknown, and what had to be guessed says so', () => {
  // A server that streams and tells no usage: no tokens, and a speed guessed from the pieces.
  let quiet = addStep(emptyStats(), step({ usage: undefined }))
  assert.deepEqual(quiet.usage, {})
  assert.equal(totalTokens(quiet.usage), undefined)
  assert.equal(cacheHitRate(quiet.usage), undefined)
  assert.deepEqual(outputSpeed(quiet), { perSecond: 10, rough: true }, 'forty pieces in four seconds')
  assert.deepEqual(quiet.context, { parts: { system: 300, tools: 600, messages: 100 }, provider: 'p1', model: 'm1' }, 'the size of the context is then a guess, too')
  // A later request that does tell is counted, and the speed stays marked as partly guessed.
  quiet = addStep(quiet, step())
  assert.deepEqual(quiet.usage, { input: 200, cacheRead: 800, output: 100 })
  assert.equal(outputSpeed(quiet)?.rough, true)

  // No cache said of: the hit rate is unknown, not nought.
  const local = addStep(emptyStats(), step({ usage: { input: 420, output: 12 } }))
  assert.equal(cacheHitRate(local.usage), undefined)
  assert.equal(totalTokens(local.usage), 432)
  assert.equal(local.context?.tokens, 432)
  assert.equal(cacheHitRate({ input: 420, cacheRead: 0, output: 12 }), 0, 'asked and missed is nought')
  assert.equal(cacheHitRate({ cacheRead: 0 }), undefined)

  // A reply that came in one piece has no first piece; its speed counts the whole wait, and says it is rough.
  const whole = addStep(emptyStats(), step({ ms: 4000, firstMs: undefined, pieces: 1, usage: { input: 300, output: 80 } }))
  assert.equal(firstPieceAverage(whole), undefined)
  assert.deepEqual(outputSpeed(whole), { perSecond: 20, rough: true })
  // In one piece and without usage, nothing can be said of the speed at all.
  assert.equal(outputSpeed(addStep(emptyStats(), step({ firstMs: undefined, pieces: 1, usage: undefined }))), undefined)
  assert.equal(outputSpeed(emptyStats()), undefined)
})

test('the context is shown by its size, its share of the room, and the weight of each of its parts', () => {
  // The guesses come to 107,800; the service said 133,000.
  const guesses = { skills: 100, custom: 300, system: 1000, mcpTools: 1400, tools: 6000, toolResults: 39_000, messages: 60_000 }
  const context = { tokens: 133_000, parts: guesses, provider: 'p1', model: 'm1' }
  const view = contextView(context, 1_000_000)
  assert.deepEqual([view.tokens, view.exact, view.share, view.free], [133_000, true, 0.133, 867_000])
  // In the order they are shown, whatever order they were kept in; a part that is not there is not listed.
  assert.deepEqual(view.parts.map((p) => p.part), ['messages', 'toolResults', 'tools', 'mcpTools', 'system', 'custom', 'skills'])
  // Brought to the true size, to the token: what rounding leaves over goes to the parts that lost most by it.
  assert.deepEqual(view.parts.map((p) => p.tokens), [74_026, 48_117, 7403, 1727, 1234, 370, 123])
  assert.equal(view.parts.reduce((sum, p) => sum + p.tokens, 0), 133_000)
  // Each part's share is of the model's room, so that with the room left they come to the whole.
  assert.deepEqual(view.parts.slice(0, 2).map((p) => p.share), [0.074026, 0.048117])
  assert.ok(Math.abs(view.parts.reduce((sum, p) => sum + p.share, 0) + view.free! / 1_000_000 - 1) < 1e-9)

  // Without a size from the service the sum of the guesses stands for it, and is said to be one.
  const guessed = contextView({ ...context, tokens: undefined }, 1_000_000)
  assert.deepEqual([guessed.tokens, guessed.exact, guessed.share, guessed.free], [107_800, false, 0.1078, 892_200])
  assert.deepEqual(guessed.parts.map((p) => p.tokens), [60_000, 39_000, 6000, 1400, 1000, 300, 100])

  // Without knowing the room there is no share of it and no room left; the parts are then shares of what is used.
  const roomless = contextView(context)
  assert.deepEqual([roomless.share, roomless.free], [undefined, undefined])
  assert.equal(roomless.parts[0].share, 74_026 / 133_000)
  assert.equal(contextView(context, 0).share, undefined)
  // More in it than the room holds is full, not more than full.
  const over = contextView(context, 100_000)
  assert.deepEqual([over.share, over.free, over.parts[0].share], [1, 0, 0.74026])

  // Numbers kept before the parts were told apart this finely still show, in the same order.
  assert.deepEqual(
    contextView({ tokens: 1000, parts: { system: 100, tools: 300, messages: 600 }, provider: 'p', model: 'm' }, 10_000).parts,
    [
      { part: 'messages', tokens: 600, share: 0.06 },
      { part: 'tools', tokens: 300, share: 0.03 },
      { part: 'system', tokens: 100, share: 0.01 }
    ]
  )
  // Nothing guessed: nothing to list, and the size is still the size.
  assert.deepEqual(contextView({ tokens: 500, parts: {}, provider: 'p', model: 'm' }, 1000), { tokens: 500, exact: true, share: 0.5, free: 500, parts: [] })
})

test('a request is weighed part by part: what was said, what the tools did, whose tools, whose instructions', () => {
  const tool = (name: string) => ({ name, description: 'does a thing with files', parameters: { type: 'object', properties: { path: { type: 'string' } } } })
  const request = {
    system: 'You help with software tasks.\n\nAlways answer in French.\n\nSkills: review, release',
    messages: [
      { role: 'user' as const, content: '请看一下这个文件', skill: { name: 'review', prompt: 'x'.repeat(400) } },
      { role: 'assistant' as const, content: '好的', tool_calls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"}' }] },
      { role: 'tool' as const, tool_call_id: 'c1', content: 'y'.repeat(4000) },
      { role: 'assistant' as const, content: 'done' }
    ],
    tools: [tool('read_file'), tool('word_count'), tool('mcp_fs_list'), tool('mcp_fs_read')]
  }
  const one = estimateTokens('read_file') + estimateTokens('does a thing with files') + estimateTokens(JSON.stringify(tool('x').parameters))
  const parts = weigh(request, {
    custom: 'Always answer in French.',
    skills: 'Skills: review, release',
    toolKind: (name) => (name.startsWith('mcp_') ? 'mcp' : name === 'word_count' ? 'plugin' : 'builtin')
  })
  assert.deepEqual(parts, {
    // What the person wrote (the skill they picked with it) and what the model answered.
    messages: estimateTokens('请看一下这个文件') + 100 + estimateTokens('好的') + estimateTokens('done'),
    // The call, and what the tool returned.
    toolResults: estimateTokens('read_file') + estimateTokens('{"path":"a.txt"}') + 1000,
    tools: one,
    pluginTools: estimateTokens('word_count') + one - estimateTokens('read_file'),
    mcpTools: 2 * (one - estimateTokens('read_file')) + estimateTokens('mcp_fs_list') + estimateTokens('mcp_fs_read'),
    // The instructions without what is the person's and without the list of skills.
    system: estimateTokens(request.system) - estimateTokens('Always answer in French.') - estimateTokens('Skills: review, release'),
    custom: estimateTokens('Always answer in French.'),
    skills: estimateTokens('Skills: review, release')
  })

  // Told nothing more, every tool is taken for the app's own and all the instructions for one.
  assert.deepEqual(Object.keys(weigh(request)).sort(), ['messages', 'system', 'toolResults', 'tools'])
  assert.equal(weigh(request).system, estimateTokens(request.system))
  // What is said to be the person's or the skills' but does not stand in the instructions is not counted as theirs.
  assert.equal(weigh(request, { custom: 'Not in there', skills: 'Nor this' }).custom, undefined)
  // An empty request weighs nothing, and lists nothing.
  assert.deepEqual(weigh({ system: '', messages: [], tools: [] }), {})
})

test('a text is weighed roughly: a Chinese character about a token, four other characters about one', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcde'), 2)
  assert.equal(estimateTokens('你好世界'), 4)
  assert.equal(estimateTokens('你好, world'), 2 + 2)
  assert.equal(estimateTokens('こんにちは'), 5)
  assert.equal(estimateTokens('x'.repeat(4000)), 1000)
})

test('numbers are written the way people read them', () => {
  assert.deepEqual([1300, 50_100, 59_940, 59_960, 86_000, 605_000, 3_900_000].map(formatDuration), ['1.3 秒', '50.1 秒', '59.9 秒', '1 分 00 秒', '1 分 26 秒', '10 分 05 秒', '1 小时 05 分'])
  // Too short to say in seconds: a tool that ran for a blink is not one that did not run.
  assert.deepEqual([0, 0.4, 12, 99, 100].map(formatDuration), ['0 秒', '1 毫秒', '12 毫秒', '99 毫秒', '0.1 秒'])
  assert.deepEqual([0, 940, 999, 1000, 6100, 18_240, 99_960, 133_000, 999_400, 999_600, 1_524_521, 12_000_000].map(formatTokens), ['0', '940', '999', '1K', '6.1K', '18.2K', '100K', '133K', '999K', '1M', '1.5M', '12M'])
  assert.equal(formatCount(1_524_521), '1,524,521')
  assert.equal(formatCount(13_844.4), '13,844')
  assert.deepEqual([0, 0.004, 0.13, 0.925, 1].map(formatShare), ['0%', '<1%', '13%', '93%', '100%'])
  assert.deepEqual([0, 0.0004, 0.003, 0.288, 0.867, 1].map(formatShareFine), ['0.0%', '0.0%', '0.3%', '28.8%', '86.7%', '100.0%'])
})

test('the size of a context can be typed the way it is usually written', () => {
  assert.deepEqual(['128K', '128k', ' 1M ', '1.5m', '32768', '8,192', '200 K', '32_768'].map(readWindow), [128_000, 128_000, 1_000_000, 1_500_000, 32_768, 8192, 200_000, 32_768])
  for (const odd of ['', 'big', '128KB', '-5', '12', '1G', '999M', 'K']) assert.equal(readWindow(odd), null, odd)
})

test('the app knows the size of the context of well-known models, and guesses at no others', () => {
  const known: Record<string, number | undefined> = {
    'deepseek-flash': 1_000_000,
    'deepseek-v4-pro': 1_000_000,
    'gpt-6.2-astra': 1_050_000,
    'gpt-6-luna': 1_050_000,
    'openai/gpt-6.2-sol': 1_050_000,
    'grok-4.7': 500_000,
    'grok-4.3': 1_000_000,
    'grok-4.20-0309-reasoning': 1_000_000,
    'claude-opus-5-5': 1_000_000,
    'Claude-Fable-5-2': 1_000_000,
    'claude-haiku-4-5-20251001': 200_000,
    // A name that only looks like one of them is not taken for it.
    'grok-4.75': undefined,
    'gpt-6.2-astral': undefined,
    'claude-opus-4-5': undefined,
    'deepseek-chat': undefined,
    'qwen3.5:9b': undefined,
    '': undefined
  }
  for (const [model, tokens] of Object.entries(known)) assert.equal(knownContextWindow(model), tokens, model)
})
