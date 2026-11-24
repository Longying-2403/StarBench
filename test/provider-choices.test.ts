import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as model from '../src/main/settings-model.ts'
import { freeName, presetOffers, providerLabel, signInOffer } from '../src/shared/provider-choices.ts'
import { PROVIDER_PRESETS } from '../src/shared/types.ts'

/** By the service's id: what one more of it would be called, and whether one is there. */
const told = (offers: ReturnType<typeof presetOffers>): Record<string, string> =>
  Object.fromEntries(offers.map((offer) => [offer.preset.id, `${offer.name}${offer.added ? ' (there)' : ''}`]))

test('every service the app knows by name stays on offer, and says whether it is there already', () => {
  // As the app comes: DeepSeek, without a key yet.
  const offers = presetOffers(model.toPublic(model.readSettings(undefined)).providers)
  assert.deepEqual(
    offers.map((offer) => offer.preset.id),
    PROVIDER_PRESETS.map((preset) => preset.id),
    'all of them, in their order'
  )
  assert.deepEqual(told(offers), { deepseek: 'DeepSeek 2 (there)', openai: 'OpenAI', anthropic: 'Anthropic', xai: 'xAI', gemini: 'Gemini' })
})

test('a service that is there already is added once more under a name and an id of its own', () => {
  let settings = model.readSettings(undefined)
  const [deepseek] = presetOffers(model.toPublic(settings).providers)
  settings = model.saveProvider(settings, { name: deepseek.name, kind: deepseek.preset.kind, baseURL: deepseek.preset.baseURL, model: deepseek.preset.model }, 'a2V5')
  assert.deepEqual(
    settings.providers.map((p) => [p.id, p.name]),
    [
      ['deepseek', 'DeepSeek'],
      ['deepseek-2', 'DeepSeek 2']
    ]
  )
  assert.equal(settings.providers[1].encryptedKey, 'a2V5', 'with the key given for it')
  assert.equal('encryptedKey' in settings.providers[0], false, 'and the first one as it was')
  assert.equal(told(presetOffers(model.toPublic(settings).providers)).deepseek, 'DeepSeek 3 (there)')
})

test('a service counts as there by where a provider talks to, whatever that provider is called', () => {
  const settings = model.readSettings({
    providers: [
      { id: 'mine', name: '我的 Claude', kind: 'anthropic', baseURL: 'https://api.anthropic.com', model: '' },
      { id: 'grok', name: 'Grok', kind: 'openai-chat', baseURL: 'https://us.api.x.ai/v1', model: '' },
      { id: 'near', name: 'Gemini', kind: 'openai-chat', baseURL: 'http://localhost:8080/v1', model: '' }
    ]
  })
  const offers = told(presetOffers(model.toPublic(settings).providers))
  assert.equal(offers.anthropic, 'Anthropic (there)', 'its own name is free, so one more would take it')
  assert.equal(offers.xai, 'xAI (there)', 'the address of one region is the same service')
  assert.equal(offers.gemini, 'Gemini 2', 'a name alone is no service: this provider is a server on this computer')
  assert.equal(offers.deepseek, 'DeepSeek')
})

test('one more provider of a service is numbered from 2 on, past the numbers that are taken', () => {
  const called = (...all: string[]): { name: string }[] => all.map((name) => ({ name }))
  assert.equal(freeName('DeepSeek', called()), 'DeepSeek')
  assert.equal(freeName('DeepSeek', called('DeepSeek')), 'DeepSeek 2')
  assert.equal(freeName('DeepSeek', called('deepseek ', 'DeepSeek 2', 'DeepSeek 4')), 'DeepSeek 3', 'names are told apart as a person reads them')
  assert.equal(freeName('DeepSeek', called('DeepSeek 2')), 'DeepSeek', 'the plain name comes first where it is free')
})

test('signing in with an OpenAI account stays on offer for another account, and is no key for OpenAI', () => {
  assert.deepEqual(signInOffer(model.toPublic(model.readSettings(undefined)).providers), { signedIn: 0 }, 'none yet')

  const account = (id: string) => ({ id, name: 'ChatGPT', kind: 'openai-responses', baseURL: 'https://api.openai.com/v1', model: '', auth: 'chatgpt', encryptedLogin: 'bG9naW4=', signedIn: true })
  const one = model.readSettings({ providers: [account('chatgpt')] })
  assert.deepEqual(signInOffer(model.toPublic(one).providers), { signedIn: 0 }, 'signed out: nobody is signed in, and the entry adds an account all the same')
  const signedIn = model.toPublic(one, { chatgpt: { signedIn: true, planUsage: true } }).providers
  assert.deepEqual(signInOffer(signedIn), { signedIn: 1 })
  // The sign-in talks to OpenAI's address here, and OpenAI with a key is still not there.
  assert.equal(told(presetOffers(signedIn)).openai, 'OpenAI')

  // Several accounts, each a provider of its own: the entry counts those that are signed in.
  const two = model.readSettings({ providers: [account('chatgpt'), account('chatgpt-2'), account('chatgpt-3')] })
  const accounts = { chatgpt: { signedIn: true, planUsage: true, email: 'one@example.com' }, 'chatgpt-2': { signedIn: true, planUsage: false, email: 'two@example.com' }, 'chatgpt-3': { signedIn: false, planUsage: false } }
  assert.deepEqual(signInOffer(model.toPublic(two, accounts).providers), { signedIn: 2 })
})

test('sign-ins that come with the same name are told apart by their account, where there is more than one', () => {
  const account = (id: string) => ({ id, name: 'ChatGPT', kind: 'openai-responses', baseURL: 'https://api.openai.com/v1', model: '', auth: 'chatgpt', encryptedLogin: 'bG9naW4=', signedIn: true })
  const key = { id: 'deepseek', name: 'DeepSeek', kind: 'openai-chat', baseURL: 'https://api.deepseek.com', model: '' }

  // One sign-in needs no telling apart, with or without an address known for it.
  const alone = model.toPublic(model.readSettings({ providers: [key, account('chatgpt')] }), { chatgpt: { signedIn: true, planUsage: true, email: 'one@example.com' } }).providers
  assert.deepEqual(alone.map((p) => providerLabel(p, alone)), ['DeepSeek', 'ChatGPT'])

  const several = model.toPublic(model.readSettings({ providers: [key, account('chatgpt'), account('chatgpt-2'), account('chatgpt-3')] }), {
    chatgpt: { signedIn: true, planUsage: true, email: 'one@example.com' },
    'chatgpt-2': { signedIn: true, planUsage: true },
    'chatgpt-3': { signedIn: false, planUsage: false }
  }).providers
  assert.deepEqual(
    several.map((p) => providerLabel(p, several)),
    ['DeepSeek', 'ChatGPT（one@example.com）', 'ChatGPT（已登录）', 'ChatGPT（未登录）']
  )
})
