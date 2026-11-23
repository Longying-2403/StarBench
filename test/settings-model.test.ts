import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as model from '../src/main/settings-model.ts'
import { presetEffort, startingEffort } from '../src/shared/effort-defaults.ts'
import { CUSTOM_PROMPT_LIMIT, effortName, isLocalAddress, offersFastMode, usualEfforts } from '../src/shared/types.ts'

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
  // A well-known model has a level of its own to start at, which is in use like a chosen one.
  assert.equal(model.toPublic(settings).reasoningEffort, 'high', 'another model starts at its own level, not at the choice made for the first')
  assert.equal(settings.providers[0].efforts?.['deepseek-v4-pro'], undefined, 'and nothing is written down for it until a level is chosen')
  settings = model.setEffort(settings, 'low')
  settings = model.selectModel(settings, 'deepseek', 'deepseek-flash')
  assert.equal(model.toPublic(settings).reasoningEffort, 'max', 'coming back finds the earlier choice')

  // Choosing a model of another provider switches to that provider. A model the app does not
  // know has no level to start at: nothing is chosen, nothing will be sent, and the service decides.
  settings = model.selectModel(settings, 'openai', 'gpt-test')
  const shown = model.toPublic(settings)
  assert.deepEqual([shown.activeProviderId, shown.kind, shown.model, shown.reasoningEffort], ['openai', 'openai-responses', 'gpt-test', 'default'])
  assert.deepEqual(settings.providers[0].efforts, { 'deepseek-flash': 'max', 'deepseek-v4-pro': 'low' })
  // One it knows starts at its level with this provider too, and keeps a choice apart from it.
  settings = model.selectModel(settings, 'openai', 'gpt-6.2-sol')
  assert.equal(model.toPublic(settings).reasoningEffort, 'medium')
  settings = model.setEffort(settings, 'xhigh')
  assert.equal(model.toPublic(settings).reasoningEffort, 'xhigh')
  settings = model.setEffort(settings, 'default')
  assert.equal(model.toPublic(settings).reasoningEffort, 'medium', 'taking the choice back leads to the level the model starts at')

  // Back to "nothing chosen" removes the entry rather than storing the word.
  settings = model.selectModel(settings, 'deepseek', 'deepseek-flash')
  settings = model.setEffort(settings, 'default')
  assert.deepEqual(settings.providers[0].efforts, { 'deepseek-v4-pro': 'low' })
  assert.equal(model.toPublic(settings).reasoningEffort, 'high')

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

test('a thinking level is called what its service calls it', () => {
  // The names as the services write them, in whatever language the rest of the app speaks.
  const levels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
  assert.deepEqual(levels.map((level) => effortName(level, 'https://api.anthropic.com')), ['Minimal', 'Low', 'Medium', 'High', 'xHigh', 'Max'])
  assert.equal(effortName('xhigh', 'https://api.x.ai/v1'), 'xHigh')
  assert.equal(effortName('xhigh', 'https://us.api.x.ai/v1'), 'xHigh')
  assert.equal(effortName('max', 'https://api.deepseek.com'), 'Max')
  // OpenAI's own products call the step above high "Extra High". Paid for with an API key or with a ChatGPT plan, the address is the same.
  assert.equal(effortName('xhigh', 'https://api.openai.com/v1'), 'Extra High')
  assert.equal(effortName('xhigh', 'https://API.OpenAI.com/v1/'), 'Extra High')
  assert.deepEqual(levels.filter((level) => level !== 'xhigh').map((level) => effortName(level, 'https://api.openai.com/v1')), ['Minimal', 'Low', 'Medium', 'High', 'Max'])
  // A service nothing is known about, an address that only has OpenAI's name in it, and no address at all.
  assert.equal(effortName('xhigh', 'https://llm.example.com/v1'), 'xHigh')
  assert.equal(effortName('xhigh', 'https://api.openai.com.example.com/v1'), 'xHigh')
  assert.equal(effortName('xhigh', 'not an address'), 'xHigh')
  assert.equal(effortName('xhigh'), 'xHigh')
  // No two levels of a service go by one name: the slider tells its stops apart by them.
  for (const address of ['https://api.openai.com/v1', 'https://api.anthropic.com', 'http://localhost:11434/v1']) {
    assert.equal(new Set(levels.map((level) => effortName(level, address))).size, levels.length, address)
  }
})

test('a well-known model has a level of thinking it starts at, and any other has none', () => {
  const of = (...models: string[]): (string | undefined)[] => models.map(presetEffort)
  // The defaults the services name. Most of Claude's models think at "high"; two of the family at "medium".
  assert.deepEqual(of('claude-fable-5-2', 'claude-mythos-5-1', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-6', 'claude-sonnet-4-6'), Array(8).fill('high'))
  assert.deepEqual(of('claude-opus-5-5', 'claude-haiku-5-5'), ['medium', 'medium'])
  assert.deepEqual(of('gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6', 'gpt-5.6-terra', 'gpt-5.5', 'gpt-5.5-2026-04-23'), Array(7).fill('medium'))
  assert.deepEqual(of('grok-4.7', 'grok-4.6', 'grok-4.5', 'deepseek-flash', 'deepseek-v4-pro'), Array(5).fill('high'))
  // The rest of the GPT-6 family, whose default is not named: the app's own choice, the same as the others'.
  assert.deepEqual(of('gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra'), ['medium', 'medium', 'medium'])
  // As services and gateways write an id: in any case, with spaces around it, with the gateway's own name before it.
  assert.deepEqual(of(' Claude-Opus-5-5 ', 'anthropic/claude-opus-5-5', 'openai/gpt-6-luna'), ['medium', 'medium', 'medium'])
  // Nothing is made up for a model that takes no level, for one that only looks like a known one, or for one nobody has heard of.
  assert.deepEqual(of('gpt-5.5-pro', 'gpt-5', 'gpt-6', 'gpt-6.2', 'grok-4.3', 'grok-4.20-0309-reasoning'), Array(6).fill(undefined))
  assert.deepEqual(of('claude-haiku-4-5', 'claude-mythos-preview', 'claude-opus-55', 'qwen3.5:9b', 'my-claude-opus-5-5', ''), Array(6).fill(undefined))

  // With the service it is reached through: the level has to be one that service offers.
  assert.equal(startingEffort({ model: 'gpt-6.2-sol', baseURL: 'https://api.openai.com/v1', kind: 'openai-responses' }), 'medium')
  assert.equal(startingEffort({ model: 'claude-opus-5-5', baseURL: 'https://api.anthropic.com', kind: 'anthropic' }), 'medium')
  assert.equal(startingEffort({ model: 'grok-4.7', baseURL: 'https://api.x.ai/v1', kind: 'openai-chat' }), 'high')
  assert.equal(startingEffort({ model: 'deepseek-flash', baseURL: 'https://api.deepseek.com' }), 'high')
  assert.equal(startingEffort({ model: 'openai/gpt-6.2-sol', baseURL: 'https://gateway.example/v1' }), 'medium', 'through a gateway too')
  assert.equal(startingEffort({ model: 'gpt-6.2-sol', baseURL: 'https://api.deepseek.com' }), undefined, 'DeepSeek has no "medium"')
  // A server on one's own machine decides for itself, whatever its model is called. So does any service for a model that is not known.
  assert.equal(startingEffort({ model: 'deepseek-flash', baseURL: 'http://localhost:11434/v1' }), undefined)
  assert.equal(startingEffort({ model: 'gpt-6.2-sol', baseURL: 'http://192.168.1.20:8000/v1', kind: 'openai-responses' }), undefined)
  assert.equal(startingEffort({ model: 'qwen3.5:9b', baseURL: 'https://llm.example.com/v1' }), undefined)
  assert.equal(startingEffort({ model: '', baseURL: 'https://api.openai.com/v1' }), undefined)
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

test('a workspace can be given a name of its own, which goes when the workspace is forgotten', () => {
  const windows = true
  const fresh = model.readSettings({ recentWorkspaces: ['D:\\Work\\App', 'D:\\Notes'] })
  assert.equal('workspaceNames' in fresh, false)
  assert.deepEqual(model.toPublic(fresh).workspaceNames, {})

  // Kept by the folder, on one line; the folder itself is not what is renamed.
  let settings = model.nameWorkspace(fresh, 'D:\\Work\\App', '  主\n项目 ', windows)
  assert.deepEqual(settings.workspaceNames, { 'd:/work/app': '主 项目' })
  assert.deepEqual(model.toPublic(settings).workspaceNames, { 'd:/work/app': '主 项目' })
  assert.deepEqual(settings.recentWorkspaces, fresh.recentWorkspaces)
  // Another spelling of the folder is the same workspace.
  settings = model.nameWorkspace(settings, 'd:/work/app/', 'Main', windows)
  assert.deepEqual(settings.workspaceNames, { 'd:/work/app': 'Main' })
  assert.deepEqual(model.readSettings(JSON.parse(JSON.stringify(settings))), settings, 'kept through a save and a load')
  assert.equal(model.nameWorkspace(settings, 'D:\\Work\\App', 'x'.repeat(200), windows).workspaceNames?.['d:/work/app'].length, 60)

  // An empty name takes the given one back, and so does the folder's own; nothing is then written down.
  for (const none of ['', '  \n ', 'App', 7, null, undefined]) {
    assert.deepEqual(model.nameWorkspace(settings, 'D:\\Work\\App', none, windows), fresh, String(none))
  }
  assert.throws(() => model.nameWorkspace(settings, '  ', 'Main', windows), /No folder was named/)

  // Where case tells folders apart, so it does their names.
  const posix = model.nameWorkspace(model.nameWorkspace(fresh, '/home/me/App', 'One', false), '/home/me/app', 'Two', false)
  assert.deepEqual(posix.workspaceNames, { '/home/me/App': 'One', '/home/me/app': 'Two' })

  // Forgotten, a folder is no longer among the remembered ones, in whichever spelling it is asked for, and its name goes with it.
  settings = model.nameWorkspace(settings, 'D:\\Notes', '笔记', windows)
  const gone = model.forgetWorkspace(settings, 'd:\\work\\app\\', windows)
  assert.deepEqual(gone.recentWorkspaces, ['D:\\Notes'])
  assert.deepEqual(gone.workspaceNames, { 'd:/notes': '笔记' })
  const empty = model.forgetWorkspace(gone, 'D:\\Notes', windows)
  assert.equal('recentWorkspaces' in empty, false)
  assert.equal('workspaceNames' in empty, false)
  assert.deepEqual(empty.providers, fresh.providers, 'nothing else is touched')
  assert.deepEqual(model.forgetWorkspace(fresh, 'D:\\Elsewhere', windows), fresh, 'a folder that was not remembered changes nothing')

  // A file that holds something else is read as far as it makes sense.
  const read = model.readSettings(JSON.parse('{"workspaceNames":{"d:/a":" A  1 ","d:/b":"","d:/c":5,"":"x","__proto__":"P"}}'))
  assert.deepEqual(Object.entries(read.workspaceNames ?? {}), [
    ['d:/a', 'A 1'],
    // A folder like any other, not the object's own workings.
    ['__proto__', 'P']
  ])
  assert.equal(Object.getPrototypeOf(read.workspaceNames), Object.prototype)
  for (const odd of ['names', ['d:/a'], 5, null, {}]) assert.equal('workspaceNames' in model.readSettings({ workspaceNames: odd }), false, String(odd))
})
