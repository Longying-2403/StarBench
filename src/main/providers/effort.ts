// What the two OpenAI formats do about a level of thinking the service will not take. They send
// the level the person chose as it is: unlike Anthropic's and Gemini's, these services do not say
// beforehand which levels a model takes, and many of their models take none.

/**
 * Whether an error is a service turning a request down for the level of thinking it names: the
 * model takes no level, or not that one, or the server knows no such field. What such refusals
 * have in common is that they name the parameter, each service in its own spelling:
 * `reasoning_effort` in chat completions, `reasoning.effort` in the Responses format, and xAI
 * says "Model grok-4.20-0309-non-reasoning does not support parameter reasoningEffort." (seen
 * 2026-11-25). Only asked about a request that did name a level, and only of an error that says
 * the request itself was at fault: not a wrong key, and not a limit that was reached.
 */
export function refusesEffort(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const { status, message, param } = err as { status?: unknown; message?: unknown; param?: unknown }
  if (typeof status !== 'number' || status < 400 || status >= 500 || [401, 403, 404, 408, 429].includes(status)) return false
  // Some services name the parameter beside the message and not in it.
  const said = `${typeof param === 'string' ? param : ''} ${typeof message === 'string' ? message : ''}`
  return /reasoning[\s_.-]?effort/i.test(said)
}
