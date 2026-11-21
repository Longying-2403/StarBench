// OpenAI-compatible chat completions: DeepSeek, xAI and most other services.

import OpenAI from 'openai'
import type { ToolCall } from '../../shared/types.ts'
import { fetchModelInfo, listModels } from '../models.ts'
import { newReply, userText, withToolResults } from './history.ts'
import type { ModelReply, ModelRequest, ProviderAdapter } from './types.ts'

type ApiMessage = OpenAI.Chat.ChatCompletionMessageParam

/** The conversation as chat completions take it. */
export function chatMessages(request: Pick<ModelRequest, 'messages' | 'connection' | 'system'>): ApiMessage[] {
  const out: ApiMessage[] = [{ role: 'system', content: request.system }]
  for (const message of withToolResults(request.messages)) {
    if (message.role === 'user') {
      out.push({ role: 'user', content: userText(message) })
    } else if (message.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: message.tool_call_id, content: message.content })
    } else {
      // DeepSeek wants its own reasoning back on every assistant message when tools are in the
      // request. Reasoning another service wrote is left out: it means nothing here and an
      // unknown field can be refused. Messages from before origins were recorded are this service's.
      const own = !message.origin || message.origin.provider === request.connection.provider
      out.push({
        role: 'assistant',
        content: message.content,
        // reasoning_content is not in the SDK's message type.
        ...(own && message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
        ...(message.tool_calls?.length
          ? {
              tool_calls: message.tool_calls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: c.arguments }
              }))
            }
          : {})
      } as ApiMessage)
    }
  }
  return out
}

export const chatAdapter: ProviderAdapter = {
  async complete(request: ModelRequest): Promise<ModelReply> {
    const { connection, signal } = request
    const client = new OpenAI({ apiKey: connection.apiKey, baseURL: connection.baseURL })
    const message = newReply(connection)
    const calls: ToolCall[] = []
    const effort = connection.reasoningEffort
    let cutShort = false
    try {
      const stream = await client.chat.completions.create(
        {
          model: connection.model,
          messages: chatMessages(request),
          // The API rejects an empty tools array.
          ...(request.tools.length
            ? { tools: request.tools.map((t) => ({ type: 'function' as const, function: { ...t } })) }
            : {}),
          // Left out unless the user chose a level: not every compatible service knows the parameter.
          // The cast is for levels the SDK's list does not have but some services do.
          ...(effort !== 'default' ? { reasoning_effort: effort as OpenAI.ReasoningEffort } : {}),
          stream: true
        },
        { signal }
      )
      for await (const chunk of stream) {
        const choice = chunk.choices[0]
        if (choice?.finish_reason === 'length') cutShort = true
        const delta = choice?.delta as
          | (OpenAI.Chat.ChatCompletionChunk.Choice.Delta & { reasoning_content?: string | null })
          | undefined
        if (!delta) continue
        if (delta.reasoning_content) {
          message.reasoning_content = (message.reasoning_content ?? '') + delta.reasoning_content
          request.onReasoning(delta.reasoning_content)
        }
        if (delta.content) {
          message.content += delta.content
          request.onText(delta.content)
        }
        for (const part of delta.tool_calls ?? []) {
          const call = (calls[part.index] ??= { id: '', name: '', arguments: '' })
          if (part.id) call.id = part.id
          if (part.function?.name) call.name += part.function.name
          if (part.function?.arguments) call.arguments += part.function.arguments
        }
      }
    } catch (err) {
      // A stop request keeps whatever text arrived; half-received tool calls are dropped.
      if (!signal.aborted) throw err
      return { message }
    }
    const complete = calls.filter((c) => c && c.id && c.name)
    if (complete.length) message.tool_calls = complete
    // Cut off in the middle of a tool call, its arguments are incomplete: running it would act on half an input.
    if (cutShort && complete.length) {
      delete message.tool_calls
      return { message, stopped: 'The model ran out of output space in the middle of a tool call, so the call was not run.' }
    }
    return { message }
  },

  listModels: (connection) => listModels(connection),
  modelInfo: (connection) => fetchModelInfo(connection)
}
