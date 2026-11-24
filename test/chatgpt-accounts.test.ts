// Several ChatGPT accounts signed in at once. An account here is a registration with OpenAI: one
// person and one of their workspaces, so the personal plan and a Team workspace of one address
// are two (src/main/chatgpt/accounts.ts). And a code the service does not take is asked for once
// more, as OpenAI's documentation says to (src/main/chatgpt/login.ts).

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { placeForSignIn } from '../src/main/chatgpt/accounts.ts'
import type { HeldAccount } from '../src/main/chatgpt/accounts.ts'
import { SignInError, startAttempt } from '../src/main/chatgpt/login.ts'
import type { AttemptOptions } from '../src/main/chatgpt/login.ts'
import { newHostId, refreshed } from '../src/main/chatgpt/oauth.ts'
import type { LoginRecord } from '../src/main/chatgpt/oauth.ts'
import * as model from '../src/main/settings-model.ts'
import { startFakeChatGpt } from './fake-chatgpt.ts'
import type { FakeChatGpt } from './fake-chatgpt.ts'

const hostId = newHostId()

async function service(): Promise<FakeChatGpt> {
  const fake = await startFakeChatGpt()
  // Closed when the run ends, whether the tests passed or not: an open server keeps the process alive.
  after(() => fake.close())
  return fake
}

/** A sign-in attempt whose browser is the test itself, on any free port. */
const attemptAt = (fake: FakeChatGpt, extra: Partial<AttemptOptions> = {}) => startAttempt({ service: fake.service, hostId, port: 0, openBrowser: () => {}, ...extra })

async function signIn(fake: FakeChatGpt, extra: Partial<AttemptOptions> = {}): Promise<LoginRecord> {
  const attempt = await attemptAt(fake, extra)
  await fake.browse(attempt.url)
  return attempt.result
}

const held: HeldAccount[] = [
  { providerId: 'chatgpt', clientId: 'oaiapp_personal' },
  { providerId: 'chatgpt-2', clientId: 'oaiapp_team' }
]

test('a registration nobody holds yet is kept where the sign-in was started: a provider of its own, or the one asked for', () => {
  assert.deepEqual(placeForSignIn([], undefined, 'oaiapp_personal'), { moved: false }, 'the first one: a provider is added for it')
  assert.deepEqual(placeForSignIn(held, undefined, 'oaiapp_other'), { moved: false }, 'another one beside those that are there')
  assert.deepEqual(placeForSignIn(held, 'chatgpt-2', 'oaiapp_other'), { providerId: 'chatgpt-2', moved: false }, 'another one in the place of one that was signed out of')
  // Signing in again to the registration a provider holds stays with that provider.
  assert.deepEqual(placeForSignIn(held, 'chatgpt', 'oaiapp_personal'), { providerId: 'chatgpt', moved: false })
})

test('a registration that another provider holds goes to that provider, and is not listed a second time', () => {
  assert.deepEqual(placeForSignIn(held, undefined, 'oaiapp_team'), { providerId: 'chatgpt-2', moved: true })
  assert.deepEqual(placeForSignIn(held, 'chatgpt', 'oaiapp_team'), { providerId: 'chatgpt-2', moved: true }, 'also when it signed in where another one used to be')
})

test('two workspaces of one person are two registrations, with the same subject and the same address', async () => {
  const fake = await service()
  fake.knobs.account = { sub: 'user-1', email: 'person@example.com', workspace: 'personal' }
  const personal = await signIn(fake)
  fake.knobs.account = { sub: 'user-1', email: 'person@example.com', workspace: 'team' }
  const team = await signIn(fake)
  assert.deepEqual([team.subject, team.email], [personal.subject, personal.email])
  assert.notEqual(team.clientId, personal.clientId)

  // Neither the person nor the address tells them apart: the registration does, and each gets a provider of its own.
  const one: HeldAccount[] = [{ providerId: 'chatgpt', clientId: personal.clientId }]
  assert.deepEqual(placeForSignIn(one, undefined, team.clientId), { moved: false })

  // Registered once more, a workspace has the registration it had, which goes to the provider that holds it.
  const again = await signIn(fake)
  assert.equal(again.clientId, team.clientId)
  assert.deepEqual(placeForSignIn([...one, { providerId: 'chatgpt-2', clientId: team.clientId }], undefined, again.clientId), { providerId: 'chatgpt-2', moved: true })

  // Each renews its own tokens, whichever of them signed in last.
  const renewed = await refreshed(fake.service, personal)
  assert.equal(renewed.clientId, personal.clientId)
  assert.notEqual(renewed.tokens?.access, personal.tokens?.access)
})

test('each sign-in is added under a name of its own, since two of them may share everything else that shows', () => {
  const login = (encrypted: string) => ({ encrypted, ready: true, baseURL: 'https://api.openai.com/v1' })
  const first = model.saveLogin(model.readSettings(undefined), undefined, login('YQ=='))
  const second = model.saveLogin(first.settings, undefined, login('Yg=='))
  const third = model.saveLogin(second.settings, undefined, login('Yw=='))
  assert.deepEqual(
    third.settings.providers.filter((p) => p.auth === 'chatgpt').map((p) => [p.id, p.name]),
    [
      ['chatgpt', 'ChatGPT'],
      ['chatgpt-2', 'ChatGPT 2'],
      ['chatgpt-3', 'ChatGPT 3']
    ]
  )
  // Signing in again to one of them changes neither its name nor its place.
  const back = model.saveLogin(third.settings, 'chatgpt-2', login('ZA=='))
  assert.equal(back.providerId, 'chatgpt-2')
  assert.equal(back.settings.providers.find((p) => p.id === 'chatgpt-2')?.name, 'ChatGPT 2')
})

test('a code the service does not take is asked for once more, for the registration the attempt was given, and never a third time', async () => {
  const fake = await service()
  fake.knobs.codeExchange = 'refuse-first'
  const attempt = await attemptAt(fake)
  // The browser comes back, is sent on to the sign-in page once more in the same tab, and comes back again.
  const page = await fake.browse(attempt.url)
  assert.match(page.body, /登录完成/)
  const record = await attempt.result
  assert.match(record.clientId, /^oaiapp_/)
  assert.ok(record.tokens?.access && record.tokens.refresh)

  const [first, second] = fake.asked('/api/accounts/authorize').map((seen) => seen.body)
  assert.equal(first.client_id, 'dynamic_agent_client')
  // The second round is for the registration the first was given. No new one is made, and the
  // app's name is left out, as for any sign-in to a registration that exists.
  assert.equal(second.client_id, record.clientId)
  assert.equal(second.agent_name_hint, undefined)
  assert.equal(second.ext_agent_host_id, hostId)
  assert.equal(second.redirect_uri, first.redirect_uri)
  // What is fresh for a round is made anew.
  for (const name of ['state', 'nonce', 'code_challenge']) assert.notEqual(second[name], first[name], name)

  const exchanges = fake.asked('/api/accounts/oauth/token').map((seen) => seen.body)
  assert.deepEqual(
    exchanges.map((e) => [e.grant_type, e.client_id]),
    [
      ['authorization_code', record.clientId],
      ['authorization_code', record.clientId]
    ]
  )
  assert.notEqual(exchanges[0].code, exchanges[1].code)
  assert.notEqual(exchanges[0].code_verifier, exchanges[1].code_verifier)

  // A service that takes no code at all: the second refusal ends the attempt, with what the service said.
  fake.knobs.codeExchange = 'refuse'
  const hopeless = await attemptAt(fake)
  const failed = await fake.browse(hopeless.url)
  assert.match(failed.body, /登录没有完成/)
  const err = await hopeless.result.then(
    () => null,
    (raised: unknown) => raised
  )
  assert.ok(err instanceof SignInError)
  assert.equal(err.reason, 'failed')
  assert.match(err.message, /^invalid_grant/)
  assert.equal(fake.asked('/api/accounts/oauth/token').length, 4, 'two rounds, and no third')
})

test('signing in again to a known registration is asked for once more in the same way, and keeps to that registration and its account', async () => {
  const fake = await service()
  const known = await signIn(fake)
  fake.knobs.codeExchange = 'refuse-first'
  const back = await signIn(fake, { known })
  assert.equal(back.clientId, known.clientId)
  assert.equal(back.subject, known.subject)

  const rounds = fake.asked('/api/accounts/authorize').map((seen) => seen.body)
  assert.equal(rounds.length, 3, 'the first sign-in, then two rounds')
  assert.deepEqual([rounds[1].client_id, rounds[2].client_id], [known.clientId, known.clientId])
  // The hints that say which account to offer go with both rounds.
  assert.equal(rounds[2].login_hint, 'person@example.com')
  assert.equal(rounds[2].login_hint, rounds[1].login_hint)

  // Another account answering the second round is turned away like on the first.
  const other = await service()
  const mine = await signIn(other)
  other.knobs.codeExchange = 'refuse-first'
  other.knobs.account = { sub: 'user-2', email: 'other@example.com' }
  const wrong = await attemptAt(other, { known: mine })
  await other.browse(wrong.url)
  const refused = await wrong.result.then(
    () => null,
    (raised: unknown) => raised
  )
  assert.ok(refused instanceof SignInError)
  assert.match(refused.message, /different account/)
})
