// Measures one request to a model while it runs: how long it took, when the first piece of the
// reply came, what the service said it cost, and a guess at what the parts of the request weigh.
// Light enough to run for every request: nothing of the request is copied. (trace.ts makes the
// full record of a request, and only while a plugin watches.)
// Nothing in this file depends on Electron.

import { IMAGE_TOKENS } from '../shared/attachments.ts'
import { SUMMARY_CLOSE, SUMMARY_OPEN } from '../shared/compaction.ts'
import { estimateTokens, normalizeUsage } from '../shared/stats.ts'
import type { ContextParts, StepMeasure } from '../shared/stats.ts'
import type { ChatMessage } from '../shared/types.ts'
import type { Connection, ModelRequest } from './providers/types.ts'

export interface StepMeter {
  /**
   * The request with the measuring put in. Whoever was listening to the request before (a
   * plugin's watch) still hears everything. Called again when the request is sent a second time.
   */
  over(request: ModelRequest): ModelRequest
  /** What was measured, once the reply has ended. */
  done(): StepMeasure
}

/** What the meter is told of a request beyond the request itself, to tell its parts apart. */
export interface MeterHints {
  /** The person's own instructions, as they stand among the app's. */
  custom?: string
  /** What the app puts after the instructions: the list of skills. */
  skills?: string
  /** Where a tool comes from: the app itself, a plugin, or an MCP server. Taken for the app's own where nothing is said. */
  toolKind?(name: string): 'builtin' | 'plugin' | 'mcp'
}

/**
 * A guess at what one message weighs as it is sent, by what it is: what was said, the summary of
 * a compacted conversation that a user message begins with (main/compaction.ts), and tool calls
 * with what the tools returned.
 */
export function messageWeight(message: ChatMessage): { said: number; summary: number; tools: number } {
  if (message.role === 'tool') return { said: 0, summary: 0, tools: estimateTokens(message.content) }
  if (message.role === 'assistant') {
    const tools = (message.tool_calls ?? []).reduce((sum, call) => sum + estimateTokens(call.name) + estimateTokens(call.arguments), 0)
    return { said: estimateTokens(message.content), summary: 0, tools }
  }
  // What goes in front of what was typed: the text of a picked skill, and of the files put with the message. A picture weighs about the same whatever it shows.
  const files = (message.attachments ?? []).reduce((sum, file) => sum + (file.kind === 'text' ? estimateTokens(file.text) : IMAGE_TOKENS), 0)
  const skill = (message.skill ? estimateTokens(message.skill.prompt) : 0) + files
  // The summary itself never holds the closing tag (it is taken out when the summary is put together).
  const end = message.content.startsWith(SUMMARY_OPEN) ? message.content.indexOf(SUMMARY_CLOSE) : -1
  if (end < 0) return { said: estimateTokens(message.content) + skill, summary: 0, tools: 0 }
  const cut = end + SUMMARY_CLOSE.length
  return { said: estimateTokens(message.content.slice(cut)) + skill, summary: estimateTokens(message.content.slice(0, cut)), tools: 0 }
}

/** A guess at the weight of what a request carries, part by part. A part that weighs nothing is left out. */
export function weigh(request: Pick<ModelRequest, 'system' | 'messages' | 'tools'>, hints: MeterHints = {}): ContextParts {
  let messages = 0
  let summary = 0
  let toolResults = 0
  for (const message of request.messages) {
    const weight = messageWeight(message)
    messages += weight.said
    summary += weight.summary
    toolResults += weight.tools
  }
  const tools = { builtin: 0, plugin: 0, mcp: 0 }
  for (const tool of request.tools) {
    tools[hints.toolKind?.(tool.name) ?? 'builtin'] += estimateTokens(tool.name) + estimateTokens(tool.description) + estimateTokens(JSON.stringify(tool.parameters ?? {}))
  }
  // Of the instructions, what is the person's and what is the list of skills is taken out of the
  // whole, as far as it stands in them.
  const within = (text: string | undefined): number => (text?.trim() && request.system.includes(text.trim()) ? estimateTokens(text.trim()) : 0)
  const custom = within(hints.custom)
  const skills = within(hints.skills)
  const parts: ContextParts = {
    messages,
    summary,
    toolResults,
    tools: tools.builtin,
    pluginTools: tools.plugin,
    mcpTools: tools.mcp,
    system: Math.max(0, estimateTokens(request.system) - custom - skills),
    custom,
    skills
  }
  return Object.fromEntries(Object.entries(parts).filter(([, tokens]) => tokens > 0))
}

/** Starts to measure a request that is about to go to `connection`. */
export function meterStep(connection: Connection, hints: MeterHints = {}): StepMeter {
  const at = Date.now()
  /** When the first piece of a reply that comes in pieces arrived. The adapters say so; a reply in one piece never does. */
  let first: number | undefined
  let pieces = 0
  let usage: unknown
  let parts: ContextParts = {}
  let fresh = false
  return {
    over(request) {
      const inner = request.probe
      parts = weigh(request, hints)
      fresh = !request.messages.some((message) => message.role === 'assistant')
      return {
        ...request,
        // Its presence is also what has the adapter ask the service for the cost of a streamed reply.
        probe: {
          sent: (body, headers) => inner?.sent(body, headers),
          usage(told) {
            if (told !== undefined && told !== null) usage = told
            inner?.usage(told)
          },
          finished: (reason) => inner?.finished(reason),
          arrived() {
            first ??= Date.now() - at
            inner?.arrived()
          }
        },
        onText: (delta) => (pieces++, request.onText(delta)),
        onReasoning: (delta) => (pieces++, request.onReasoning(delta))
      }
    },
    done() {
      const told = normalizeUsage(connection.kind, usage)
      return {
        ms: Date.now() - at,
        ...(first !== undefined ? { firstMs: first } : {}),
        pieces,
        ...(told ? { usage: told } : {}),
        parts,
        ...(fresh ? { fresh: true } : {}),
        provider: connection.provider,
        model: connection.model
      }
    }
  }
}
