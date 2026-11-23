// The services' own web search, as each one tells of it in its replies. What is read here goes to
// the page (what was searched for, and what was found) and with the reply into the conversation.
// Shapes found with real requests on 2026-11-23: DeepSeek chat completions with
// `deepseek_web_search`, xAI's Responses API with `web_search`, and Claude's `web_search_20250305`
// and `web_fetch_20250910`. OpenAI's Responses API documents the same items as xAI's.

import type { WebActivity } from '../../shared/types.ts'
import type { AssistantMessage } from './types.ts'

type Bag = Record<string, unknown>

const isBag = (value: unknown): value is Bag => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
const texts = (value: unknown): string[] | undefined => {
  const found = Array.isArray(value) ? value.map(text).filter((t): t is string => t !== undefined) : []
  return found.length ? found : undefined
}

/** The pages a service names, with their titles where it gives them; at most this many are kept. */
const MAX_SOURCES = 20

function sourcesOf(value: unknown): WebActivity['sources'] {
  const found: NonNullable<WebActivity['sources']> = []
  for (const item of Array.isArray(value) ? value : []) {
    const url = isBag(item) ? text(item.url) : undefined
    if (!url || found.some((s) => s.url === url)) continue
    const title = isBag(item) ? text(item.title) : undefined
    // A title that is only the address again says nothing more (xAI gives that).
    found.push(title && title !== url ? { url, title } : { url })
    if (found.length === MAX_SOURCES) break
  }
  return found.length ? found : undefined
}

/** The activity without the fields that are not known, so that merging it keeps what was known before. */
function known(activity: WebActivity): WebActivity {
  return Object.fromEntries(Object.entries(activity).filter(([, v]) => v !== undefined)) as unknown as WebActivity
}

/**
 * Collects the web activity of one reply: what each search or page read is known to be by now,
 * kept on the message (`web`) and told on as it changes.
 */
export class WebLog {
  private readonly byId = new Map<string, WebActivity>()
  private readonly message: AssistantMessage
  private readonly tell?: (activity: WebActivity) => void

  constructor(message: AssistantMessage, tell?: (activity: WebActivity) => void) {
    this.message = message
    this.tell = tell
  }

  /**
   * Takes in what is known of one activity now. Fields it leaves out keep what they were, and
   * one that has ended does not go back to being under way.
   */
  put(activity: WebActivity): void {
    const before = this.byId.get(activity.id)
    const now = before ? { ...before, ...known(activity) } : known(activity)
    if (before && before.status !== 'running' && now.status === 'running') now.status = before.status
    this.byId.set(now.id, now)
    this.message.web = [...this.byId.values()]
    this.tell?.(now)
  }

  has(id: string): boolean {
    return this.byId.has(id)
  }
}

/**
 * DeepSeek's `server_tool_calls`: the steps of its search, each with the calls made in it. They
 * come in one piece with the end of the reply, every call already done. A call either searched
 * (`action.queries`) or opened a page (`action.url`).
 */
export function deepSeekActivities(raw: unknown): WebActivity[] {
  const out: WebActivity[] = []
  for (const step of Array.isArray(raw) ? raw : [raw]) {
    if (!isBag(step)) continue
    for (const call of Array.isArray(step.calls) ? step.calls : [step]) {
      if (!isBag(call)) continue
      const id = text(call.id)
      if (!id) continue
      const action = isBag(call.action) ? call.action : {}
      const page = isBag(call.page) ? call.page : undefined
      const open = action.type === 'open_page' || action.type === 'read_url' || call.type === 'deepseek_read_url'
      const failed = call.status === 'failed' || call.status === 'error'
      out.push(
        known({
          id,
          kind: open ? 'open' : 'search',
          queries: open ? undefined : (texts(action.queries) ?? (text(action.query) ? [text(action.query)!] : undefined)),
          url: text(action.url) ?? (page ? text(page.url) : undefined),
          status: failed ? 'failed' : 'done',
          error: failed ? (text(call.error) ?? text(isBag(call.error) ? call.error.message : undefined)) : undefined,
          sources: sourcesOf(call.sources) ?? (page ? sourcesOf([page]) : undefined)
        })
      )
    }
  }
  return out
}

/**
 * A `web_search_call` of the Responses API (OpenAI, xAI), as it stands: announced with an empty
 * action, done with what was searched for and, where the service tells it, the pages found.
 * Null for any other item.
 */
export function responsesActivity(item: unknown): WebActivity | null {
  if (!isBag(item) || item.type !== 'web_search_call') return null
  const id = text(item.id)
  if (!id) return null
  const action = isBag(item.action) ? item.action : {}
  const open = action.type === 'open_page' || action.type === 'find_in_page'
  const status = item.status === 'completed' ? 'done' : item.status === 'failed' ? 'failed' : 'running'
  return known({
    id,
    kind: open ? 'open' : 'search',
    queries: open
      ? (text(action.pattern) ? [text(action.pattern)!] : undefined)
      : (texts(action.queries) ?? (text(action.query) ? [text(action.query)!] : undefined)),
    url: text(action.url),
    status,
    sources: sourcesOf(action.sources)
  })
}

/** Claude's server tools that search or read the web, by the name the reply calls them. */
const CLAUDE_TOOLS: Record<string, WebActivity['kind']> = { web_search: 'search', web_fetch: 'open' }

/** A `server_tool_use` block of Claude's, once its input is known (or before, with none). Null for other server tools. */
export function claudeCall(block: unknown, input?: unknown): WebActivity | null {
  if (!isBag(block) || block.type !== 'server_tool_use') return null
  const kind = CLAUDE_TOOLS[String(block.name)]
  const id = text(block.id)
  if (!kind || !id) return null
  const given = isBag(input) ? input : isBag(block.input) ? block.input : {}
  return known({
    id,
    kind,
    queries: kind === 'search' && text(given.query) ? [text(given.query)!] : undefined,
    url: kind === 'open' ? text(given.url) : undefined,
    status: 'running'
  })
}

/** The result block that ends one of those calls: the pages found or read, or the error it ended in. Null for other blocks. */
export function claudeResult(block: unknown): WebActivity | null {
  if (!isBag(block) || (block.type !== 'web_search_tool_result' && block.type !== 'web_fetch_tool_result')) return null
  const id = text(block.tool_use_id)
  if (!id) return null
  const content = block.content
  if (Array.isArray(content)) return known({ id, kind: 'search', status: 'done', sources: sourcesOf(content) })
  if (isBag(content) && content.type === 'web_fetch_result') {
    const doc = isBag(content.content) ? content.content : {}
    const url = text(content.url)
    return known({ id, kind: 'open', url, status: 'done', sources: url ? sourcesOf([{ url, title: doc.title }]) : undefined })
  }
  const code = isBag(content) ? text(content.error_code) : undefined
  return known({ id, kind: block.type === 'web_fetch_tool_result' ? 'open' : 'search', status: 'failed', error: code ?? 'unknown_error' })
}

/** The blocks of Claude's own search: left out of a reply that goes back to a request without the search tools. */
export const CLAUDE_SEARCH_BLOCKS: ReadonlySet<string> = new Set(['server_tool_use', 'web_search_tool_result', 'web_fetch_tool_result'])

// Gemini's own search (`googleSearch`) and page reading (`urlContext`), on its own API
// (gemini.ts). The shapes are those of Google's documentation of generateContent, read on
// 2026-11-23 (google-search, url-context and tool-combination).

/** Gemini's tools that search or read the web, by the type its parts give them (`toolType`). */
const GEMINI_TOOLS: Record<string, WebActivity['kind']> = { GOOGLE_SEARCH_WEB: 'search', GOOGLE_SEARCH_IMAGE: 'search', URL_CONTEXT: 'open' }

/** Why Gemini could not read a page (`urlRetrievalStatus`), in the codes the page has words for. */
const GEMINI_PAGE_ERRORS: Record<string, string> = {
  URL_RETRIEVAL_STATUS_ERROR: 'url_not_accessible',
  URL_RETRIEVAL_STATUS_PAYWALL: 'url_not_accessible',
  URL_RETRIEVAL_STATUS_UNSAFE: 'url_not_allowed'
}

/** The pages of a page read of Gemini's, each with why it could not be read, if it could not. The fields come in either spelling. */
function geminiPages(list: unknown): { url: string; error?: string }[] {
  const out: { url: string; error?: string }[] = []
  for (const entry of Array.isArray(list) ? list : []) {
    const url = isBag(entry) ? text(entry.retrievedUrl ?? entry.retrieved_url) : undefined
    if (!url || !isBag(entry)) continue
    const status = String(entry.urlRetrievalStatus ?? entry.url_retrieval_status ?? '')
    if (status === 'URL_RETRIEVAL_STATUS_SUCCESS') out.push({ url })
    else out.push({ url, error: GEMINI_PAGE_ERRORS[status] ?? (status.replace(/^URL_RETRIEVAL_STATUS_/, '').toLowerCase() || 'unknown_error') })
  }
  return out
}

/**
 * A search or page read of Gemini's own, from a part of its reply: a `toolCall`, which says what
 * it searches for or which pages it reads, or the `toolResponse` that ends it. Such parts come
 * where the request asked for the service's own calls to be handed over
 * (`toolConfig.includeServerSideToolInvocations`). A read of several pages is one activity, with
 * the first page as its address while it runs and the pages that were read among its sources once
 * it is done: none, where every page failed (tried 2026-11-24, two pages that could not be
 * fetched). Null for any other part.
 */
export function geminiActivity(part: unknown): WebActivity | null {
  if (!isBag(part)) return null
  const call = isBag(part.toolCall) ? part.toolCall : undefined
  const tool = call ?? (isBag(part.toolResponse) ? part.toolResponse : undefined)
  const kind = tool ? GEMINI_TOOLS[String(tool.toolType)] : undefined
  const id = tool ? text(tool.id) : undefined
  if (!tool || !kind || !id) return null
  if (call) {
    const args = isBag(call.args) ? call.args : {}
    return known({
      id,
      kind,
      queries: kind === 'search' ? texts(args.queries) : undefined,
      url: kind === 'open' ? texts(args.urls)?.[0] : undefined,
      status: 'running'
    })
  }
  const response = isBag(tool.response) ? tool.response : {}
  // A search ends with Google's Search Suggestions for it, which are to be shown with the answer.
  if (kind === 'search') return known({ id, kind, status: 'done', suggestions: text(response.search_suggestions) })
  const pages = geminiPages(response.url_metadata ?? response.urlMetadata)
  const read = pages.filter((page) => !page.error)
  return known({
    id,
    kind,
    status: pages.length > 0 && read.length === 0 ? 'failed' : 'done',
    error: read.length === 0 ? pages[0]?.error : undefined,
    // Said even when empty, so that nothing told of the read before stands for a page that was read.
    sources: read.map(({ url }) => ({ url }))
  })
}

/**
 * The pages a reply of Gemini's read, with the titles its searches gave them. Gemini reads pages
 * at the addresses its search found them at, which lead through Google and say nothing by
 * themselves (`vertexaisearch.cloud.google.com/grounding-api-redirect/…`, seen 2026-11-24); the
 * search's own list of pages names each. The page reads that gain a title, as they are now; none
 * where nothing is to be added.
 */
export function geminiTitledReads(web: readonly WebActivity[]): WebActivity[] {
  const titles = new Map<string, string>()
  for (const activity of web) if (activity.kind === 'search') for (const source of activity.sources ?? []) if (source.title) titles.set(source.url, source.title)
  return web.flatMap((activity) => {
    if (activity.kind !== 'open' || !activity.sources?.some((source) => !source.title && titles.has(source.url))) return []
    return [{ ...activity, sources: activity.sources.map((source) => (source.title || !titles.has(source.url) ? source : { ...source, title: titles.get(source.url)! })) }]
  })
}

/**
 * What Gemini tells at the end of a reply that searched (`groundingMetadata`): what it searched
 * for, and the pages the answer rests on (`groundingChunks[].web`). Their addresses lead through
 * Google to the page; their titles are the sites' names. And the Search Suggestions to show with
 * the answer (`searchEntryPoint.renderedContent`), where they come here and not with each search
 * (Gemini 4 Hydrogen sent none here on 2026-11-24). Told under `id`, as done; null when it says
 * none of that.
 */
export function geminiGrounding(metadata: unknown, id: string): WebActivity | null {
  if (!isBag(metadata)) return null
  const queries = texts(metadata.webSearchQueries)
  const chunks = Array.isArray(metadata.groundingChunks) ? metadata.groundingChunks : []
  const sources = sourcesOf(chunks.map((chunk) => (isBag(chunk) && isBag(chunk.web) ? { url: chunk.web.uri, title: chunk.web.title } : null)))
  const suggestions = isBag(metadata.searchEntryPoint) ? text(metadata.searchEntryPoint.renderedContent) : undefined
  if (!queries && !sources && !suggestions) return null
  return known({ id, kind: 'search', queries, status: 'done', sources, suggestions })
}

/** The pages Gemini read, as it tells them at the end of a reply (`urlContextMetadata`): each a page read of its own, told under `${prefix}-${n}`. */
export function geminiPagesRead(metadata: unknown, prefix: string): WebActivity[] {
  const list = isBag(metadata) ? (metadata.urlMetadata ?? metadata.url_metadata) : undefined
  return geminiPages(list).map(({ url, error }, n) =>
    known({ id: `${prefix}-${n}`, kind: 'open', url, status: error ? 'failed' : 'done', error, sources: error ? undefined : [{ url }] })
  )
}
