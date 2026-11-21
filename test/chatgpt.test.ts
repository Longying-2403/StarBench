// Signing in with ChatGPT and using the plan for requests, against a stand-in for OpenAI's services.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { runTurn } from '../src/main/agent.ts'
import { SignInError, startAttempt } from '../src/main/chatgpt/login.ts'
import type { AttemptOptions } from '../src/main/chatgpt/login.ts'
import { canUsePlan, clientIsGone, newHostId, readRecord, refreshed, renewalDue, revoke, tokensAreDead } from '../src/main/chatgpt/oauth.ts'
import type { LoginRecord } from '../src/main/chatgpt/oauth.ts'
import { adapterFor } from '../src/main/providers/index.ts'
import type { Connection } from '../src/main/providers/index.ts'
import { responsesInput, responsesTools } from '../src/main/providers/responses.ts'
import { ServiceError } from '../src/main/providers/types.ts'
import * as model from '../src/main/settings-model.ts'
import { ToolRegistry, registerBuiltinTools } from '../src/main/tools.ts'
import type { AgentEvent, ChatMessage } from '../src/shared/types.ts'
import { startFakeChatGpt } from './fake-chatgpt.ts'
import type { FakeChatGpt } from './fake-chatgpt.ts'

const hostId = newHostId()

async function service(): Promise<FakeChatGpt> {
  const fake = await startFakeChatGpt()
  // Closed when the run ends, whether the tests passed or not: an open server keeps the process alive.
  after(() => fake.close())
  return fake
}

/** A sign-in attempt whose browser is the test itself. Any free port: the usual one may be taken on this computer. */
const attemptAt = (fake: FakeChatGpt, extra: Partial<AttemptOptions> = {}) =>
  startAttempt({ service: fake.service, hostId, port: 0, openBrowser: () => {}, ...extra })

async function signIn(fake: FakeChatGpt, extra: Partial<AttemptOptions> = {}): Promise<LoginRecord> {
  const attempt = await attemptAt(fake, extra)
  await fake.browse(attempt.url)
  return attempt.result
}

const failure = (err: unknown): SignInError => {
  assert.ok(err instanceof SignInError, `expected a SignInError, got ${String(err)}`)
  return err
}

test('a first sign-in registers the app and comes back with a record that can be used', async () => {
  const fake = await service()
  let opened = ''
  const attempt = await attemptAt(fake, { openBrowser: (url) => void (opened = url) })
  assert.equal(opened, attempt.url, 'the browser is opened once the listener is ready')
  const page = await fake.browse(attempt.url)
  assert.equal(page.status, 200)
  assert.match(page.body, /登录完成/)
  const record = await attempt.result

  const asked = fake.asked('/api/accounts/authorize')[0].body
  assert.equal(asked.client_id, 'dynamic_agent_client')
  assert.equal(asked.agent_name_hint, 'StarBench')
  assert.equal(asked.ext_agent_host_id, hostId)
  assert.match(hostId, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(asked.response_type, 'code')
  assert.equal(asked.scope, 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct')
  assert.equal(asked.resource, `${fake.origin}/v1`)
  assert.equal(asked.code_challenge_method, 'S256')
  // The address is spelled with the number; only the port may differ from one sign-in to the next.
  assert.match(asked.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
  assert.ok(asked.state.length >= 24 && asked.nonce.length >= 24 && asked.state !== asked.nonce)
  assert.equal(asked.code_challenge.length, 43)
  assert.deepEqual([asked.id_token_hint, asked.login_hint, asked.prompt], [undefined, undefined, undefined])

  // The code is exchanged with the id the registration was given, and without any secret.
  const exchange = fake.asked('/api/accounts/oauth/token')[0].body
  assert.deepEqual(Object.keys(exchange).sort(), ['client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri', 'resource'])
  assert.deepEqual([exchange.grant_type, exchange.client_id, exchange.redirect_uri], ['authorization_code', record.clientId, asked.redirect_uri])

  assert.match(record.clientId, /^oaiapp_/)
  assert.deepEqual(
    [record.issuer, record.resource, record.subject, record.email],
    [fake.origin, `${fake.origin}/v1`, 'user-1', 'person@example.com']
  )
  assert.ok(record.idToken && record.tokens?.access && record.tokens.refresh)
  assert.ok(Math.abs((record.tokens?.expiresAt ?? 0) - (Date.now() + 3600_000)) < 10_000)
  assert.ok(record.scopes.includes('chatgpt.tokens.use.direct'))
  assert.equal(canUsePlan(record), true)
  // What is stored reads back as it was.
  assert.deepEqual(readRecord(JSON.parse(JSON.stringify(record))), record)
  assert.equal(readRecord({ ...record, clientId: '' }), null)

  // The port asked for is taken, say by another program that is signing in: any other does, and nothing else of the address changes.
  const squatter = http.createServer()
  await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve))
  const taken = (squatter.address() as AddressInfo).port
  const moved = await attemptAt(fake, { port: taken })
  const movedTo = new URL(new URL(moved.url).searchParams.get('redirect_uri') ?? '')
  assert.notEqual(Number(movedTo.port), taken)
  assert.deepEqual([movedTo.protocol, movedTo.hostname, movedTo.pathname], ['http:', '127.0.0.1', '/auth/callback'])
  await fake.browse(moved.url)
  assert.equal((await moved.result).subject, 'user-1')
  await new Promise((resolve) => squatter.close(resolve))

  // An account that signs in without allowing its plan to be used is signed in, and no more.
  fake.knobs.grant = 'openid profile email'
  const identityOnly = await signIn(fake)
  assert.equal(canUsePlan(identityOnly), false)
  assert.ok(identityOnly.tokens)
})

test('signing in again continues the registration, and only for the account it belongs to', async () => {
  const fake = await service()
  const first = await signIn(fake)

  const record = await signIn(fake, { known: first })
  const asked = fake.asked('/api/accounts/authorize')[1].body
  assert.equal(asked.client_id, first.clientId, 'the id the registration was given, not the one to register with')
  assert.equal(asked.agent_name_hint, undefined)
  assert.equal(asked.ext_agent_host_id, hostId)
  assert.deepEqual([asked.id_token_hint, asked.login_hint], [first.idToken, 'person@example.com'])
  assert.equal(record.clientId, first.clientId)
  assert.notEqual(record.tokens?.access, first.tokens?.access)

  // After signing out there is no ID token to send along; the address still says which account is meant.
  const { idToken: _dropped, ...signedOut } = first
  const consent = await attemptAt(fake, { known: signedOut, consent: true })
  const again = fake.asked('/api/accounts/authorize')[2]
  assert.equal(again, undefined, 'nothing is asked until the browser opens the page')
  const params = new URL(consent.url).searchParams
  assert.deepEqual([params.get('id_token_hint'), params.get('login_hint'), params.get('prompt')], [null, 'person@example.com', 'consent'])
  consent.cancel()
  assert.equal(failure(await consent.result.catch((e) => e)).reason, 'cancelled')

  // An ID token that would make the address too long for a browser to be handed is left out; the rest stays.
  const long = await attemptAt(fake, { known: { ...first, idToken: 'x'.repeat(3000) } })
  const shortened = new URL(long.url).searchParams
  assert.ok(long.url.length < 2000)
  assert.deepEqual([shortened.get('id_token_hint'), shortened.get('login_hint'), shortened.get('client_id')], [null, 'person@example.com', first.clientId])
  long.cancel()

  // Somebody else signs in on the page: their account must not end up in this registration.
  fake.knobs.account = { sub: 'user-2', email: 'other@example.com' }
  const other = await attemptAt(fake, { known: first })
  const page = await fake.browse(other.url)
  assert.match(page.body, /登录没有完成/)
  const refused = failure(await other.result.catch((e) => e))
  assert.equal(refused.reason, 'failed')
  assert.match(refused.message, /different account/)
})

test('a sign-in that was refused, forged, replayed or abandoned produces nothing', async () => {
  const fake = await service()

  fake.knobs.deny = true
  const denied = await attemptAt(fake)
  assert.match((await fake.browse(denied.url)).body, /没有授权/)
  assert.equal(failure(await denied.result.catch((e) => e)).reason, 'denied')
  assert.equal(fake.asked('/api/accounts/oauth/token').length, 0, 'nothing was exchanged')
  fake.knobs.deny = false

  const attempt = await attemptAt(fake)
  const listener = new URL(new URL(attempt.url).searchParams.get('redirect_uri') ?? '')
  // Anything on this computer can reach the listener, but only the browser that was sent out knows the state.
  const forged = await fetch(`${listener}?code=stolen&state=guessed&client_id=oaiapp_evil`)
  assert.match(await forged.text(), /不是当前的登录请求/)
  assert.equal((await fetch(`${listener.origin}/callback?state=x`)).status, 404, 'only the one path answers')
  assert.equal((await fetch(`${listener}`, { method: 'POST' })).status, 404)
  // Reached under another name, as a page on the web would have to: not served.
  const renamed = await new Promise<number>((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: listener.port, path: `${listener.pathname}?state=x`, headers: { host: 'attacker.example' } }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      .on('error', reject)
  })
  assert.equal(renamed, 404)
  assert.equal(fake.asked('/api/accounts/oauth/token').length, 0)

  // None of that used the attempt up: the real answer still completes it. Once.
  const sentBack = (await fetch(attempt.url, { redirect: 'manual' })).headers.get('location') ?? ''
  assert.match(await (await fetch(sentBack)).text(), /登录完成/)
  const record = await attempt.result
  assert.equal(record.subject, 'user-1')
  const replay = await fetch(sentBack).then((r) => r.text(), () => 'closed')
  assert.match(replay, /已经用过了|closed/)
  assert.equal(fake.asked('/api/accounts/oauth/token').length, 1)

  const slow = await attemptAt(fake, { timeoutMs: 20 })
  assert.equal(failure(await slow.result.catch((e) => e)).reason, 'timeout')

  // A sign-in service that cannot be reached fails the start, and leaves no listener behind.
  const closed = http.createServer()
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
  const gone = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`
  await new Promise((resolve) => closed.close(resolve))
  await assert.rejects(startAttempt({ service: { issuer: gone, resource: `${gone}/v1` }, hostId, port: 0, openBrowser: () => {} }))
})

test('an ID token that is not what it should be ends the sign-in', async () => {
  const fake = await service()
  for (const tamper of ['nonce', 'audience', 'signature'] as const) {
    fake.knobs.tamper = tamper
    const attempt = await attemptAt(fake)
    const page = await fake.browse(attempt.url)
    assert.match(page.body, /登录没有完成/, tamper)
    assert.equal(failure(await attempt.result.catch((e) => e)).reason, 'failed', tamper)
  }
  fake.knobs.tamper = null
  assert.equal((await signIn(fake)).subject, 'user-1')
})

test('tokens are renewed in time, a refresh token is used once, and dead ones are told apart', async () => {
  const fake = await service()
  const record = await signIn(fake)

  const next = await refreshed(fake.service, record)
  assert.notEqual(next.tokens?.access, record.tokens?.access)
  assert.notEqual(next.tokens?.refresh, record.tokens?.refresh)
  assert.deepEqual([next.scopes, next.idToken, next.clientId, next.subject], [record.scopes, record.idToken, record.clientId, record.subject])
  assert.deepEqual(fake.asked('/api/accounts/oauth/token').at(-1)?.body, {
    grant_type: 'refresh_token',
    client_id: record.clientId,
    refresh_token: record.tokens?.refresh,
    resource: `${fake.origin}/v1`
  })

  // The token that was just traded in is worth nothing now, and the service says so in its own shape of error.
  const reused = await refreshed(fake.service, record).catch((e) => e)
  assert.equal(tokensAreDead(reused), true)
  assert.equal(reused.code, 'refresh_token_reused')
  // The person disconnected the app in ChatGPT.
  fake.disconnect()
  assert.equal(tokensAreDead(await refreshed(fake.service, next).catch((e) => e)), true)
  // The registration itself is unknown.
  const unknown = await refreshed(fake.service, { ...next, clientId: 'oaiapp_never_registered' }).catch((e) => e)
  assert.deepEqual([clientIsGone(unknown), tokensAreDead(unknown)], [true, false])
  // A service that cannot be reached says nothing about the tokens: they are kept.
  const closed = http.createServer()
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
  const gone = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`
  await new Promise((resolve) => closed.close(resolve))
  const offline = await refreshed({ issuer: gone, resource: `${gone}/v1` }, next).catch((e) => e)
  assert.ok(offline instanceof Error)
  assert.deepEqual([clientIsGone(offline), tokensAreDead(offline)], [false, false])

  const minute = 60_000
  const tokens = { access: 'now', refresh: 'r', expiresAt: 100 * minute }
  assert.equal(renewalDue(tokens, 94 * minute), false)
  assert.equal(renewalDue(tokens, 96 * minute), true, 'five minutes ahead')
  assert.equal(renewalDue(tokens, 0, 'now'), true, 'the API turned this very token down')
  assert.equal(renewalDue(tokens, 0, 'an-older-one'), false, 'somebody renewed in the meantime')
  // The service asked not to be asked before a certain time; that holds while the token still works.
  assert.equal(renewalDue({ ...tokens, refreshFrom: 99 * minute }, 97 * minute), false)
  assert.equal(renewalDue({ ...tokens, refreshFrom: 99 * minute }, 99 * minute), true)
  assert.equal(renewalDue({ ...tokens, refreshFrom: 200 * minute }, 101 * minute), true, 'run out: asked anyway')
})

test('signing out tells the service, and reports when it could not be told', async () => {
  const fake = await service()
  const record = await signIn(fake)
  assert.equal(await revoke(fake.service, record, [1, 1]), true)
  assert.deepEqual(fake.asked('/api/accounts/oauth/revoke')[0].body, {
    token: record.tokens?.refresh,
    token_type_hint: 'refresh_token',
    client_id: record.clientId
  })
  assert.equal(tokensAreDead(await refreshed(fake.service, record).catch((e) => e)), true, 'the token is really gone')

  const other = await signIn(fake)
  fake.knobs.revokeStatus = 503
  assert.equal(await revoke(fake.service, other, [1, 1]), false)
  assert.equal(fake.asked('/api/accounts/oauth/revoke').length, 1 + 3, 'a service in trouble is tried again, a few times')
  fake.knobs.revokeStatus = 400
  assert.equal(await revoke(fake.service, other, [1, 1]), false)
  assert.equal(fake.asked('/api/accounts/oauth/revoke').length, 1 + 3 + 1, 'a refusal is not')
  // Nothing to revoke after signing out.
  const { tokens: _none, ...signedOut } = other
  assert.equal(await revoke(fake.service, signedOut), true)
  assert.equal(fake.asked('/api/accounts/oauth/revoke').length, 5)
})

/** Runs one turn with the built-in tools in a folder that holds note.txt, and reports what happened. */
async function turn(conn: Connection, messages: ChatMessage[], onFastRefused?: () => void) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'starbench-chatgpt-'))
  await writeFile(path.join(workspace, 'note.txt'), 'the magic word is plover')
  const tools = new ToolRegistry()
  registerBuiltinTools(tools)
  const events: AgentEvent[] = []
  await runTurn({
    connection: conn,
    workspace,
    messages,
    signal: new AbortController().signal,
    tools,
    alwaysAllowed: new Set(),
    emit: (e) => events.push(e),
    checkpoint: () => {},
    requestPermission: async () => 'allow',
    ...(onFastRefused ? { onFastRefused } : {})
  })
  const errors = events.filter((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error')
  const text = events.map((e) => (e.type === 'text_delta' ? e.text : '')).join('')
  return { events, errors, text }
}

test('requests on a ChatGPT plan carry the token of the moment, the tools in a group, and stop on plan errors', async () => {
  const fake = await service()
  let record = await signIn(fake)
  /** What the token was asked with, in order. */
  const asked: (string | undefined)[] = []
  const conn: Connection = {
    provider: 'chatgpt',
    kind: 'openai-responses',
    apiKey: 'the-token-from-when-the-turn-started',
    baseURL: fake.service.resource,
    model: 'gpt-plan-a',
    reasoningEffort: 'high',
    plan: {
      token: async (rejected) => {
        asked.push(rejected)
        if (rejected) record = await refreshed(fake.service, record)
        return record.tokens?.access ?? ''
      }
    }
  }
  const posts = () => fake.asked('/v1/responses')

  const messages: ChatMessage[] = [{ role: 'user', content: 'What is in note.txt?' }]
  const first = await turn(conn, messages)
  assert.deepEqual(first.errors, [])
  assert.equal(first.text, 'The file says: the magic word is plover')
  assert.equal(posts().length, 2)
  assert.deepEqual(asked, [undefined, undefined], 'a token is asked for before every request')
  assert.equal(posts()[0].headers.authorization, `Bearer ${record.tokens?.access}`)

  const body = posts()[0].body
  assert.deepEqual([body.model, body.store, body.stream], ['gpt-plan-a', false, true])
  assert.match(body.instructions, /coding agent/)
  assert.ok(Array.isArray(body.input) && !body.input.some((item: { role?: string }) => item.role === 'system'))
  assert.deepEqual(body.reasoning, { summary: 'auto', effort: 'high' })
  // The function tools arrive grouped under one name.
  assert.equal(body.tools.length, 1)
  assert.deepEqual([body.tools[0].type, body.tools[0].name, typeof body.tools[0].description], ['namespace', 'starbench', 'string'])
  const readFile = body.tools[0].tools.find((t: { name: string }) => t.name === 'read_file')
  assert.deepEqual([readFile.type, readFile.strict, readFile.parameters.required], ['function', false, ['path']])
  // Nothing of what plan usage does not take.
  const refusedFields = [
    'background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent', 'prompt',
    'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id'
  ]
  for (const field of refusedFields) assert.equal(field in body, false, field)

  // The model's call comes back naming the group, runs, and returns to the service as it came.
  const stored = messages[1]
  assert.ok(stored.role === 'assistant')
  assert.deepEqual(stored.tool_calls?.map((c) => [c.name, c.arguments]), [['read_file', '{"path":"note.txt"}']])
  const replayed = posts()[1].body.input
  assert.deepEqual(replayed.map((item: { type?: string; role?: string }) => item.type ?? item.role), ['user', 'reasoning', 'function_call', 'function_call_output'])
  assert.equal(replayed[2].namespace, 'starbench')

  // A call another model made is told with the group as well; without a plan there is no group.
  const foreign: ChatMessage[] = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'list_dir', arguments: '{}' }], origin: { provider: 'deepseek', kind: 'openai-chat', model: 'm' } },
    { role: 'tool', tool_call_id: 'c1', content: 'a.txt' }
  ]
  assert.deepEqual(responsesInput({ messages: foreign, connection: conn })[1], { type: 'function_call', call_id: 'c1', name: 'list_dir', arguments: '{}', namespace: 'starbench' })
  const { plan: _plan, ...withKey } = conn
  assert.equal('namespace' in responsesInput({ messages: foreign, connection: withKey })[1], false)
  assert.deepEqual(responsesTools({ tools: [], connection: conn }), [])

  // The model list of a signed-in account has its own shape; only the entries meant for listing are offered.
  const signedIn = { ...conn, apiKey: record.tokens?.access ?? '' }
  assert.deepEqual(await adapterFor('openai-responses').listModels(signedIn), [
    { id: 'gpt-plan-a', name: 'GPT Plan A' },
    { id: 'gpt-plan-b', name: 'GPT Plan B' }
  ])
  assert.deepEqual(await adapterFor('openai-responses').modelInfo(signedIn), { name: 'GPT Plan A' })

  // The API turns the token down once: one newer token is fetched and the request made again.
  fake.knobs.responses = 'reject-token-once'
  const before = record.tokens?.access
  let count = posts().length
  const renewed = await turn(conn, [{ role: 'user', content: 'hello' }])
  assert.deepEqual(renewed.errors, [])
  assert.equal(renewed.text, 'Hello from gpt-plan-a on the plan.')
  assert.deepEqual(asked.slice(-2), [undefined, before])
  assert.notEqual(record.tokens?.access, before)
  assert.equal(posts().length, count + 2)
  assert.equal(posts().at(-1)?.headers.authorization, `Bearer ${record.tokens?.access}`)

  // The plan's limit is reached: the turn stops, says so with a way to the usage page, and nothing is tried again.
  for (const how of ['usage-limit', 'usage-limit-http'] as const) {
    fake.knobs.responses = how
    count = posts().length
    const limited = await turn(conn, [{ role: 'user', content: 'hello' }])
    assert.equal(limited.errors.length, 1, how)
    assert.equal(limited.errors[0].hint, 'chatgpt-usage', how)
    assert.match(limited.errors[0].message, /usage limit.*subscription_sharing_usage_limit_exceeded/i, how)
    assert.equal(posts().length, count + 1, `${how}: asked once`)
  }
  assert.match((await turn(conn, [{ role: 'user', content: 'hello' }])).errors[0].message, /HTTP 429/)

  // Faster answers are asked for with one request field, and only when the person switched them on.
  fake.knobs.responses = 'ok'
  assert.equal('service_tier' in posts().at(-1)?.body, false)
  const hurried = await turn({ ...conn, fast: true }, [{ role: 'user', content: 'hello' }])
  assert.deepEqual(hurried.errors, [])
  // Under the one name this route knows them by: "fast", which the API also takes, is refused here.
  assert.equal(posts().at(-1)?.body.service_tier, 'priority')
  assert.deepEqual(hurried.events.filter((e) => e.type === 'notice'), [])

  // A model that has no faster answers refuses the request. It goes out again without asking, the
  // person is told, the choice is taken back, and the rest of the turn does not ask again.
  fake.knobs.responses = 'no-fast'
  count = posts().length
  let takenBack = 0
  const unhurried = await turn({ ...conn, fast: true }, [{ role: 'user', content: 'What is in note.txt?' }], () => takenBack++)
  assert.deepEqual(unhurried.errors, [])
  assert.equal(unhurried.text, 'The file says: the magic word is plover')
  assert.deepEqual(posts().slice(count).map((p) => p.body.service_tier), ['priority', undefined, undefined])
  assert.deepEqual(unhurried.events.flatMap((e) => (e.type === 'notice' ? [e.code] : [])), ['fast-mode-refused'])
  assert.equal(takenBack, 1)

  // A reply the service never declared complete is a lost connection, not an answer.
  fake.knobs.responses = 'cut-off'
  const cut: ChatMessage[] = [{ role: 'user', content: 'hello' }]
  const lost = await turn(conn, cut)
  assert.match(lost.errors[0].message, /ended before the reply was complete/)
  assert.equal(cut.length, 1)

  // The sign-in turns out to be over: the turn ends with the way to sign in again.
  fake.knobs.responses = 'ok'
  const over: Connection = {
    ...conn,
    plan: { token: () => Promise.reject(new ServiceError('The ChatGPT sign-in is no longer valid. Sign in again in Settings.', 'chatgpt-sign-in')) }
  }
  count = posts().length
  const signedOut = await turn(over, [{ role: 'user', content: 'hello' }])
  assert.deepEqual(signedOut.errors.map((e) => e.hint), ['chatgpt-sign-in'])
  assert.equal(posts().length, count, 'nothing was sent')

  // A token that is turned down although no newer one exists: the refusal is shown, once.
  const stuck: Connection = { ...conn, plan: { token: async () => 'never-valid' } }
  count = posts().length
  const refused = await turn(stuck, [{ role: 'user', content: 'hello' }])
  assert.match(refused.errors[0].message, /did not accept the sign-in.*HTTP 401/)
  assert.equal(posts().length, count + 1)
})

test('a ChatGPT sign-in is a provider of its own in the settings', () => {
  const api = 'https://api.openai.com/v1'
  let settings = model.readSettings(null)
  const added = model.saveLogin(settings, undefined, { encrypted: 'BLOB1', ready: true, baseURL: api })
  settings = added.settings
  assert.equal(added.providerId, 'chatgpt')
  assert.deepEqual(settings.providers[1], {
    id: 'chatgpt',
    name: 'ChatGPT',
    kind: 'openai-responses',
    baseURL: api,
    model: '',
    auth: 'chatgpt',
    encryptedLogin: 'BLOB1',
    signedIn: true
  })
  assert.equal(settings.activeProviderId, 'chatgpt', 'like a first key, a first sign-in is put to use')

  // The page sees the account, never the sign-in itself.
  const account = { signedIn: true, planUsage: true, email: 'person@example.com' }
  const shown = model.toPublic(settings, { chatgpt: account })
  assert.deepEqual(shown.providers[1], { id: 'chatgpt', name: 'ChatGPT', kind: 'openai-responses', baseURL: api, model: '', hasApiKey: true, auth: 'chatgpt', account })
  assert.equal(shown.hasApiKey, true)
  assert.equal(JSON.stringify(shown).includes('BLOB1'), false)
  // An account that did not allow its plan to be used cannot be used for requests; nor can one nothing is known about.
  assert.equal(model.toPublic(settings, { chatgpt: { ...account, planUsage: false } }).hasApiKey, false)
  assert.deepEqual(model.toPublic(settings).providers[1].account, { signedIn: false, planUsage: false })

  // The file is read back as it was written, with what belongs to the installation.
  const file = { ...settings, hostId: 'urn:uuid:0b0e4a2c-6f0e-4c58-9d55-3f1b6f7f2a11', chatgptWelcomed: true }
  assert.deepEqual(model.readSettings(JSON.parse(JSON.stringify(file))), file)
  assert.equal(model.readSettings({ ...file, hostId: 'person@example.com' }).hostId, undefined, 'only an id of the right form is kept')
  // A hand-edited entry cannot make a sign-in speak another format or carry a key.
  const edited = model.readSettings({ providers: [{ ...settings.providers[1], kind: 'anthropic', encryptedKey: 'KEY' }] })
  assert.deepEqual([edited.providers[0].kind, edited.providers[0].encryptedKey], ['openai-responses', undefined])

  // Its name and model can be changed; where it talks to and how it pays cannot.
  settings = model.saveProvider(settings, { id: 'chatgpt', name: 'My plan', kind: 'anthropic', baseURL: 'https://elsewhere.example', model: 'gpt-plan-a' }, 'KEY')
  const changed = settings.providers[1]
  assert.deepEqual([changed.name, changed.kind, changed.baseURL, changed.model, changed.encryptedKey], ['My plan', 'openai-responses', api, 'gpt-plan-a', undefined])
  assert.equal(model.setModel(settings, 'deepseek', 'deepseek-v4-pro').activeProviderId, 'chatgpt', 'naming a model does not switch providers')

  // Signing out keeps the registration (the sign-in is stored without tokens) but the provider cannot be used.
  settings = model.saveLogin(settings, 'chatgpt', { encrypted: 'BLOB2', ready: false, baseURL: api }).settings
  assert.deepEqual([settings.providers[1].encryptedLogin, settings.providers[1].signedIn, settings.providers[1].model], ['BLOB2', undefined, 'gpt-plan-a'])
  // Signing in again, with a key around elsewhere, does not take over.
  settings = model.saveProvider(settings, { id: 'deepseek', name: 'DeepSeek', kind: 'openai-chat', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash' }, 'KEY')
  settings = model.selectModel(settings, 'deepseek', 'deepseek-flash')
  settings = model.saveLogin(settings, 'chatgpt', { encrypted: 'BLOB3', ready: true, baseURL: api }).settings
  assert.equal(settings.activeProviderId, 'deepseek')
  // A second account gets a provider of its own.
  assert.equal(model.saveLogin(settings, undefined, { encrypted: 'BLOB4', ready: true, baseURL: api }).providerId, 'chatgpt-2')
  assert.throws(() => model.saveLogin(settings, 'deepseek', { encrypted: 'X', ready: true, baseURL: api }), /no longer exists/)
  assert.throws(() => model.saveLogin(settings, 'ghost', { encrypted: 'X', ready: true, baseURL: api }), /no longer exists/)

  // Forgetting the sign-in altogether leaves the provider, signed out.
  const forgotten = model.dropLogin(settings, 'chatgpt').providers[1]
  assert.deepEqual([forgotten.auth, forgotten.encryptedLogin, forgotten.signedIn], ['chatgpt', undefined, undefined])
  // Removing the provider in use moves on to one that can be used, a sign-in included.
  settings = model.selectModel(settings, 'deepseek', 'deepseek-flash')
  assert.equal(model.removeProvider(settings, 'deepseek').activeProviderId, 'chatgpt')
})
