// Asks an OpenAI-compatible service which models it has and what it knows about one of them,
// so the app can show the real version name and offer the thinking levels the model accepts.
// Nothing in this file depends on Electron.

import OpenAI from 'openai'
import { isReasoningEffort } from '../shared/types.ts'
import type { EffortLevel, ModelChoice, ModelInfo } from '../shared/types.ts'

const TIMEOUT_MS = 8000

type Service = { apiKey: string; baseURL: string }

const isLevel = (value: unknown): value is EffortLevel => isReasoningEffort(value) && value !== 'default'

/** Model lists also hold models that cannot hold a conversation; their names give them away. */
const NOT_FOR_CHAT = /embed|whisper|tts|speech|transcri|dall-e|image|imagine|audio|realtime|moderation|video|sora|babbage|davinci|rerank/i

const nameOf = (raw: Record<string, unknown>): string | undefined => {
  // Some services call the readable name `display_name`.
  const name = [raw.name, raw.display_name].find((v) => typeof v === 'string' && v.trim())
  return typeof name === 'string' ? name.trim().slice(0, 80) : undefined
}

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

  const name = nameOf(raw)
  if (name) info.name = name

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

async function entries(service: Service): Promise<Record<string, unknown>[]> {
  const client = new OpenAI({ apiKey: service.apiKey, baseURL: service.baseURL, timeout: TIMEOUT_MS, maxRetries: 0 })
  const page = await client.models.list()
  const data: unknown[] = Array.isArray(page.data) ? page.data : []
  return data.filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
}

/**
 * Looks `model` up in the service's model list. Resolves to null when the list has no usable
 * entry for it; rejects when the list cannot be fetched at all (no such endpoint, bad key, offline).
 */
export async function fetchModelInfo(connection: Service & { model: string }): Promise<ModelInfo | null> {
  return parseModelInfo((await entries(connection)).find((m) => m.id === connection.model))
}

/** The models of a service that can hold a conversation, in the order the service lists them. */
export async function listModels(service: Service): Promise<ModelChoice[]> {
  const choices: ModelChoice[] = []
  for (const entry of await entries(service)) {
    if (typeof entry.id !== 'string' || !entry.id || NOT_FOR_CHAT.test(entry.id)) continue
    const name = nameOf(entry)
    choices.push({ id: entry.id, ...(name ? { name } : {}) })
  }
  return choices
}

/**
 * The models a signed-in ChatGPT account may use with its plan, in the service's order. Asked
 * with the account's token, the same address answers in another shape:
 * `{ models: [{ slug, display_name, visibility }] }`, of which the entries meant to be listed are kept.
 */
export async function listPlanModels(service: Service): Promise<ModelChoice[]> {
  const client = new OpenAI({ apiKey: service.apiKey, baseURL: service.baseURL, timeout: TIMEOUT_MS, maxRetries: 0 })
  const body: unknown = await client.get('/models')
  const listed = typeof body === 'object' && body !== null ? (body as { models?: unknown }).models : undefined
  if (!Array.isArray(listed)) throw new Error('The service did not answer with a list of models.')
  const choices: ModelChoice[] = []
  for (const entry of listed as Record<string, unknown>[]) {
    if (typeof entry !== 'object' || entry === null || entry.visibility !== 'list') continue
    if (typeof entry.slug !== 'string' || !entry.slug) continue
    const name = nameOf(entry)
    choices.push({ id: entry.slug, ...(name ? { name } : {}) })
  }
  return choices
}

/** The readable name of a model of a signed-in ChatGPT account. That list says nothing about thinking levels. */
export async function fetchPlanModelInfo(connection: Service & { model: string }): Promise<ModelInfo | null> {
  const name = (await listPlanModels(connection)).find((m) => m.id === connection.model)?.name
  return name ? { name } : null
}
