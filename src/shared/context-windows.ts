// How many tokens the context of a well-known model holds, for the services that do not say so
// in their list of models. Used last: what the person typed in for a model counts first, and
// what the service itself says second (see the `models:info` handler in main/index.ts).
//
// The numbers are those the services published on 2026-11-22:
//   DeepSeek   https://api-docs.deepseek.com/quick_start/pricing   (one figure given for both models)
//   OpenAI     https://developers.openai.com/api/docs/models       (the "context window" of each model)
//   xAI        https://docs.x.ai/docs/models                       (written there as "500k" and "1M")
//   Anthropic  its Models API, which the app asks itself; listed here for a gateway that does not pass it on
// A model that is not here has no known size, and the person can type one in. Models come and
// go: an entry is a name as far as it is known to mean one size, and nothing is guessed from a
// name that merely looks alike.

const K = 1000
const M = 1_000_000

/** Each with the start of the model ids it stands for. The first that fits counts. */
const KNOWN: readonly (readonly [RegExp, number])[] = [
  [/^deepseek-(flash|v4-flash|v4-pro)\b/, 1 * M],

  [/^gpt-6(\.\d+)?-(astra|sol|terra|luna)\b/, 1050 * K],

  [/^grok-4\.(5|6|7)\b/, 500 * K],
  [/^grok-build-0\.1\b/, 500 * K],
  [/^grok-4\.3\b/, 1 * M],
  [/^grok-4\.20-/, 1 * M],

  [/^claude-haiku-4-5\b/, 200 * K],
  [/^claude-(fable|mythos)-5\b/, 1 * M],
  [/^claude-opus-(5|4-[678])\b/, 1 * M],
  [/^claude-sonnet-(5|4-6)\b/, 1 * M],
  [/^claude-haiku-5-5\b/, 1 * M]
]

/**
 * The size of a well-known model's context, in tokens. The id is taken as services and gateways
 * write it: in any case, and with what a gateway puts before the name (`openai/gpt-…`) left off.
 */
export function knownContextWindow(model: string): number | undefined {
  const id = model.trim().toLowerCase().split('/').pop() ?? ''
  return KNOWN.find(([name]) => name.test(id))?.[1]
}
