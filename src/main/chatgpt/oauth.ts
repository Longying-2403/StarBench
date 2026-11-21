// "Sign in with ChatGPT" for open-source apps: the requests and checks of the OAuth flow that
// lets model requests use the signed-in person's ChatGPT plan instead of an API key.
// Written against https://developers.openai.com/siwc/token-sharing-open-source .
// Nothing in this file depends on Electron.

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify } from 'jose'

export interface AuthService {
  /** The sign-in service. */
  issuer: string
  /** What the tokens are good for: the address of the API that model requests go to. */
  resource: string
}

export const OPENAI: AuthService = { issuer: 'https://auth.openai.com', resource: 'https://api.openai.com/v1' }

/** The id every installation starts from; the sign-in answers with one that belongs to the registration. */
export const REGISTRATION_CLIENT = 'dynamic_agent_client'
/** Shown on the page where the person approves the app. They can change it there. */
const APP_NAME = 'StarBench'
/** Who is signing in, then the permission to make model requests on their plan. */
const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct']
/** The one that must be among the granted scopes before any model request is made. */
const PLAN_SCOPE = 'chatgpt.tokens.use.direct'

const TIMEOUT_MS = 15_000
/** The longest sign-in address that every system passes on to a browser whole. */
const MAX_ADDRESS = 2000

/**
 * What is kept of one registration with one ChatGPT account. It is stored encrypted, and its
 * tokens only ever go back to the service named in it.
 */
export interface LoginRecord {
  issuer: string
  resource: string
  /** The client id this registration was given. It is reused for every later sign-in to the account. */
  clientId: string
  /** The account, as the verified ID token names it. */
  subject: string
  /** To tell accounts apart on screen. Two registrations can share an address. */
  email?: string
  /** Tells the sign-in page which account to continue with. Dropped on signing out. */
  idToken?: string
  /** Absent after signing out, and after the service said they will not work again. */
  tokens?: {
    access: string
    refresh?: string
    /** When the access token stops working, in milliseconds since 1970. */
    expiresAt: number
    /** The service may name a time before which it does not want to be asked for a new token. */
    refreshFrom?: number
  }
  /** What the account allowed, as the service listed it. */
  scopes: string[]
  savedAt: string
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)
const instant = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined)

/** Whether model requests may be made with this record: signed in, and allowed to use the plan. */
export function canUsePlan(record: LoginRecord | null | undefined): boolean {
  return Boolean(record?.tokens && record.scopes.includes(PLAN_SCOPE))
}

/** Tokens are renewed this long before they run out, so one handed out lasts through a request. */
const RENEW_AHEAD_MS = 5 * 60_000

/**
 * Whether to get new tokens before the next request: the access token is about to run out, or
 * it is the one (`rejected`) the API has just turned down. The service may name a time before
 * which it does not want to be asked; that is respected for as long as the token still works.
 */
export function renewalDue(tokens: NonNullable<LoginRecord['tokens']>, now: number, rejected?: string): boolean {
  const due = (rejected !== undefined && rejected === tokens.access) || now >= tokens.expiresAt - RENEW_AHEAD_MS
  const tooEarly = tokens.refreshFrom !== undefined && now < tokens.refreshFrom && now < tokens.expiresAt
  return due && !tooEarly
}

/** Reads a record back from storage. Null when it is not one. */
export function readRecord(raw: unknown): LoginRecord | null {
  if (!isObject(raw)) return null
  const [issuer, resource, clientId, subject] = [text(raw.issuer), text(raw.resource), text(raw.clientId), text(raw.subject)]
  if (!issuer || !resource || !clientId || !subject) return null
  const record: LoginRecord = {
    issuer,
    resource,
    clientId,
    subject,
    scopes: Array.isArray(raw.scopes) ? raw.scopes.filter((s): s is string => typeof s === 'string') : [],
    savedAt: text(raw.savedAt) ?? ''
  }
  if (text(raw.email)) record.email = text(raw.email)
  if (text(raw.idToken)) record.idToken = text(raw.idToken)
  if (isObject(raw.tokens)) {
    const [access, expiresAt] = [text(raw.tokens.access), instant(raw.tokens.expiresAt)]
    if (access && expiresAt) {
      record.tokens = { access, expiresAt }
      if (text(raw.tokens.refresh)) record.tokens.refresh = text(raw.tokens.refresh)
      if (instant(raw.tokens.refreshFrom)) record.tokens.refreshFrom = instant(raw.tokens.refreshFrom)
    }
  }
  return record
}

/**
 * Identifies this installation to the sign-in service. It is made once and kept; it says nothing
 * about the person and is not a secret.
 */
export function newHostId(): string {
  return `urn:uuid:${randomUUID()}`
}

/** A refusal from the sign-in service, with the code it gave. */
export class OAuthError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, status: number, detail?: string) {
    super(detail ? `${code}: ${detail}` : code)
    this.code = code
    this.status = status
  }
}

/** Answers to a refresh after which the stored tokens will never work again. */
const DEAD_TOKENS = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused'
])
export const tokensAreDead = (err: unknown): boolean => err instanceof OAuthError && DEAD_TOKENS.has(err.code)
/** The registration itself is not known to the service any more. */
export const clientIsGone = (err: unknown): boolean => err instanceof OAuthError && err.code === 'invalid_client'

interface Endpoints {
  authorize: string
  token: string
  keys: string
  /** Null when the service does not offer revocation. */
  revoke: string | null
  /** The signature algorithms the service says it signs ID tokens with. */
  algorithms: string[]
}

/** Only signatures made with a private key count; this also keeps "none" out. */
const SIGNATURES = /^(RS|PS|ES)(256|384|512)$|^EdDSA$/

const discovered = new Map<string, Promise<Endpoints>>()

async function discover(service: AuthService): Promise<Endpoints> {
  const response = await fetch(`${service.issuer}/.well-known/openid-configuration`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`The sign-in service did not describe itself (HTTP ${response.status}).`)
  const doc: unknown = await response.json()
  if (!isObject(doc) || doc.issuer !== service.issuer) throw new Error('The sign-in service describes itself as a different service.')
  // Codes and tokens are sent to these addresses, so they must belong to the service itself.
  const origin = new URL(service.issuer).origin
  const own = (name: string): string | null => {
    const value = text(doc[name])
    if (!value) return null
    if (new URL(value).origin !== origin) throw new Error(`The sign-in service names another site as its ${name}.`)
    return value
  }
  const [authorize, token, keys] = [own('authorization_endpoint'), own('token_endpoint'), own('jwks_uri')]
  if (!authorize || !token || !keys) throw new Error('The sign-in service left out an address that signing in needs.')
  const listed = Array.isArray(doc.id_token_signing_alg_values_supported) ? doc.id_token_signing_alg_values_supported : []
  const algorithms = listed.filter((a): a is string => typeof a === 'string' && SIGNATURES.test(a))
  return { authorize, token, keys, revoke: own('revocation_endpoint'), algorithms: algorithms.length ? algorithms : ['RS256'] }
}

/** The service's own description of where its parts are. Asked once; a failure is asked again. */
function endpoints(service: AuthService): Promise<Endpoints> {
  let known = discovered.get(service.issuer)
  if (!known) {
    known = discover(service)
    discovered.set(service.issuer, known)
    known.catch(() => discovered.delete(service.issuer))
  }
  return known
}

/** The pair that proves the app exchanging a code is the app that asked for it. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}
export const randomValue = (): string => randomBytes(24).toString('base64url')

export interface AuthorizeParams {
  redirectUri: string
  state: string
  nonce: string
  challenge: string
  hostId: string
  /** The registration to sign in to again. Without one, a new registration is asked for. */
  known?: Pick<LoginRecord, 'clientId' | 'idToken' | 'email'>
  /** Shows the page that asks for permission again, for an account that did not allow plan usage. */
  consent?: boolean
}

/** The address to open in the browser. With `known.idToken` it holds that token: not for logs. */
export async function authorizeUrl(service: AuthService, params: AuthorizeParams): Promise<string> {
  const url = new URL((await endpoints(service)).authorize)
  const query: Record<string, string> = {
    client_id: params.known?.clientId ?? REGISTRATION_CLIENT,
    response_type: 'code',
    redirect_uri: params.redirectUri,
    scope: SCOPES.join(' '),
    resource: service.resource,
    state: params.state,
    nonce: params.nonce,
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    ext_agent_host_id: params.hostId
  }
  if (params.known) {
    // Both only say which account to offer; the tokens that come back are checked all the same.
    if (params.known.idToken) query.id_token_hint = params.known.idToken
    if (params.known.email) query.login_hint = params.known.email
  } else {
    query.agent_name_hint = APP_NAME
  }
  if (params.consent) query.prompt = 'consent'
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value)
  // The ID token is by far the longest part, and only a convenience: without it the person picks
  // the account on the page. Windows does not hand addresses much beyond 2000 characters to a browser.
  if (url.toString().length > MAX_ADDRESS) url.searchParams.delete('id_token_hint')
  return url.toString()
}

export interface TokenSet {
  access: string
  refresh?: string
  idToken?: string
  expiresAt: number
  refreshFrom?: number
  /** Absent when the answer did not list them. */
  scopes?: string[]
}

/** A point in time the service gave, in whichever of the usual forms. */
function timeOf(value: unknown): number | undefined {
  if (typeof value === 'string' && value.trim()) {
    const parsed = /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : Date.parse(value)
    return Number.isFinite(parsed) ? timeOf(parsed) : undefined
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  // Seconds, unless the number is too large to be anything but milliseconds.
  return value < 1e11 ? value * 1000 : value
}

async function refusal(response: Response): Promise<OAuthError> {
  const body: unknown = await response.json().catch(() => null)
  const top = isObject(body) ? body : {}
  // Both the OAuth shape ({ error: "code" }) and OpenAI's own ({ error: { code, message } }) are in use.
  const nested = isObject(top.error) ? top.error : {}
  const code = text(top.error) ?? text(nested.code) ?? text(top.code) ?? `http_${response.status}`
  const detail = text(top.error_description) ?? text(nested.message) ?? text(top.message)
  return new OAuthError(code, response.status, detail?.slice(0, 300))
}

async function tokenRequest(service: AuthService, form: Record<string, string>): Promise<TokenSet> {
  const { token } = await endpoints(service)
  const asked = Date.now()
  const response = await fetch(token, {
    method: 'POST',
    headers: { accept: 'application/json' },
    body: new URLSearchParams({ ...form, resource: service.resource }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!response.ok) throw await refusal(response)
  const body: unknown = await response.json()
  const access = isObject(body) ? text(body.access_token) : undefined
  if (!isObject(body) || !access) throw new Error('The sign-in service answered without an access token.')
  const lifetime = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600
  const tokens: TokenSet = { access, expiresAt: asked + lifetime * 1000 }
  if (text(body.refresh_token)) tokens.refresh = text(body.refresh_token)
  if (text(body.id_token)) tokens.idToken = text(body.id_token)
  if (timeOf(body.earliest_refresh_at)) tokens.refreshFrom = timeOf(body.earliest_refresh_at)
  if (typeof body.scope === 'string') tokens.scopes = body.scope.split(/\s+/).filter(Boolean)
  return tokens
}

/** Trades the code the browser came back with for tokens. No secret is involved: the verifier is the proof. */
export function exchangeCode(
  service: AuthService,
  from: { clientId: string; code: string; verifier: string; redirectUri: string }
): Promise<TokenSet> {
  return tokenRequest(service, {
    grant_type: 'authorization_code',
    client_id: from.clientId,
    code: from.code,
    code_verifier: from.verifier,
    redirect_uri: from.redirectUri
  })
}

/**
 * Gets new tokens for the ones in the record. The refresh token it was made with stops working,
 * so the answer has to be stored before anything else is done with it.
 */
export async function refreshed(service: AuthService, record: LoginRecord): Promise<LoginRecord> {
  if (!record.tokens?.refresh) throw new Error('There is no refresh token to renew the sign-in with.')
  const fresh = await tokenRequest(service, {
    grant_type: 'refresh_token',
    client_id: record.clientId,
    refresh_token: record.tokens.refresh
  })
  return {
    ...record,
    tokens: {
      access: fresh.access,
      // Every answer brings a replacement; should one not, the one in hand is all there is.
      refresh: fresh.refresh ?? record.tokens.refresh,
      expiresAt: fresh.expiresAt,
      ...(fresh.refreshFrom ? { refreshFrom: fresh.refreshFrom } : {})
    },
    scopes: fresh.scopes ?? record.scopes,
    savedAt: new Date().toISOString()
  }
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Tells the service to stop honouring the record's refresh token. Resolves with whether the service
 * confirmed it; a service that cannot be reached is tried a few times.
 */
export async function revoke(service: AuthService, record: LoginRecord, waits: readonly number[] = [500, 1500]): Promise<boolean> {
  if (!record.tokens?.refresh) return true
  const address = (await endpoints(service).catch(() => null))?.revoke
  if (!address) return false
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(address, {
        method: 'POST',
        body: new URLSearchParams({ token: record.tokens.refresh, token_type_hint: 'refresh_token', client_id: record.clientId }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      // An empty 200 is the confirmation, also for a token that had already stopped working.
      if (response.status === 200) return true
      if (response.status < 500) return false
    } catch {
      // Unreachable: worth another try.
    }
    if (attempt >= waits.length) return false
    await pause(waits[attempt])
  }
}

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

/**
 * Checks that an ID token was issued by the service, for this registration and in answer to this
 * sign-in, and resolves with who it names. Rejects otherwise.
 */
export async function verifyIdToken(
  service: AuthService,
  idToken: string,
  expected: { clientId: string; nonce: string }
): Promise<{ subject: string; email?: string }> {
  const { keys, algorithms } = await endpoints(service)
  let keySet = keySets.get(keys)
  // The key set fetches the keys when first used and again when a token names one it has not seen.
  if (!keySet) keySets.set(keys, (keySet = createRemoteJWKSet(new URL(keys), { timeoutDuration: TIMEOUT_MS })))
  const { payload } = await jwtVerify(idToken, keySet, {
    issuer: service.issuer,
    audience: expected.clientId,
    algorithms,
    requiredClaims: ['sub', 'exp', 'iat'],
    clockTolerance: 5
  })
  if (payload.nonce !== expected.nonce) throw new Error('The ID token does not belong to this sign-in.')
  const subject = text(payload.sub)
  if (!subject) throw new Error('The ID token names no account.')
  const email = text(payload.email)
  return { subject, ...(email ? { email } : {}) }
}
