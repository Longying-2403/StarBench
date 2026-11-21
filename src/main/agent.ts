// The agent loop: send the conversation to the model, run the tools it asks for,
// feed the results back, repeat until it answers without tool calls.
// Nothing in this file depends on Electron.

import type { AgentEvent, ChatMessage, PermissionDecision, ToolCall } from '../shared/types.ts'
import { adapterFor } from './providers/index.ts'
import type { Connection, ModelReply, ModelRequest, ProviderAdapter } from './providers/index.ts'
import { ServiceError } from './providers/types.ts'
import type { ToolRegistry } from './tools.ts'

const MAX_STEPS = 50

export interface TurnOptions {
  /** The provider and model this turn talks to. */
  connection: Connection
  workspace: string
  /** Conversation so far, ending with the new user message. Mutated in place as the turn proceeds. */
  messages: ChatMessage[]
  /** Extra system prompt text, such as the list of available skills. */
  systemExtra?: string
  signal: AbortSignal
  /** Read on every model request, so tools added mid-turn are picked up at the next step. */
  tools: Pick<ToolRegistry, 'specs' | 'needsPermission' | 'execute'>
  /** Tool names the user chose to always allow; owned by the caller so it outlives one turn. */
  alwaysAllowed: Set<string>
  emit(event: AgentEvent): void
  /** Asks the user whether a tool call may run. */
  requestPermission(call: ToolCall): Promise<PermissionDecision>
  /** Called whenever `messages` reached a consistent state worth persisting. */
  checkpoint(): void
  /** Called when the service would not give this model the faster answers that were asked for, so the choice can be taken back. */
  onFastRefused?(): void
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

const statusOf = (err: unknown): unknown => (typeof err === 'object' && err !== null ? (err as { status?: unknown }).status : undefined)

/**
 * Makes one request to the model. A provider that is signed in to is asked for a token that is
 * good now; should the service turn that one down before anything arrived, a new one is
 * fetched and the request made once more.
 */
async function ask(adapter: ProviderAdapter, request: ModelRequest): Promise<ModelReply> {
  const { plan } = request.connection
  if (!plan) return adapter.complete(request)
  let arrived = false
  const withToken = (apiKey: string): ModelRequest => ({
    ...request,
    connection: { ...request.connection, apiKey },
    onText: (delta) => ((arrived = true), request.onText(delta)),
    onReasoning: (delta) => ((arrived = true), request.onReasoning(delta))
  })
  const token = await plan.token()
  try {
    return await adapter.complete(withToken(token))
  } catch (err) {
    if (statusOf(err) !== 401 || arrived || request.signal.aborted) throw err
    const fresh = await plan.token(token)
    // The same token again means there was no newer one to be had.
    if (fresh === token) throw err
    return adapter.complete(withToken(fresh))
  }
}

export async function runTurn(opts: TurnOptions): Promise<void> {
  const adapter = adapterFor(opts.connection.kind)
  const stored = opts.messages
  let connection = opts.connection

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const { message: assistant, stopped } = await ask(adapter, {
        connection,
        system: systemPrompt(opts.workspace, opts.systemExtra),
        messages: stored,
        tools: opts.tools.specs(),
        signal: opts.signal,
        onText: (text) => opts.emit({ type: 'text_delta', text }),
        onReasoning: (text) => opts.emit({ type: 'reasoning_delta', text }),
        onFastRefused: () => {
          // Not asked again for the rest of the turn: it would be refused at every step.
          connection = { ...connection, fast: false }
          opts.emit({
            type: 'notice',
            code: 'fast-mode-refused',
            message: 'The service does not offer Fast Mode for this model here. It was switched off and the message sent at the usual speed.'
          })
          opts.onFastRefused?.()
        }
      })
      if (assistant.content || assistant.tool_calls || assistant.reasoning_content) stored.push(assistant)
      opts.emit({ type: 'assistant_done' })
      opts.checkpoint()
      // The service declined, or cut the reply short: what came is kept, nothing in it is run.
      if (stopped) {
        opts.emit({ type: 'error', message: stopped })
        return
      }
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
    opts.emit({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
      ...(err instanceof ServiceError ? { hint: err.hint } : {})
    })
  } finally {
    opts.checkpoint()
    opts.emit({ type: 'turn_end' })
  }
}
