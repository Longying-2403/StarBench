// One sign-in from start to finish: a listener on this computer for the browser to come back to,
// the sign-in page opened in the browser, and the checks on what comes back.
// Nothing in this file depends on Electron; the caller says how a browser is opened.

import { timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { REGISTRATION_CLIENT, authorizeUrl, exchangeCode, pkce, randomValue, verifyIdToken } from './oauth.ts'
import type { AuthService, LoginRecord } from './oauth.ts'

/** Why a sign-in did not complete. `detail` is for the curious; the reason is what the page words. */
export type SignInFailure = 'cancelled' | 'denied' | 'timeout' | 'failed'
export class SignInError extends Error {
  readonly reason: SignInFailure
  constructor(reason: SignInFailure, detail: string) {
    super(detail)
    this.reason = reason
  }
}

export interface AttemptOptions {
  service: AuthService
  /** Identifies this installation; see `newHostId`. */
  hostId: string
  /** The registration to sign in to again. Without one, a new registration is made. */
  known?: Pick<LoginRecord, 'clientId' | 'subject' | 'idToken' | 'email'>
  /** Ask the account again for the permission to use its plan. */
  consent?: boolean
  /** Called with the address of the sign-in page once the listener is ready. */
  openBrowser(url: string): void | Promise<void>
  /** How long the person has to finish in the browser. */
  timeoutMs?: number
  /** The port to listen on if it is free; any other otherwise. */
  port?: number
}

export interface Attempt {
  /** The sign-in page, for a person whose browser did not open. */
  url: string
  /** Resolves with what to store; rejects with a `SignInError`. */
  result: Promise<LoginRecord>
  cancel(): void
}

/** The path is part of what a registration is tied to: it must never change. */
const CALLBACK_PATH = '/auth/callback'
/** The port OpenAI's own examples use. */
const USUAL_PORT = 1455
const TEN_MINUTES = 10 * 60_000

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

/** What the browser shows when it comes back. Self-contained: it loads nothing. */
function page(ok: boolean, title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · StarBench</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #16171a; color: #e6e6e6;
    font: 15px/1.6 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }
  main { max-width: 420px; padding: 32px; text-align: center; }
  h1 { margin: 0 0 8px; font-size: 20px; color: ${ok ? '#7fd88f' : '#ff8f8f'}; }
  p { margin: 0; color: #a9abb3; overflow-wrap: anywhere; }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></body>
</html>`
}

const sameText = (a: string, b: string): boolean => {
  const [x, y] = [Buffer.from(a), Buffer.from(b)]
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Listens on this computer only. Resolves with the port in use. */
function listenOn(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve((server.address() as AddressInfo).port)
    })
  })
}

/**
 * Starts a sign-in: opens the listener, then the browser. The person finishes in the browser;
 * `result` settles when the browser comes back, when the time is up, or on `cancel`.
 */
export async function startAttempt(options: AttemptOptions): Promise<Attempt> {
  const { service, known } = options
  // Fresh for every attempt, and gone with it.
  const state = randomValue()
  const nonce = randomValue()
  const { verifier, challenge } = pkce()

  let redirectUri = ''
  let finished = false
  /** A callback with the right state has been taken; a second one is not. */
  let used = false
  let server: http.Server | null = null
  let timer: NodeJS.Timeout | undefined
  let settle: { resolve(record: LoginRecord): void; reject(err: SignInError): void }
  const result = new Promise<LoginRecord>((resolve, reject) => (settle = { resolve, reject }))
  // Whoever started the attempt may only look at the outcome later.
  result.catch(() => {})

  const finish = (outcome: LoginRecord | SignInError): void => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    // The page for the browser is still on its way out; the listener goes right after it.
    const closing = server
    setTimeout(() => {
      closing?.close()
      closing?.closeAllConnections()
    }, 200).unref()
    if (outcome instanceof SignInError) settle.reject(outcome)
    else settle.resolve(outcome)
  }

  /** Everything between the browser coming back and a record worth storing. */
  const complete = async (params: URLSearchParams): Promise<LoginRecord> => {
    const refused = params.get('error')
    if (refused) {
      const detail = `${refused}${params.get('error_description') ? `: ${params.get('error_description')?.slice(0, 200)}` : ''}`
      throw new SignInError(refused === 'access_denied' ? 'denied' : 'failed', detail)
    }
    const code = params.get('code')
    if (!code) throw new SignInError('failed', 'The sign-in page came back without a code.')

    const given = params.get('client_id')
    let clientId: string
    if (known) {
      // A registration belongs to one account; another one's id must not take its place.
      if (given && given !== known.clientId) throw new SignInError('failed', 'The sign-in page came back for a different registration.')
      clientId = known.clientId
    } else {
      if (!given || given === REGISTRATION_CLIENT || !/^[\w.~-]{1,200}$/.test(given)) {
        throw new SignInError('failed', 'The registration was not completed: no client id came back.')
      }
      clientId = given
    }

    const tokens = await exchangeCode(service, { clientId, code, verifier, redirectUri })
    if (!tokens.idToken) throw new SignInError('failed', 'The sign-in service did not say who signed in.')
    const who = await verifyIdToken(service, tokens.idToken, { clientId, nonce })
    if (known && who.subject !== known.subject) {
      throw new SignInError('failed', 'A different account signed in than the one this registration belongs to.')
    }
    return {
      issuer: service.issuer,
      resource: service.resource,
      clientId,
      subject: who.subject,
      ...(who.email ? { email: who.email } : {}),
      idToken: tokens.idToken,
      tokens: {
        access: tokens.access,
        ...(tokens.refresh ? { refresh: tokens.refresh } : {}),
        expiresAt: tokens.expiresAt,
        ...(tokens.refreshFrom ? { refreshFrom: tokens.refreshFrom } : {})
      },
      // The token answer is what counts; the list on the way back is the same one, for services that leave it out there.
      scopes: tokens.scopes ?? (params.get('scope') ?? '').split(/\s+/).filter(Boolean),
      savedAt: new Date().toISOString()
    }
  }

  const receive = async (params: URLSearchParams): Promise<string> => {
    // Anything on this computer can call the listener; only the browser that was sent out knows the state.
    if (!sameText(params.get('state') ?? '', state)) {
      return page(false, '这不是当前的登录请求', '请回到 StarBench，从那里重新开始登录。')
    }
    if (used || finished) return page(false, '这个登录请求已经用过了', '请回到 StarBench 查看结果。')
    used = true
    try {
      finish(await complete(params))
      return page(true, '登录完成', '可以关闭这个页面，回到 StarBench 了。')
    } catch (err) {
      const failure = err instanceof SignInError ? err : new SignInError('failed', err instanceof Error ? err.message : String(err))
      finish(failure)
      return failure.reason === 'denied'
        ? page(false, '没有授权', '你在登录页面上选择了不授权。可以关闭这个页面，回到 StarBench。')
        : page(false, '登录没有完成', `请回到 StarBench 重试。（${failure.message}）`)
    }
  }

  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const send = (status: number, body: string): void => {
      res
        .writeHead(status, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          // The address this page was reached with holds the code.
          'referrer-policy': 'no-referrer',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
          'x-content-type-options': 'nosniff'
        })
        .end(body)
    }
    const url = new URL(req.url ?? '/', redirectUri)
    // A page on the web can make the browser call this computer, but not under this name.
    if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH || req.headers.host !== new URL(redirectUri).host) {
      return send(404, page(false, '这里没有内容', '这个地址只用于 StarBench 的登录。'))
    }
    receive(url.searchParams).then(
      (body) => send(200, body),
      () => send(500, page(false, '登录没有完成', '请回到 StarBench 重试。'))
    )
  }

  let port: number
  try {
    server = http.createServer(handler)
    port = await listenOn(server, options.port ?? USUAL_PORT)
  } catch {
    // Taken, typically by another program that is signing in right now. Only the port may differ.
    server = http.createServer(handler)
    port = await listenOn(server, 0)
  }
  // The address is spelled with the number on purpose: "localhost" is not accepted in its place.
  redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`

  let url: string
  try {
    url = await authorizeUrl(service, { redirectUri, state, nonce, challenge, hostId: options.hostId, known, consent: options.consent })
    await options.openBrowser(url)
  } catch (err) {
    finish(new SignInError('failed', err instanceof Error ? err.message : String(err)))
    throw err
  }
  timer = setTimeout(() => finish(new SignInError('timeout', 'Nobody finished signing in.')), options.timeoutMs ?? TEN_MINUTES)
  timer.unref()

  return { url, result, cancel: () => finish(new SignInError('cancelled', 'The sign-in was cancelled.')) }
}
