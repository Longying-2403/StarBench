import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as model from '../src/main/settings-model.ts'
import { CUSTOM_PROMPT_LIMIT, isLocalAddress, offersFastMode, usualEfforts } from '../src/shared/types.ts'

test('settings from before there were providers keep their key, model and effort', () => {
  const old = {
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'max',
    encryptedKey: 'ZW5jcnlwdGVk',
    recentWorkspaces: ['D:\\Work', 7]
  }
  const settings = model.readSettings(old)
  assert.deepEqual(settings, {
    providers: [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        kind: 'openai-chat',
        baseURL: 'https://api.deepseek.com',
        model: 'deepseek-v4-pro',
        encryptedKey: 'ZW5jcnlwdGVk',
        efforts: { 'deepseek-v4-pro': 'max' }
      }
    ],
    activeProviderId: 'deepseek',
    recentWorkspaces: ['D:\\Work']
  })
  // Reading what was just produced changes nothing: the conversion happens once.
  assert.deepEqual(model.readSettings(settings), settings)

  // Another service keeps speaking chat completions, as that version did with every service.
  const other = model.readSettings({ baseURL: 'https://llm.example.com/v1', model: 'm', reasoningEffort: 'default' })
  assert.deepEqual(other.providers, [{ id: 'custom', name: 'llm.example.com', kind: 'openai-chat', baseURL: 'https://llm.example.com/v1', model: 'm' }])
})

test('a missing or unusable settings file becomes the defaults', () => {
  for (const raw of [null, 'text', [], {}, { providers: [] }, { providers: [{ kind: 'telepathy', baseURL: 'https://x' }, 5] }]) {
    const settings = model.readSettings(raw)
    assert.equal(settings.providers.length, 1)
    assert.equal(settings.providers[0].id, 'deepseek')
    assert.equal(settings.activeProviderId, 'deepseek')
    assert.equal(model.toPublic(settings).ready, false)
  }
  // Hand-edited entries are repaired where possible: ids made unique, unknown efforts dropped.
  const settings = model.readSettings({
    providers: [
      { id: 'a', name: 'One', kind: 'anthropic', baseURL: 'https://api.anthropic.com', model: 'm', efforts: { m: 'ludicrous', n: 'high', o: 'default' } },
      { id: 'a', name: 'Two', kind: 'openai-chat', baseURL: 'https://two.example' }
    ],
    activeProviderId: 'gone'
  })
  assert.deepEqual(
    settings.providers.map((p) => [p.id, p.model, p.efforts]),
    [
      ['a', 'm', { n: 'high' }],
      ['two', '', undefined]
    ]
  )
  assert.equal(settings.activeProviderId, 'a')
})

test('providers can be added, changed and removed', () => {
  let settings = model.readSettings(null)
  // The first provider with a key takes over from the default one, which has none.
  settings = model.saveProvider(settings, { name: 'Anthropic', kind: 'anthropic', baseURL: 'https://api.anthropic.com', model: 'claude-opus-5-5' }, 'KEY1')
  assert.equal(settings.activeProviderId, 'anthropic')
  settings = model.saveProvider(settings, { name: 'Anthropic', kind: 'anthropic', baseURL: 'https://gateway.example/', model: '' }, 'KEY2')
  assert.deepEqual(
    settings.providers.map((p) => p.id),
    ['deepseek', 'anthropic', 'anthropic-2']
  )
  assert.equal(settings.activeProviderId, 'anthropic', 'a later addition does not take over')

  // Changing a provider keeps its key unless a new one is given or it is cleared.
  settings = model.saveProvider(settings, { id: 'anthropic', name: 'Claude', kind: 'anthropic', baseURL: 'https://api.anthropic.com', model: 'claude-haiku-5-5' })
  assert.deepEqual(settings.providers[1], { id: 'anthropic', name: 'Claude', kind: 'anthropic', baseURL: 'https://api.anthropic.com', model: 'claude-haiku-5-5', encryptedKey: 'KEY1' })
  settings = model.saveProvider(settings, { id: 'anthropic-2', name: 'Gateway', kind: 'anthropic', baseURL: 'https://gateway.example/', model: '' }, null)
  assert.equal(settings.providers[2].encryptedKey, undefined)
  assert.deepEqual(model.toPublic(settings).providers.map((p) => p.hasApiKey), [false, true, false])
  assert.deepEqual(model.toPublic(settings).providers.map((p) => p.ready), [false, true, false], 'a service on the internet needs its key')

  assert.throws(() => model.saveProvider(settings, { name: 'x', kind: 'anthropic', baseURL: 'ftp://nope', model: '' }), /http/)
  assert.throws(() => model.saveProvider(settings, { id: 'ghost', name: 'x', kind: 'anthropic', baseURL: 'https://x', model: '' }), /no longer exists/)
  assert.throws(() => model.saveProvider(settings, { name: 'x', kind: 'carrier-pigeon' as never, baseURL: 'https://x', model: '' }), /kind/)

  // Removing the provider in use moves on to one with a key; the last one stays.
  settings = model.saveProvider(settings, { id: 'deepseek', name: 'DeepSeek', kind: 'openai-chat', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash' }, 'KEY3')
  settings = model.removeProvider(settings, 'anthropic')
  assert.equal(settings.activeProviderId, 'deepseek')
  settings = model.removeProvider(settings, 'anthropic-2')
  assert.throws(() => model.removeProvider(settings, 'deepseek'), /last provider/)
  assert.equal(model.removeProvider(settings, 'ghost'), settings)
})

test('the model and the effort are remembered for each provider and model', () => {
  let settings = model.readSettings(null)
  settings = model.saveProvider(settings, { name: 'OpenAI', kind: 'openai-responses', baseURL: 'https://api.openai.com/v1', model: '' }, 'KEY')
  // The new provider is the only one with a key, so it is in use, but it has no model yet.
  assert.equal(settings.activeProviderId, 'openai')
  assert.equal(model.setEffort(settings, 'max'), settings, 'an effort needs a model to belong to')

  settings = model.selectModel(settings, 'deepseek', 'deepseek-flash')
  settings = model.setEffort(settings, 'max')
  assert.equal(model.toPublic(settings).reasoningEffort, 'max')
  settings = model.selectModel(settings, 'deepseek', 'deepseek-v4-pro')
  assert.equal(model.toPublic(settings).reasoningEffort, 'default', 'another model starts from the default')
  settings = model.setEffort(settings, 'low')
  settings = model.selectModel(settings, 'deepseek', 'deepseek-flash')
  assert.equal(model.toPublic(settings).reasoningEffort, 'max', 'coming back finds the earlier choice')

  // Choosing a model of another provider switches to that provider.
  settings = model.selectModel(settings, 'openai', 'gpt-test')
  const shown = model.toPublic(settings)
  assert.deepEqual([shown.activeProviderId, shown.kind, shown.model, shown.reasoningEffort], ['openai', 'openai-responses', 'gpt-test', 'default'])
  assert.deepEqual(settings.providers[0].efforts, { 'deepseek-flash': 'max', 'deepseek-v4-pro': 'low' })

  // Back to "nothing chosen" removes the entry rather than storing the word.
  settings = model.selectModel(settings, 'deepseek', 'deepseek-flash')
  settings = model.setEffort(settings, 'default')
  assert.deepEqual(settings.providers[0].efforts, { 'deepseek-v4-pro': 'low' })

  assert.throws(() => model.selectModel(settings, 'ghost', 'm'), /no longer exists/)
  assert.throws(() => model.selectModel(settings, 'deepseek', '  '), /No model/)
})

test('the thinking levels on offer follow the service', () => {
  const common = ['low', 'medium', 'high', 'xhigh', 'max']
  assert.deepEqual(usualEfforts('https://api.openai.com/v1'), common)
  assert.deepEqual(usualEfforts('https://api.anthropic.com'), common)
  // Thinking can be switched off, and there is no step between low and high.
  assert.deepEqual(usualEfforts('https://api.deepseek.com'), ['none', 'low', 'high', 'max'])
  assert.deepEqual(usualEfforts('https://API.DeepSeek.com/v1/'), ['none', 'low', 'high', 'max'])
  // One step short of the others.
  assert.deepEqual(usualEfforts('https://api.x.ai/v1'), ['low', 'medium', 'high', 'xhigh'])
  // A service nothing is known about, or an address that is not one.
  assert.deepEqual(usualEfforts('https://llm.example.com/v1'), common)
  assert.deepEqual(usualEfforts('not an address'), common)
  // A model server on one's own machine: thinking on or off is what matters, and no rare names are sent.
  assert.deepEqual(usualEfforts('http://localhost:11434/v1'), ['none', 'low', 'medium', 'high'])
  assert.deepEqual(usualEfforts('http://192.168.1.20:1234/v1', 'openai-chat'), ['none', 'low', 'medium', 'high'])
  assert.deepEqual(usualEfforts('http://localhost:11434', 'anthropic'), common, 'the other formats have their own names')
})

test('an address on this computer or the local network is told from one on the internet', () => {
  const local = [
    'http://localhost:11434/v1',
    'http://LOCALHOST:1234/v1',
    'http://127.0.0.1:8080/v1',
    'http://[::1]:8000/v1',
    'http://10.0.0.5/v1',
    'http://172.16.0.1:8000/v1',
    'http://172.31.255.255/v1',
    'http://192.168.1.20:11434/v1',
    'http://169.254.10.10:11434/v1',
    'http://100.100.1.2:11434/v1',
    'http://[fd12:3456::1]:11434/v1',
    'http://[fe80::1]:11434/v1',
    'http://gpu-box:11434/v1',
    'http://studio.local:1234/v1',
    'https://models.home.arpa/v1'
  ]
  const elsewhere = [
    'https://api.openai.com/v1',
    'https://llm.example.com/v1',
    'https://localhost.example.com/v1',
    'http://8.8.8.8/v1',
    'http://172.32.0.1/v1',
    'http://192.169.1.1/v1',
    'http://100.128.0.1/v1',
    'http://[2001:db8::1]/v1',
    'not an address',
    ''
  ]
  assert.deepEqual(local.filter((address) => !isLocalAddress(address)), [])
  assert.deepEqual(elsewhere.filter(isLocalAddress), [])
})

test("a provider keeps a prompt of the person's own", () => {
  const local = { name: 'Local', kind: 'openai-chat' as const, baseURL: 'http://localhost:8000/v1', model: 'm' }
  let settings = model.saveProvider(model.readSettings(null), local, 'KEY')
  const before = settings.providers[1]
  settings = model.setPrompt(settings, 'local', { text: '  You are Mei.  ', replace: true })
  // Nothing else about the provider changes, and no other provider is touched.
  assert.deepEqual(settings.providers[1], { ...before, prompt: { text: 'You are Mei.', replace: true } })
  assert.deepEqual(model.toPublic(settings).providers[1].prompt, { text: 'You are Mei.', replace: true })
  assert.equal(model.toPublic(settings).providers[0].prompt, undefined)

  // Saving the provider's other settings leaves it alone.
  settings = model.saveProvider(settings, { ...local, id: 'local', model: 'other' })
  assert.deepEqual(settings.providers[1].prompt, { text: 'You are Mei.', replace: true })
  // Emptied, or given as nothing, it is taken away.
  settings = model.setPrompt(settings, 'local', { text: '   ', replace: true })
  assert.equal('prompt' in settings.providers[1], false)
  settings = model.setPrompt(settings, 'local', { text: 'Short answers.', replace: false })
  assert.deepEqual(settings.providers[1].prompt, { text: 'Short answers.', replace: false })
  settings = model.setPrompt(settings, 'local', null)
  assert.equal('prompt' in settings.providers[1], false)
  assert.throws(() => model.setPrompt(settings, 'ghost', { text: 'x', replace: false }), /no longer exists/)

  // A provider that is signed in to has one like any other.
  let signedIn = model.readSettings({ providers: [{ id: 'chatgpt', name: 'ChatGPT', kind: 'openai-responses', baseURL: 'https://api.openai.com/v1', auth: 'chatgpt' }] })
  signedIn = model.setPrompt(signedIn, 'chatgpt', { text: 'Be brief.', replace: false })
  assert.deepEqual([signedIn.providers[0].auth, signedIn.providers[0].prompt], ['chatgpt', { text: 'Be brief.', replace: false }])

  // What a file holds is cut to length and cleaned of what is no prompt.
  const read = model.readSettings({
    providers: [
      { id: 'a', name: 'A', kind: 'openai-chat', baseURL: 'https://a.example', prompt: { text: 'x'.repeat(CUSTOM_PROMPT_LIMIT + 5), replace: 'yes' } },
      { id: 'b', name: 'B', kind: 'openai-chat', baseURL: 'https://b.example', prompt: 'just text' }
    ]
  })
  assert.deepEqual([read.providers[0].prompt?.text.length, read.providers[0].prompt?.replace], [CUSTOM_PROMPT_LIMIT, false])
  assert.equal(read.providers[1].prompt, undefined)
})

test('a model server on this computer can be used without a key', () => {
  let settings = model.readSettings(null)
  settings = model.saveProvider(settings, { name: 'Ollama', kind: 'openai-chat', baseURL: 'http://localhost:11434/v1', model: '' })
  // Usable as it is, so it takes over from the default provider, which still waits for its key.
  assert.equal(settings.activeProviderId, 'ollama')
  assert.equal(settings.providers[1].encryptedKey, undefined)
  let shown = model.toPublic(settings)
  assert.deepEqual(shown.providers.map((p) => [p.id, p.ready, p.hasApiKey]), [['deepseek', false, false], ['ollama', true, false]])
  assert.equal(shown.ready, true)

  // A key can still be given, for a server on the network that asks for one.
  settings = model.saveProvider(settings, { id: 'ollama', name: 'Ollama', kind: 'openai-chat', baseURL: 'http://192.168.1.20:11434/v1', model: 'qwen3.5:9b' }, 'KEY')
  shown = model.toPublic(settings)
  assert.deepEqual([shown.providers[1].ready, shown.providers[1].hasApiKey], [true, true])

  // Moved to an address on the internet without one, it has to wait like any other service.
  settings = model.saveProvider(settings, { id: 'ollama', name: 'Ollama', kind: 'openai-chat', baseURL: 'https://ollama.example.com/v1', model: 'qwen3.5:9b' }, null)
  assert.equal(model.toPublic(settings).ready, false)
})

test('faster answers are remembered for each model, and offered only where the service has them', () => {
  let settings = model.readSettings(null)
  settings = model.saveProvider(settings, { name: 'OpenAI', kind: 'openai-responses', baseURL: 'https://api.openai.com/v1', model: 'gpt-6.2-sol' }, 'KEY')
  assert.equal(model.toPublic(settings).fastMode, false)
  settings = model.setFast(settings, true)
  settings = model.setFast(settings, true)
  assert.deepEqual(settings.providers[1].fast, ['gpt-6.2-sol'], 'switching it on twice lists the model once')
  assert.equal(model.toPublic(settings).fastMode, true)

  // The choice belongs to the model: another one starts without it, coming back finds it again.
  settings = model.selectModel(settings, 'openai', 'gpt-6.1-sol')
  assert.equal(model.toPublic(settings).fastMode, false)
  settings = model.selectModel(settings, 'openai', 'gpt-6.2-sol')
  assert.equal(model.toPublic(settings).fastMode, true)
  assert.deepEqual(model.readSettings(JSON.parse(JSON.stringify(settings))), settings, 'it survives the settings file')
  // Changing other things about the provider leaves it alone.
  settings = model.saveProvider(settings, { id: 'openai', name: 'OpenAI', kind: 'openai-responses', baseURL: 'https://api.openai.com/v1', model: 'gpt-6.2-sol' })
  assert.equal(model.toPublic(settings).fastMode, true)

  // It can be taken back for a model by name, whichever provider is in use at that moment.
  const elsewhere = model.setFastFor({ ...settings, activeProviderId: 'deepseek' }, 'openai', 'gpt-6.2-sol', false)
  assert.equal(elsewhere.providers[1].fast, undefined)
  assert.equal(model.setFastFor(settings, 'ghost', 'gpt-6.2-sol', false), settings)

  settings = model.setFast(settings, false)
  assert.equal(settings.providers[1].fast, undefined)
  assert.equal(model.toPublic(settings).fastMode, false)
  // Without a model there is nothing to remember it for.
  const noModel = model.selectModel(model.saveProvider(settings, { name: 'xAI', kind: 'openai-chat', baseURL: 'https://api.x.ai/v1', model: '' }, 'KEY'), 'openai', 'gpt-6.2-sol')
  assert.equal(model.setFast({ ...noModel, activeProviderId: 'xai' }, true).providers[2].fast, undefined)

  const openai = { kind: 'openai-responses', baseURL: 'https://api.openai.com/v1', model: 'gpt-6.2-sol' } as const
  assert.equal(offersFastMode(openai), true)
  assert.equal(offersFastMode({ ...openai, model: '' }), false)
  assert.equal(offersFastMode({ ...openai, baseURL: 'https://gateway.example/v1' }), false, 'a gateway may not know the request field')
  // Signed in with ChatGPT, the address does not matter: it is OpenAI's API by definition.
  assert.equal(offersFastMode({ ...openai, baseURL: 'http://127.0.0.1:9555/v1', auth: 'chatgpt' }), true)
  const claude = { kind: 'anthropic', baseURL: 'https://api.anthropic.com' } as const
  assert.deepEqual(
    ['claude-fable-5-2', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map((id) => offersFastMode({ ...claude, model: id })),
    [true, true, false, false, false]
  )
  assert.equal(offersFastMode({ ...claude, baseURL: 'https://gateway.example', model: 'claude-opus-5-5' }), false)
  assert.equal(offersFastMode({ kind: 'openai-chat', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash' }), false)
  assert.equal(offersFastMode({ kind: 'openai-chat', baseURL: 'https://api.x.ai/v1', model: 'grok-4.7' }), false)
})

test('the size of a context typed in by hand is kept for the model it was typed for', () => {
  let settings = model.readSettings({
    providers: [
      { id: 'local', name: 'Ollama', kind: 'openai-chat', baseURL: 'http://localhost:11434/v1', model: 'qwen3.5:9b' },
      { id: 'other', name: 'Other', kind: 'openai-chat', baseURL: 'https://api.example.com/v1', model: 'm1', encryptedKey: 'ZW5j' }
    ],
    activeProviderId: 'local'
  })
  assert.equal(model.windowOf(model.activeProvider(settings)), undefined)

  settings = model.setWindow(settings, 'local', 'qwen3.5:9b', 32_768)
  settings = model.setWindow(settings, 'local', 'another:7b', 8192)
  assert.deepEqual(settings.providers[0].windows, { 'qwen3.5:9b': 32_768, 'another:7b': 8192 })
  assert.equal(model.windowOf(model.activeProvider(settings)), 32_768)
  assert.equal(settings.providers[1].windows, undefined, 'each provider has its own')
  // It is for one model: with another model chosen there is none.
  assert.equal(model.windowOf(model.activeProvider(model.setModel(settings, 'local', 'third:1b'))), undefined)
  // Kept through a save and a load, and through a change of the provider's other fields.
  assert.deepEqual(model.readSettings(JSON.parse(JSON.stringify(settings))), settings)
  assert.deepEqual(model.saveProvider(settings, { id: 'local', name: 'Renamed', kind: 'openai-chat', baseURL: 'http://localhost:11434/v1', model: 'qwen3.5:9b' }).providers[0].windows, {
    'qwen3.5:9b': 32_768,
    'another:7b': 8192
  })

  // Taken back, model by model; with the last one gone nothing is left to store.
  settings = model.setWindow(settings, 'local', 'qwen3.5:9b', null)
  assert.deepEqual(settings.providers[0].windows, { 'another:7b': 8192 })
  settings = model.setWindow(settings, 'local', 'another:7b', null)
  assert.equal('windows' in settings.providers[0], false)

  // What is not a size is refused, and what a file holds that is not one is dropped.
  for (const odd of [0, 12, -5, 1.5, Number.NaN, 1e12]) assert.throws(() => model.setWindow(settings, 'local', 'qwen3.5:9b', odd), /not a size/, String(odd))
  assert.equal(model.setWindow(settings, 'gone', 'm', 1000), settings, 'a provider that is no longer there changes nothing')
  const read = model.readSettings({ providers: [{ id: 'a', name: 'A', kind: 'openai-chat', baseURL: 'http://localhost:1/v1', model: 'm', windows: { good: 4096, text: '8k', tiny: 3, half: 10.5 } }] })
  assert.deepEqual(read.providers[0].windows, { good: 4096 })
})

test('the counting of what conversations cost is on unless it was switched off', () => {
  const fresh = model.readSettings(undefined)
  assert.equal('stats' in fresh, false)
  assert.equal(model.toPublic(fresh).stats, true)

  const off = model.setStats(fresh, false)
  assert.equal(off.stats, false)
  assert.equal(model.toPublic(off).stats, false)
  assert.deepEqual(model.readSettings(JSON.parse(JSON.stringify(off))), off, 'kept through a save and a load')

  const on = model.setStats(off, true)
  assert.deepEqual(on, fresh, 'on is how the app comes, and is not written down')
  // Anything but an outright false in the file means on.
  for (const odd of [true, 'false', 0, null]) assert.equal(model.toPublic(model.readSettings({ stats: odd })).stats, true, String(odd))
})

test('conversations are compacted by themselves at four fifths of the context unless that was changed', () => {
  const fresh = model.readSettings(undefined)
  assert.equal('compaction' in fresh, false)
  assert.deepEqual(model.toPublic(fresh).compaction, { auto: true, share: 0.8, cap: null })

  // Each of the three is changed by itself, and what is not named stays.
  let settings = model.setCompaction(fresh, { share: 0.6 })
  assert.deepEqual(settings.compaction, { share: 0.6 })
  settings = model.setCompaction(settings, { cap: 200_000 })
  settings = model.setCompaction(settings, { auto: false })
  assert.deepEqual(settings.compaction, { auto: false, share: 0.6, cap: 200_000 })
  assert.deepEqual(model.compactionOf(settings), { auto: false, share: 0.6, cap: 200_000 })
  assert.deepEqual(model.readSettings(JSON.parse(JSON.stringify(settings))), settings, 'kept through a save and a load')

  // Taken back one by one; with all three as the app comes, nothing is written down.
  settings = model.setCompaction(settings, { cap: null })
  assert.deepEqual(settings.compaction, { auto: false, share: 0.6 })
  settings = model.setCompaction(settings, { auto: true, share: 0.8 })
  assert.deepEqual(settings, fresh)

  // A share out of range is brought to the nearest that can be set.
  assert.equal(model.compactionOf(model.setCompaction(fresh, { share: 0.2 })).share, 0.5)
  assert.equal(model.compactionOf(model.setCompaction(fresh, { share: 0.999 })).share, 0.95)
  // What is no share at all, and a cap that cannot be one, are refused: a slip must not compact everything at once.
  for (const odd of ['0.8', Number.NaN, null]) assert.throws(() => model.setCompaction(fresh, { share: odd }), /must be a number/, String(odd))
  for (const odd of [0, 300, 3999, 1.5e9, 20_000.5, '200K']) assert.throws(() => model.setCompaction(fresh, { cap: odd }), /whole number of tokens from 4000/, String(odd))
  assert.throws(() => model.setCompaction(fresh, 'auto'), /Nothing to change/)
  assert.deepEqual(model.setCompaction(fresh, {}), fresh)

  // A file that holds something else is read as far as it makes sense.
  const read = model.readSettings({ compaction: { auto: 'no', share: 7, cap: 12, more: true } })
  assert.deepEqual(read.compaction, { share: 0.95 })
  assert.equal('compaction' in model.readSettings({ compaction: 'on' }), false)
})
