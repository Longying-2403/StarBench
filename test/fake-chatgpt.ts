// A stand-in for OpenAI's sign-in service and API, as far as "Sign in with ChatGPT" for
// open-source apps uses them: discovery, the sign-in page (which approves at once and sends the
// browser back), the token endpoint with rotating refresh tokens, revocation, the model list of
// a signed-in account and the Responses API.
//
// The tests use it, and it can be run by itself to try the app against it; see
// STARBENCH_SIGNIN_TEST_SERVER in the README.

import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'

export interface Seen {
  method: string
  path: string
  headers: http.IncomingHttpHeaders
  /** The query of a GET, the form of a form post, the JSON of a JSON post. */
  body: any
}

/** What a test can change about how the stand-in behaves. */
export interface Knobs {
  /**
   * Who signs in when the sign-in page is opened. With a `workspace`, a registration is of that
   * person and that workspace, as OpenAI's are, and registering it again gives the id it has;
   * without one, every registration gets an id of its own.
   */
  account: { sub: string; email: string; workspace?: string }
  /**
   * What becomes of a code brought to the token endpoint. `refuse-first`: the first one is not
   * taken (`invalid_grant`, as the real service did on 2026-11-24 for a second workspace of one
   * person) and later ones are; `refuse`: none is.
   */
  codeExchange: 'ok' | 'refuse-first' | 'refuse'
  /** The scopes the account grants; null grants what was asked for. */
  grant: string | null
  /** The person says no on the sign-in page. */
  deny: boolean
  /** Seconds an access token lasts. */
  accessLifetime: number
  /** Something wrong with the ID token. */
  tamper: null | 'nonce' | 'audience' | 'signature'
  /** The status revocation answers with. */
  revokeStatus: number
  /** How the Responses API answers. `no-fast`: the model has no faster answers, and requests that ask for them are refused. */
  responses: 'ok' | 'usage-limit' | 'usage-limit-http' | 'cut-off' | 'reject-token-once' | 'no-fast'
}

export interface FakeChatGpt {
  origin: string
  service: { issuer: string; resource: string }
  knobs: Knobs
  seen: Seen[]
  /** Everything asked of one path, oldest first. */
  asked(path: string): Seen[]
  /** Plays the browser: opens the sign-in address and ends up wherever it is sent back to. */
  browse(url: string): Promise<{ status: number; body: string }>
  /** Makes the refresh tokens handed out so far worthless, as disconnecting the app in ChatGPT would. */
  disconnect(): void
  close(): Promise<void>
}

const random = (): string => randomBytes(12).toString('base64url')
const sse = (events: Record<string, unknown>[]): string => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')

export async function startFakeChatGpt(port = 0): Promise<FakeChatGpt> {
  const signing = await generateKeyPair('RS256')
  const stranger = await generateKeyPair('RS256')
  const kid = 'test-key-1'
  const jwk = { ...(await exportJWK(signing.publicKey)), kid, alg: 'RS256', use: 'sig' }

  const knobs: Knobs = {
    account: { sub: 'user-1', email: 'person@example.com' },
    codeExchange: 'ok',
    grant: null,
    deny: false,
    accessLifetime: 3600,
    tamper: null,
    revokeStatus: 200,
    responses: 'ok'
  }
  const seen: Seen[] = []
  /** Registrations by the client id each was given. */
  const clients = new Map<string, { sub: string }>()
  /** The registrations of a person's workspaces, by person and workspace. */
  const registered = new Map<string, string>()
  let refusedCodes = 0
  const codes = new Map<string, { clientId: string; challenge: string; redirectUri: string; nonce: string; scope: string; account: Knobs['account'] }>()
  const refreshTokens = new Map<string, { clientId: string; scope: string; state: 'live' | 'used' | 'dead'; account: Knobs['account'] }>()
  const accessTokens = new Map<string, number>()
  let rejectedOnce = false
  let origin = ''

  const json = (res: http.ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  }

  const issue = async (clientId: string, scope: string, account: Knobs['account'], nonce?: string): Promise<Record<string, unknown>> => {
    const access = `at_${random()}`
    const refresh = `rt_${random()}`
    accessTokens.set(access, Date.now() + knobs.accessLifetime * 1000)
    refreshTokens.set(refresh, { clientId, scope, state: 'live', account: { ...account } })
    const tokens: Record<string, unknown> = { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: knobs.accessLifetime, scope }
    if (nonce !== undefined) {
      tokens.id_token = await new SignJWT({ nonce: knobs.tamper === 'nonce' ? 'someone-elses' : nonce, email: account.email, email_verified: true })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuer(origin)
        .setAudience(knobs.tamper === 'audience' ? 'oaiapp_somebody_else' : clientId)
        .setSubject(account.sub)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(knobs.tamper === 'signature' ? stranger.privateKey : signing.privateKey)
    }
    return tokens
  }

  const authorize = (query: URLSearchParams, res: http.ServerResponse): void => {
    const back = new URL(query.get('redirect_uri') ?? '')
    back.searchParams.set('state', query.get('state') ?? '')
    if (knobs.deny) {
      back.searchParams.set('error', 'access_denied')
      return void res.writeHead(302, { location: back.toString() }).end()
    }
    let clientId = query.get('client_id') ?? ''
    const registering = clientId === 'dynamic_agent_client'
    if (registering) {
      if (!query.get('agent_name_hint') || !query.get('ext_agent_host_id')) return json(res, 400, { error: 'invalid_request' })
      const key = knobs.account.workspace === undefined ? undefined : `${knobs.account.sub}/${knobs.account.workspace}`
      clientId = (key && registered.get(key)) || `oaiapp_${random()}`
      if (key) registered.set(key, clientId)
      clients.set(clientId, { sub: knobs.account.sub })
    } else if (!clients.has(clientId)) {
      return json(res, 400, { error: 'invalid_client' })
    }
    const code = random()
    const scope = knobs.grant ?? query.get('scope') ?? ''
    codes.set(code, {
      clientId,
      challenge: query.get('code_challenge') ?? '',
      redirectUri: back.origin + back.pathname,
      nonce: query.get('nonce') ?? '',
      scope,
      account: { ...knobs.account }
    })
    back.searchParams.set('code', code)
    back.searchParams.set('scope', scope.split(' ').sort().join(' '))
    // A sign-in to a registration that exists may leave the id out; a new one is told its id.
    if (registering) back.searchParams.set('client_id', clientId)
    res.writeHead(302, { location: back.toString() }).end()
  }

  const token = async (form: Record<string, string>, res: http.ServerResponse): Promise<void> => {
    if (form.resource !== `${origin}/v1` || 'client_secret' in form) return json(res, 400, { error: 'invalid_request' })
    if (form.grant_type === 'authorization_code') {
      const pending = codes.get(form.code)
      codes.delete(form.code)
      if (knobs.codeExchange === 'refuse' || (knobs.codeExchange === 'refuse-first' && refusedCodes === 0)) {
        refusedCodes++
        return json(res, 400, { error: 'invalid_grant' })
      }
      const challenge = createHash('sha256').update(form.code_verifier ?? '').digest('base64url')
      if (!pending || pending.clientId !== form.client_id || pending.redirectUri !== form.redirect_uri || pending.challenge !== challenge) {
        return json(res, 400, { error: 'invalid_grant', error_description: 'The code is not valid for this request.' })
      }
      return json(res, 200, await issue(pending.clientId, pending.scope, pending.account, pending.nonce))
    }
    if (form.grant_type === 'refresh_token') {
      if (!clients.has(form.client_id)) return json(res, 401, { error: 'invalid_client' })
      const known = refreshTokens.get(form.refresh_token)
      if (!known || known.clientId !== form.client_id || known.state === 'dead') return json(res, 400, { error: 'invalid_grant' })
      // OpenAI's own shape of an error, as the refresh codes come in it.
      if (known.state === 'used') return json(res, 401, { error: { code: 'refresh_token_reused', message: 'This refresh token was already used.' } })
      known.state = 'used'
      // A token is renewed for the account it was given to, whichever account signs in next: several can be signed in at once.
      return json(res, 200, await issue(known.clientId, known.scope, known.account))
    }
    json(res, 400, { error: 'unsupported_grant_type' })
  }

  const responses = (request: Seen, res: http.ServerResponse): void => {
    const body = request.body ?? {}
    const input: any[] = Array.isArray(body.input) ? body.input : []
    const last = input.at(-1)
    const said = [...input].reverse().find((item) => item.role === 'user')?.content ?? ''
    const done = { type: 'response.completed', response: { status: 'completed' } }
    const stream = (events: Record<string, unknown>[]): void => void res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse(events))

    if (knobs.responses === 'usage-limit-http') {
      return json(res, 429, { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Usage limit reached.', type: 'usage_limit' } })
    }
    if (knobs.responses === 'usage-limit') {
      return stream([
        { type: 'response.created' },
        { type: 'response.failed', response: { status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Usage limit reached.' } } }
      ])
    }
    if (knobs.responses === 'cut-off') return stream([{ type: 'response.output_text.delta', delta: 'Half an ans' }])
    // Faster answers go by one name here ("priority"); the name the API also takes is turned down,
    // in the bare shape the real service uses for it. Some models have no faster answers at all.
    const tier = body.service_tier
    if (tier && (tier !== 'priority' || knobs.responses === 'no-fast')) return json(res, 400, { detail: `Unsupported service_tier: ${tier}` })
    if (last?.type === 'function_call_output') {
      const text = `The file says: ${String(last.output).replace(/^\d+\t/, '')}`
      return stream([
        { type: 'response.output_text.delta', delta: text },
        { type: 'response.output_item.done', item: { type: 'message', id: `msg_${random()}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] } },
        done
      ])
    }
    if (/note\.txt/.test(said)) {
      // The tools came grouped under a name, so the call names the group too.
      const group = body.tools?.[0]?.type === 'namespace' ? { namespace: body.tools[0].name } : {}
      return stream([
        { type: 'response.reasoning_summary_part.added' },
        { type: 'response.reasoning_summary_text.delta', delta: 'The note has to be read first.' },
        { type: 'response.output_item.done', item: { type: 'reasoning', id: `rs_${random()}`, summary: [{ type: 'summary_text', text: 'The note has to be read first.' }], encrypted_content: 'ENCRYPTED' } },
        { type: 'response.output_item.done', item: { type: 'function_call', id: `fc_${random()}`, call_id: `call_${random()}`, name: 'read_file', arguments: '{"path":"note.txt"}', status: 'completed', ...group } },
        done
      ])
    }
    const text = `Hello from ${body.model} on the plan.`
    stream([{ type: 'response.output_text.delta', delta: text }, done])
  }

  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', origin)
      const type = req.headers['content-type'] ?? ''
      const body =
        req.method === 'GET'
          ? Object.fromEntries(url.searchParams)
          : type.includes('json')
            ? JSON.parse(raw || 'null')
            : Object.fromEntries(new URLSearchParams(raw))
      const request: Seen = { method: req.method ?? '', path: url.pathname, headers: req.headers, body }
      seen.push(request)

      if (url.pathname === '/.well-known/openid-configuration') {
        return json(res, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/api/accounts/authorize`,
          token_endpoint: `${origin}/api/accounts/oauth/token`,
          jwks_uri: `${origin}/.well-known/jwks.json`,
          revocation_endpoint: `${origin}/api/accounts/oauth/revoke`,
          id_token_signing_alg_values_supported: ['RS256']
        })
      }
      if (url.pathname === '/.well-known/jwks.json') return json(res, 200, { keys: [jwk] })
      if (url.pathname === '/api/accounts/authorize') return authorize(url.searchParams, res)
      if (url.pathname === '/api/accounts/oauth/token') return void token(body, res)
      if (url.pathname === '/api/accounts/oauth/revoke') {
        const known = refreshTokens.get(body.token)
        if (knobs.revokeStatus === 200 && known) known.state = 'dead'
        return void res.writeHead(knobs.revokeStatus).end()
      }
      // Changing the knobs and reading the log from outside, for trying the app against this by hand.
      if (url.pathname === '/__knobs') return json(res, 200, Object.assign(knobs, req.method === 'POST' ? body : {}))
      if (url.pathname === '/__seen') return json(res, 200, seen.map((s) => ({ method: s.method, path: s.path, authorization: s.headers.authorization, body: s.body })))
      if (url.pathname === '/__disconnect') return json(res, 200, { ok: (api.disconnect(), true) })

      if (url.pathname.startsWith('/v1/')) {
        const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? ''
        const turnAway = knobs.responses === 'reject-token-once' && !rejectedOnce && req.method === 'POST'
        if (turnAway) rejectedOnce = true
        // The answer of the door, before any request is looked at: no code, just a word.
        if (turnAway || (accessTokens.get(bearer) ?? 0) < Date.now()) return json(res, 401, { detail: 'The token was not accepted.' })
        if (url.pathname === '/v1/models' && req.method === 'GET') {
          return json(res, 200, {
            models: [
              { slug: 'gpt-plan-a', display_name: 'GPT Plan A', visibility: 'list' },
              { slug: 'gpt-internal', display_name: 'Not for listing', visibility: 'hide' },
              { slug: 'gpt-plan-b', display_name: 'GPT Plan B', visibility: 'list' }
            ]
          })
        }
        if (url.pathname === '/v1/responses' && req.method === 'POST') return responses(request, res)
      }
      json(res, 404, { error: 'not_found' })
    })
  })

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const api: FakeChatGpt = {
    origin,
    service: { issuer: origin, resource: `${origin}/v1` },
    knobs,
    seen,
    asked: (path) => seen.filter((s) => s.path === path),
    browse: async (url) => {
      const response = await fetch(url)
      return { status: response.status, body: await response.text() }
    },
    disconnect: () => {
      for (const entry of refreshTokens.values()) entry.state = 'dead'
      accessTokens.clear()
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
  return api
}
