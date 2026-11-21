// Asks the model service what it knows about the configured model, so the app can show
// the real version name and offer the thinking levels the model accepts.
// Nothing in this file depends on Electron.

import OpenAI from 'openai'
import { isReasoningEffort } from '../shared/types.ts'
import type { ModelInfo, ReasoningEffort } from '../shared/types.ts'

const TIMEOUT_MS = 8000

const isLevel = (value: unknown): value is Exclude<ReasoningEffort, 'default'> =>
  isReasoningEffort(value) && value !== 'default'

/**
 * Picks what the app can use out of one entry of a model list. Services return different
 * shapes, so every field is checked and anything unknown is dropped. Resolves to null when
 * nothing usable is left.
 *
 * DeepSeek, for example, returns
 * `{ id, name: "DeepSeek-V4.1-Flash", effort: { supported_levels: ["low","high","max"], default_level: "high" } }`.
 */
export function parseModelInfo(entry: unknown): ModelInfo | null {
  if (typeof entry !== 'object' || entry === null) return null
  const raw = entry as Record<string, unknown>
  const info: ModelInfo = {}

  // Some services call the readable name `display_name`.
  const name = [raw.name, raw.display_name].find((v) => typeof v === 'string' && v.trim())
  if (typeof name === 'string') info.name = name.trim().slice(0, 80)

  if (typeof raw.effort === 'object' && raw.effort !== null) {
    const { supported_levels: levels, default_level: fallback } = raw.effort as Record<string, unknown>
    if (Array.isArray(levels)) {
      const known = levels.filter(isLevel)
      if (known.length > 0) info.efforts = known
    }
    if (isLevel(fallback)) info.defaultEffort = fallback
  }

  return info.name || info.efforts || info.defaultEffort ? info : null
}

/**
 * Looks `model` up in the service's model list. Resolves to null when the list has no usable
 * entry for it; rejects when the list cannot be fetched at all (no such endpoint, bad key, offline).
 */
export async function fetchModelInfo(connection: { apiKey: string; baseURL: string; model: string }): Promise<ModelInfo | null> {
  const client = new OpenAI({ apiKey: connection.apiKey, baseURL: connection.baseURL, timeout: TIMEOUT_MS, maxRetries: 0 })
  const page = await client.models.list()
  const entries: unknown[] = Array.isArray(page.data) ? page.data : []
  return parseModelInfo(entries.find((m) => typeof m === 'object' && m !== null && (m as { id?: unknown }).id === connection.model))
}
