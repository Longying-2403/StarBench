// The level of thinking a well-known model starts at. Such a model has no "nothing chosen": the
// slider rests on this level from the first, and the level is sent like one the person chose, so
// that what is shown is what is used. A model that is not here keeps "nothing chosen": nothing
// is sent for it and the service decides, since there are models that take no level at all and
// refuse a request that names one.
//
// The levels are the defaults the services' documentation stated on 2026-11-23:
//   OpenAI     https://developers.openai.com/api/docs/guides/reasoning
//   Anthropic  https://platform.claude.com/docs/en/build-with-claude/effort
//   xAI        https://docs.x.ai/docs/guides/reasoning
//   DeepSeek   https://api-docs.deepseek.com/guides/thinking_mode
// For the models of the GPT-6 family whose default it does not state (GPT-6.2 Sol and Astra,
// GPT-6.1 Terra), "medium" is the app's own choice: it is the default of the others of the
// family, and it is sent, so it holds whatever the service would have done by itself.
// Nothing is guessed from a name that merely looks like a known one.

import { isLocalAddress, usualEfforts } from './types.ts'
import type { EffortLevel, ProviderKind } from './types.ts'

/** Each with the start of the model ids it stands for. The first that fits counts. */
const PRESETS: readonly (readonly [RegExp, EffortLevel])[] = [
  [/^gpt-6(\.\d+)?-(sol|astra|terra|luna)\b/, 'medium'],
  [/^gpt-5\.6\b/, 'medium'],
  // The model itself and its dated snapshots; of its "pro" nothing is said.
  [/^gpt-5\.5(-\d|$)/, 'medium'],

  // Two of the family think less by default than the rest, so they come first.
  [/^claude-(opus|haiku)-5-5\b/, 'medium'],
  [/^claude-(fable|mythos)-5\b/, 'high'],
  [/^claude-sonnet-(5|4-6)\b/, 'high'],
  [/^claude-opus-(5|4-[5678])\b/, 'high'],

  [/^grok-4\.(5|6|7)\b/, 'high'],

  [/^deepseek-(flash|v4-flash|v4-pro)\b/, 'high']
]

/**
 * The level a well-known model starts at, going by its id alone. The id is taken as services and
 * gateways write it: in any case, and with what a gateway puts before the name
 * (`anthropic/claude-…`) left off.
 */
export function presetEffort(model: string): EffortLevel | undefined {
  const id = model.trim().toLowerCase().split('/').pop() ?? ''
  return PRESETS.find(([name]) => name.test(id))?.[1]
}

/**
 * The level a model starts at with the service it is reached through, where it has one: the
 * model is a well-known one, and the level is among those the service offers. A server on one's
 * own machine has none, whatever its model is called: what it does with a level is its own affair.
 */
export function startingEffort(provider: { model: string; baseURL: string; kind?: ProviderKind }): EffortLevel | undefined {
  if (isLocalAddress(provider.baseURL)) return undefined
  const preset = presetEffort(provider.model)
  return preset && usualEfforts(provider.baseURL, provider.kind).includes(preset) ? preset : undefined
}
