// The agent loop: send the conversation to the model, run the tools it asks for,
// feed the results back, repeat until it answers without tool calls.
// Nothing in this file depends on Electron.

import type { AgentEvent, ChatMessage, PermissionDecision, ToolCall } from '../shared/types.ts'
import { adapterFor } from './providers/index.ts'
import type { Connection, ModelReply, ModelRequest, ProviderAdapter } from './providers/index.ts'
import { ServiceError, ToolsRefused } from './providers/types.ts'
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
  /** The model is already known to take no tools: none are offered, and it is told that it has none. */
  withoutTools?: boolean
  /** Called when the model turned out to take no tools and the turn went on without them, so later turns can start that way. */
  onToolsRefused?(): void
  /**
   * Called when the server turned out not to stream replies while tools are offered, so later
   * turns can ask for whole replies from the start (`connection.wholeReplies`).
   */
  onStreamRefused?(): void
}

/** The date where the person is. Told to the model as it stands on their calendar, not as it is in Greenwich. */
export function today(now = new Date()): string {
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`
}

/** What a model is told when it cannot call tools: it can talk, and must not pretend to do more. */
function chatOnlyPrompt(): string {
  return [
    'You are an assistant running inside a desktop app on the user\'s computer.',
    'The model you run on cannot call tools in this app, so you cannot read or change files and cannot run commands. Never claim that you did.',
    'Help with what can be answered from the conversation itself. When a request needs access to files or commands, say that it needs a model that supports tool calling.',
    '',
    `Operating system: ${process.platform}`,
    `Today's date: ${today()}`,
    '',
    'Answer in the language the user writes in.'
  ].join('\n')
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
    `Today's date: ${today()}`,
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
  let withoutTools = opts.withoutTools ?? false

  /** The next request, as things stand now. */
  const request = (): ModelRequest => ({
    connection,
    // The extra text describes skills, which are loaded with a tool.
    system: withoutTools ? chatOnlyPrompt() : systemPrompt(opts.workspace, opts.systemExtra),
    messages: stored,
    tools: withoutTools ? [] : opts.tools.specs(),
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
    },
    onStreamRefused: () => {
      // Asked for in one piece from here on: streaming would fail again at every step.
      connection = { ...connection, wholeReplies: true }
      opts.emit({
        type: 'notice',
        code: 'stream-refused',
        message: 'This model server cannot stream a reply while tools are offered, so each reply appears all at once when it is finished. Nothing moving for a while is normal.'
      })
      opts.onStreamRefused?.()
    }
  })

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const { message: assistant, stopped } = await ask(adapter, request()).catch((err: unknown) => {
        if (!(err instanceof ToolsRefused) || withoutTools) throw err
        // The model takes no tools. The message goes out again as plain conversation, and the
        // person is told what that means; the service's own words go along for looking it up.
        withoutTools = true
        opts.emit({
          type: 'notice',
          code: 'tools-refused',
          message: 'This model, or the server running it, does not support tool calling, so it can only chat here: it cannot read or change files or run commands.',
          detail: err.message
        })
        opts.onToolsRefused?.()
        return ask(adapter, request())
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
