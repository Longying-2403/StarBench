// The agent loop: send the conversation to the model, run the tools it asks for,
// feed the results back, repeat until it answers without tool calls.
// Nothing in this file depends on Electron.

import OpenAI from 'openai'
import type { AgentEvent, ChatMessage, PermissionDecision, ToolCall } from '../shared/types.ts'
import type { ToolRegistry } from './tools.ts'

const MAX_STEPS = 50

export interface TurnOptions {
  apiKey: string
  baseURL: string
  model: string
  workspace: string
  /** Conversation so far, ending with the new user message. Mutated in place as the turn proceeds. */
  messages: ChatMessage[]
  /** Extra system prompt text, such as the list of available skills. */
  systemExtra?: string
  signal: AbortSignal
  /** Read on every model request, so tools added mid-turn are picked up at the next step. */
  tools: Pick<ToolRegistry, 'definitions' | 'needsPermission' | 'execute'>
  /** Tool names the user chose to always allow; owned by the caller so it outlives one turn. */
  alwaysAllowed: Set<string>
  emit(event: AgentEvent): void
  /** Asks the user whether a tool call may run. */
  requestPermission(call: ToolCall): Promise<PermissionDecision>
  /** Called whenever `messages` reached a consistent state worth persisting. */
  checkpoint(): void
}

function systemPrompt(workspace: string, extra?: string): string {
  const shell = process.platform === 'win32' ? 'PowerShell' : '/bin/sh'
  const base = [
    'You are a coding agent running inside a desktop app on the user\'s computer.',
    'You help with software tasks by reading and editing files and running commands through the provided tools.',
    '',
    `Workspace root: ${workspace}`,
    `Operating system: ${process.platform}`,
    `Shell used by run_command: ${shell}`,
    `Today's date: ${new Date().toISOString().slice(0, 10)}`,
    '',
    'Guidelines:',
    '- All file paths are relative to the workspace root; you cannot access files outside it.',
    '- Look before you change: read a file before editing it, and inspect the project before making assumptions.',
    '- Prefer edit_file for changes to existing files; use write_file for new files.',
    '- The user approves file changes and commands individually. If a request is denied, do not retry it unchanged; adjust or ask.',
    '- When the work is done, reply with a short summary of what changed. Answer in the language the user writes in.'
  ].join('\n')
  return extra ? `${base}\n\n${extra}` : base
}

/** Reads one streamed assistant message, emitting deltas as they arrive. */
async function streamAssistant(
  client: OpenAI,
  opts: TurnOptions
): Promise<Extract<ChatMessage, { role: 'assistant' }>> {
  const message: Extract<ChatMessage, { role: 'assistant' }> = { role: 'assistant', content: '' }
  const calls: ToolCall[] = []
  const tools = opts.tools.definitions()
  try {
    const stream = await client.chat.completions.create(
      {
        model: opts.model,
        // reasoning_content is not in the SDK's message type, but DeepSeek requires it
        // to be passed back on every assistant message when tools are in the request.
        messages: [
          { role: 'system', content: systemPrompt(opts.workspace, opts.systemExtra) },
          ...(opts.messages as unknown as OpenAI.Chat.ChatCompletionMessageParam[])
        ],
        // The API rejects an empty tools array.
        ...(tools.length ? { tools } : {}),
        stream: true
      },
      { signal: opts.signal }
    )
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta as
        | (OpenAI.Chat.ChatCompletionChunk.Choice.Delta & { reasoning_content?: string | null })
        | undefined
      if (!delta) continue
      if (delta.reasoning_content) {
        message.reasoning_content = (message.reasoning_content ?? '') + delta.reasoning_content
        opts.emit({ type: 'reasoning_delta', text: delta.reasoning_content })
      }
      if (delta.content) {
        message.content += delta.content
        opts.emit({ type: 'text_delta', text: delta.content })
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
    if (!opts.signal.aborted) throw err
    return message
  }
  const complete = calls.filter((c) => c && c.id && c.name)
  if (complete.length) message.tool_calls = complete
  return message
}

/** Converts a stored message into the shape the API expects. */
function toApiMessage(message: ChatMessage): ChatMessage {
  if (message.role === 'user') {
    // A skill the user picked travels in front of what they typed; the API knows no `skill` field.
    return { role: 'user', content: message.skill ? `${message.skill.prompt}\n\n${message.content}` : message.content }
  }
  // Stored tool calls are flat; the API wants them wrapped as { type, function }.
  if (message.role !== 'assistant' || !message.tool_calls) return message
  return {
    ...message,
    tool_calls: message.tool_calls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: c.arguments }
    }))
  } as unknown as ChatMessage
}

/** Result texts the UI recognises to label a call as cancelled or refused. */
const CANCELLED = 'Cancelled by user'
const DENIED = 'The user denied this tool call.'

/** Produces the result of one tool call. Always resolves: every call needs a result, or the next request is rejected. */
async function runToolCall(call: ToolCall, opts: TurnOptions): Promise<string> {
  if (opts.signal.aborted) return CANCELLED
  if (opts.tools.needsPermission(call.name) && !opts.alwaysAllowed.has(call.name)) {
    const decision = await opts.requestPermission(call)
    // A stop while the prompt was open ends the wait; that is a cancellation, not a refusal.
    if (opts.signal.aborted) return CANCELLED
    if (decision === 'deny') return DENIED
    if (decision === 'always') opts.alwaysAllowed.add(call.name)
  }
  return opts.tools.execute(call.name, call.arguments, { workspace: opts.workspace, signal: opts.signal })
}

export async function runTurn(opts: TurnOptions): Promise<void> {
  const client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL })
  const stored = opts.messages

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const assistant = await streamAssistant(client, { ...opts, messages: stored.map(toApiMessage) })
      if (assistant.content || assistant.tool_calls || assistant.reasoning_content) stored.push(assistant)
      opts.emit({ type: 'assistant_done' })
      opts.checkpoint()
      if (!assistant.tool_calls || opts.signal.aborted) return

      for (const call of assistant.tool_calls) {
        opts.emit({ type: 'tool_start', call })
        const output = await runToolCall(call, opts)
        stored.push({ role: 'tool', tool_call_id: call.id, content: output })
        opts.emit({ type: 'tool_result', id: call.id, output })
      }
      opts.checkpoint()
      if (opts.signal.aborted) return
    }
    opts.emit({ type: 'error', message: `Stopped after ${MAX_STEPS} steps without finishing.` })
  } catch (err) {
    opts.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  } finally {
    opts.checkpoint()
    opts.emit({ type: 'turn_end' })
  }
}
