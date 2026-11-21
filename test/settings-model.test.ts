import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as model from '../src/main/settings-model.ts'
import { offersFastMode, usualEfforts } from '../src/shared/types.ts'

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
    assert.equal(model.toPublic(settings).hasApiKey, false)
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
