// The OpenAI Responses API. Requests are stateless (`store: false`): the whole conversation is
// sent each time, with the model's reasoning carried along in encrypted form.
//
// The same API serves requests paid for by a person's ChatGPT plan (`connection.plan`), with a
// few rules of its own, taken from
// https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations .

import OpenAI from 'openai'
import type { ToolCall } from '../../shared/types.ts'
import { fetchModelInfo, fetchPlanModelInfo, listModels, listPlanModels } from '../models.ts'
import { newReply, replayOf, userText, withToolResults } from './history.ts'
import { ServiceError } from './types.ts'
import type { Connection, ModelReply, ModelRequest, ProviderAdapter } from './types.ts'

type InputItem = OpenAI.Responses.ResponseInputItem
type OutputItem = OpenAI.Responses.ResponseOutputItem

/** The kinds of output this app produces and can hand back to the service as they came. */
const REPLAYED = new Set(['reasoning', 'message', 'function_call'])

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
      input.push({ role: 'user', content: userText(message) })
    } else if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content })
    } else {
      // Encrypted reasoning only means something to the model that wrote it.
      const items = replayOf(message, request.connection, true)
      if (Array.isArray(items)) {
        input.push(...(items as InputItem[]))
        continue
      }
      if (message.content) input.push({ role: 'assistant', content: message.content })
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
  if (functions.length === 0 || !request.connection.plan) return functions
  return [{ type: 'namespace', name: TOOL_GROUP, description: TOOL_GROUP_ABOUT, tools: functions }]
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
  // The one request field of this app's that is the person's own choice, and so theirs to take back.
  const advice = failure.param?.includes('service_tier') ? ' Turn Fast Mode off for this model and send the message again.' : ''
  const text = `${known || (failure.message ?? 'The service reported that the request failed.')}${advice}${detail}`
  if (failure.code === 'subscription_sharing_usage_limit_exceeded') return new ServiceError(text, 'chatgpt-usage', failure.status)
  // The status stays readable: a 401 is what makes the caller try a newer token.
  return Object.assign(new Error(text), failure.status ? { status: failure.status } : {})
}

function clientFor(connection: Connection): OpenAI {
  return new OpenAI({
    apiKey: connection.apiKey,
    baseURL: connection.baseURL,
    // An error of plan usage means stop; trying again by itself is exactly what must not happen.
    ...(connection.plan ? { maxRetries: 0 } : {})
  })
}

async function run(request: ModelRequest, withSummary: boolean): Promise<ModelReply> {
  const { connection, signal } = request
  const client = clientFor(connection)
  const message = newReply(connection)
  const effort = connection.reasoningEffort
  const tools = responsesTools(request)
  const items: OutputItem[] = []
  let streamed = false
  let ended = false
  let stopped: string | undefined

  try {
    const stream = await client.responses.create(
      {
        model: connection.model,
        instructions: request.system,
        input: responsesInput(request),
        ...(tools.length ? { tools } : {}),
        reasoning: {
          ...(withSummary ? { summary: 'auto' as const } : {}),
          ...(effort !== 'default' ? { effort: effort as OpenAI.ReasoningEffort } : {})
        },
        // Without stored responses, this is what lets the model pick its reasoning up again after a tool call.
        include: ['reasoning.encrypted_content'],
        // "Fast mode": the same model writing faster, at about twice the price. The service may still
        // answer at the usual speed (and price) when it has no room.
        ...(connection.fast ? { service_tier: 'fast' as const } : {}),
        store: false,
        stream: true
      },
      { signal }
    )

    for await (const event of stream) {
      switch (event.type) {
        case 'response.output_text.delta':
        case 'response.refusal.delta':
          streamed = true
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
          message.reasoning_content = (message.reasoning_content ?? '') + event.delta
          request.onReasoning(event.delta)
          break
        case 'response.output_item.done':
          if (REPLAYED.has(event.item.type)) items.push(event.item)
          break
        case 'response.completed':
          ended = true
          break
        case 'response.incomplete': {
          ended = true
          const reason = event.response.incomplete_details?.reason
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
    if (withSummary && !streamed && summaryRefused(err)) return run(request, false)
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
