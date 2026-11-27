// The OpenAI Responses API. Requests are stateless (`store: false`): the whole conversation is
// sent each time, with the model's reasoning carried along in encrypted form.
//
// The same API serves requests paid for by a person's ChatGPT plan (`connection.plan`), with a
// few rules of its own, taken from
// https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations .
//
// Not on that page, found by trying with gpt-6.2-sol on 2026-11-23: a request paid for by plan
// is neither read from the prompt cache nor written to it, where the very same request paid for
// by API key is. And the two fields that steer the cache, `prompt_cache_options` and
// `prompt_cache_breakpoint`, are refused there with "not supported on this model", though an API
// key may send both. So nothing here asks for caching: by key it comes unasked, by plan not at all.

import OpenAI from 'openai'
import { routesByConversation } from '../../shared/types.ts'
import type { ToolCall } from '../../shared/types.ts'
import { fetchModelInfo, fetchPlanModelInfo, listModels, listPlanModels } from '../models.ts'
import { DocumentsRefused, ImagesRefused, carriesDocuments, carriesImages, imageUrl, pdfUrl, refusesDocuments, refusesImages, userDocuments, userImages } from './attachments.ts'
import { refusesEffort } from './effort.ts'
import { newReply, replayOf, userText, withSearchNote, withToolResults } from './history.ts'
import { ServiceError } from './types.ts'
import type { Connection, ModelReply, ModelRequest, ProviderAdapter } from './types.ts'
import { WebLog, responsesActivity } from './web-search.ts'

type InputItem = OpenAI.Responses.ResponseInputItem
type OutputItem = OpenAI.Responses.ResponseOutputItem

/**
 * The kinds of output this app produces and can hand back to the service as they came. A search
 * the service made goes back too: without it, xAI searched for the same thing again in the next
 * turn (tried on 2026-11-23; with it, it did not, and the request was taken either way).
 */
const REPLAYED = new Set(['reasoning', 'message', 'function_call', 'web_search_call'])

/** Plan usage wants function tools grouped under a name; the model's calls then name the group too. */
const TOOL_GROUP = 'starbench'
const TOOL_GROUP_ABOUT =
  "Tools for working in the user's workspace: reading, searching and changing files and running commands, plus whatever plugins and MCP servers add."

/** The conversation as the Responses API takes it. */
export function responsesInput(request: Pick<ModelRequest, 'messages' | 'connection'>): InputItem[] {
  const input: InputItem[] = []
  // Calls another model made are told the way this one's own would look.
  const group = request.connection.plan ? { namespace: TOOL_GROUP } : {}
  for (const message of withToolResults(request.messages)) {
    if (message.role === 'user') {
      const text = userText(message, request.connection)
      const images = userImages(message, request.connection)
      const documents = userDocuments(message, request.connection)
      // With pictures or PDFs, the message is a list of parts: each PDF under its name, the text, then each picture as an address that holds it.
      if (images.length === 0 && documents.length === 0) input.push({ role: 'user', content: text })
      else {
        input.push({
          role: 'user',
          content: [
            ...documents.map((pdf) => ({ type: 'input_file' as const, filename: pdf.name, file_data: pdfUrl(pdf) })),
            ...(text ? [{ type: 'input_text' as const, text }] : []),
            ...images.map((image) => ({ type: 'input_image' as const, image_url: imageUrl(image), detail: 'auto' as const }))
          ]
        })
      }
    } else if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content })
    } else {
      // Encrypted reasoning only means something to the model that wrote it.
      const items = replayOf(message, request.connection, true)
      // A reply with a search in it goes back as it came only to a request that can search too.
      // Without the tool the search item may not be taken, and leaving out just that item would
      // part a reasoning item from what followed it. Such a reply then goes as another model's would.
      const searched = Array.isArray(items) && items.some((item) => (item as { type?: unknown }).type === 'web_search_call')
      if (Array.isArray(items) && (!searched || request.connection.webSearch)) {
        input.push(...(items as InputItem[]))
        continue
      }
      // A search of the reply's own is told in words: the model is to know it looked.
      const content = withSearchNote(message)
      if (content) input.push({ role: 'assistant', content })
      for (const call of message.tool_calls ?? []) {
        input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments, ...group })
      }
    }
  }
  return input
}

/** The tools as the Responses API takes them. */
export function responsesTools(request: Pick<ModelRequest, 'tools' | 'connection'>): OpenAI.Responses.Tool[] {
  const functions = request.tools.map((t) => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    // The tools' schemas are written for people, not to the strict subset.
    strict: false
  }))
  // The service's own web search, which it runs itself. It stands beside the group a plan wants.
  const search: OpenAI.Responses.Tool[] = request.connection.webSearch ? [{ type: 'web_search' }] : []
  if (functions.length === 0 || !request.connection.plan) return [...functions, ...search]
  return [{ type: 'namespace', name: TOOL_GROUP, description: TOOL_GROUP_ABOUT, tools: functions }, ...search]
}

/**
 * What the reply is to hold beyond its text. The pages a search found are only told by OpenAI's
 * API when asked for, with a key and with a ChatGPT plan alike; xAI tells them unasked. The plan
 * route took the field when tried with gpt-6.2-sol on 2026-11-24, and each search came back with
 * its pages (none without it).
 */
function includes(connection: Connection): OpenAI.Responses.ResponseIncludable[] {
  const own = Boolean(connection.plan) || /^https:\/\/api\.openai\.com(\/|$)/i.test(connection.baseURL)
  return ['reasoning.encrypted_content', ...(connection.webSearch && own ? (['web_search_call.action.sources'] as const) : [])]
}

/** Whether a rejected request was rejected for asking for reasoning summaries, which not every account may. */
function summaryRefused(err: unknown): boolean {
  if (!(err instanceof OpenAI.BadRequestError)) return false
  return err.param === 'reasoning.summary' || /reasoning\.summary|reasoning summar/i.test(err.message)
}

/** What the error codes of ChatGPT plan usage mean. */
const PLAN_ERRORS: Record<string, string> = {
  subscription_sharing_usage_limit_exceeded: 'The usage limit of your ChatGPT plan, or the limit set for this app, has been reached.',
  subscription_sharing_usage_unavailable: 'ChatGPT could not check the usage of your plan just now. Try again in a little while.',
  subscription_sharing_user_unavailable: 'ChatGPT plan usage is not available at the moment. Try again in a little while.',
  subscription_sharing_user_not_eligible: 'This ChatGPT account may not use its plan in other apps.',
  subscription_sharing_unsupported_capability: 'The request used something ChatGPT plan usage does not offer.',
  subscription_sharing_route_not_supported: 'ChatGPT plan usage does not cover this kind of request.',
  subscription_sharing_invalid_user: 'ChatGPT did not accept the sign-in for this request.',
  chatpass_v2_scope_not_authorized: 'The sign-in does not include the permission this request needs.',
  chatpass_v2_invalid_authorization_context: 'The sign-in does not include the permission this request needs.'
}
/** Refusals that come before a request is looked at, with no code to go by. */
const PLAN_STATUS: Record<number, string> = {
  401: 'ChatGPT did not accept the sign-in for this request.',
  403: 'ChatGPT does not allow plan usage for this request.',
  503: 'ChatGPT plan usage is not available at the moment. Try again in a little while.'
}

interface Failure {
  code?: string | null
  message?: string
  status?: number
  param?: string | null
  requestID?: string | null
}

/**
 * Words an error of ChatGPT plan usage. Nothing is retried and nothing falls back to another way
 * of paying: the error is shown, with what the service said (code, request id) kept for looking it up.
 */
function planFailure(failure: Failure): Error {
  const known = (failure.code && PLAN_ERRORS[failure.code]) || (failure.status && PLAN_STATUS[failure.status])
  const said = [
    failure.code,
    failure.param ? `in ${failure.param}` : '',
    failure.status ? `HTTP ${failure.status}` : '',
    failure.requestID ? `request ${failure.requestID}` : ''
  ].filter(Boolean)
  const detail = said.length ? ` (${said.join(', ')})` : ''
  const text = `${known || (failure.message ?? 'The service reported that the request failed.')}${detail}`
  if (failure.code === 'subscription_sharing_usage_limit_exceeded') return new ServiceError(text, 'chatgpt-usage', failure.status)
  // The status stays readable: a 401 is what makes the caller try a newer token.
  return Object.assign(new Error(text), failure.status ? { status: failure.status } : {})
}

/**
 * Whether a request was turned down for the service tier it named. Faster answers exist for some
 * models and accounts only, and the service says so in more than one shape: an error naming the
 * parameter, or a bare `{"detail": "Unsupported service_tier: ..."}`.
 */
function tierRefused(err: unknown): boolean {
  return err instanceof OpenAI.APIError && err.status === 400 && /service_tier/i.test(`${err.param ?? ''} ${err.message}`)
}

function clientFor(connection: Connection): OpenAI {
  return new OpenAI({
    apiKey: connection.apiKey,
    baseURL: connection.baseURL,
    // An error of plan usage means stop; trying again by itself is exactly what must not happen.
    ...(connection.plan ? { maxRetries: 0 } : {})
  })
}

/**
 * `levelRefused` is what the service said when it turned down the level of thinking of an earlier
 * attempt at this request, which is now made without one; the caller is told once it is taken.
 */
async function run(request: ModelRequest, withSummary: boolean, levelRefused?: string): Promise<ModelReply> {
  const { connection, signal } = request
  const client = clientFor(connection)
  const message = newReply(connection)
  const effort = connection.reasoningEffort
  const tools = responsesTools(request)
  const items: OutputItem[] = []
  const web = new WebLog(message, request.onWebActivity)
  let streamed = false
  let ended = false
  let stopped: string | undefined

  try {
    const wire = {
      model: connection.model,
      // Left out where there are none: a plain chat of someone who wrote no instructions of their own.
      ...(request.system ? { instructions: request.system } : {}),
      input: responsesInput(request),
      ...(tools.length ? { tools } : {}),
      reasoning: {
        ...(withSummary ? { summary: 'auto' as const } : {}),
        ...(effort !== 'default' ? { effort: effort as OpenAI.ReasoningEffort } : {})
      },
      // Without stored responses, this is what lets the model pick its reasoning up again after a tool call.
      include: includes(connection),
      // "Fast mode": the same model writing faster, at about twice the price. On the wire it goes by
      // its older name: the API takes both, a ChatGPT sign-in only this one ("fast" is refused there).
      ...(connection.fast ? { service_tier: 'priority' as const } : {}),
      // Which conversation this is, for a service that sends a conversation's requests to one
      // server by it. In this format xAI reads it from this field. OpenAI is not told: its models
      // from GPT-5.6 on find their cache without it, and by its documentation the key only fences
      // one conversation's cache off from the others. Tried with gpt-6.2-sol on 2026-11-23, it
      // changed no count: paid for by API key everything sent before was read from the cache
      // with the key and without, and paid for by a ChatGPT plan nothing was, either way.
      ...(request.conversation && routesByConversation(connection.baseURL) ? { prompt_cache_key: request.conversation } : {}),
      store: false,
      stream: true
      // Checked here, field by field: a name the API does not know is then a mistake the compiler sees.
    } satisfies OpenAI.Responses.ResponseCreateParamsStreaming
    request.probe?.sent(wire)
    const stream = await client.responses.create(wire, { signal })
    // Taken without the level it had turned down: it is known now that the level was all that was wrong.
    if (levelRefused !== undefined) request.onEffortRefused?.(levelRefused)
    levelRefused = undefined

    for await (const event of stream) {
      switch (event.type) {
        case 'response.output_text.delta':
        case 'response.refusal.delta':
          streamed = true
          request.probe?.arrived()
          message.content += event.delta
          request.onText(event.delta)
          break
        case 'response.reasoning_summary_part.added':
          // A summary comes in parts; set them apart like paragraphs.
          if (message.reasoning_content) {
            message.reasoning_content += '\n\n'
            request.onReasoning('\n\n')
          }
          break
        case 'response.reasoning_summary_text.delta':
          streamed = true
          request.probe?.arrived()
          message.reasoning_content = (message.reasoning_content ?? '') + event.delta
          request.onReasoning(event.delta)
          break
        case 'response.function_call_arguments.delta':
          // A reply that is nothing but a tool call has begun to come, too.
          request.probe?.arrived()
          break
        case 'response.output_item.added': {
          // A search of the service's own begins: shown as under way until it is done.
          const searching = responsesActivity(event.item)
          if (searching) {
            request.probe?.arrived()
            web.put(searching)
          }
          break
        }
        case 'response.output_item.done': {
          if (REPLAYED.has(event.item.type)) items.push(event.item)
          const searched = responsesActivity(event.item)
          if (searched) web.put(searched)
          break
        }
        case 'response.completed':
          ended = true
          request.probe?.usage(event.response.usage)
          request.probe?.finished(event.response.status ?? 'completed')
          break
        case 'response.incomplete': {
          ended = true
          const reason = event.response.incomplete_details?.reason
          request.probe?.usage(event.response.usage)
          request.probe?.finished(reason ?? 'incomplete')
          stopped =
            reason === 'max_output_tokens'
              ? 'The model ran out of output space before it finished.'
              : `The service ended the reply early${reason ? ` (${reason})` : ''}.`
          break
        }
        case 'response.failed': {
          const error = event.response.error
          if (connection.plan) throw planFailure({ code: error?.code, message: error?.message })
          throw new Error(error?.message ?? 'The service reported that the request failed.')
        }
        case 'error':
          if (connection.plan) throw planFailure({ code: event.code, message: event.message, param: event.param })
          throw new Error(event.message)
      }
    }
    // A reply counts only once the service has said it is complete; a stream that just stops is a lost connection.
    if (!ended) throw new Error('The connection to the service ended before the reply was complete.')
  } catch (err) {
    // A stop request keeps whatever text arrived; unfinished tool calls are dropped.
    if (signal.aborted) return { message }
    // Nothing reached the user yet, so the request can simply be made again without the summary.
    if (withSummary && !streamed && summaryRefused(err)) return run(request, false, levelRefused)
    // Likewise without the faster answers, which this model or account turns out not to have.
    if (connection.fast && !streamed && tierRefused(err)) {
      request.onFastRefused?.()
      return run({ ...request, connection: { ...connection, fast: false } }, withSummary, levelRefused)
    }
    // And without the level of thinking, where the model turns out to take none, or not that one.
    if (effort !== 'default' && !streamed && refusesEffort(err)) {
      return run({ ...request, connection: { ...connection, reasoningEffort: 'default' } }, withSummary, (err as Error).message)
    }
    // The PDFs were what the service turned down: the caller can send the message again with those told of by where they lie.
    if (!streamed && carriesDocuments(request) && refusesDocuments(err)) throw new DocumentsRefused((err as Error).message)
    // The pictures were what the service turned down: the caller can send the message again with those told in words.
    if (!streamed && carriesImages(request) && refusesImages(err)) throw new ImagesRefused((err as Error).message)
    if (connection.plan && err instanceof OpenAI.APIError) {
      throw planFailure({ code: err.code, message: err.message, status: err.status, param: err.param, requestID: err.requestID })
    }
    throw err
  }

  const calls: ToolCall[] = []
  for (const item of items) {
    if (item.type === 'function_call') calls.push({ id: item.call_id, name: item.name, arguments: item.arguments })
  }
  // Cut short, a tool call may be missing part of its arguments: it is kept out of the conversation.
  if (stopped) return { message, stopped }
  if (calls.length) message.tool_calls = calls
  if (message.origin && items.length) message.origin.replay = items
  return { message }
}

export const responsesAdapter: ProviderAdapter = {
  complete: (request) => run(request, true),
  // A signed-in account is told its models in a list of its own.
  listModels: (connection) => (connection.plan ? listPlanModels(connection) : listModels(connection)),
  modelInfo: (connection) => (connection.plan ? fetchPlanModelInfo(connection) : fetchModelInfo(connection))
}
