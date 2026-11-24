// For the tests that look at what a turn kept of a reply.
import assert from 'node:assert/strict'
import type { StoredMessage } from '../src/shared/types.ts'

const started = Date.now()

/**
 * What was kept of a reply, without the moment it was finished at: that one is of the clock and
 * not of the reply. That it is there, and of this run, is checked here.
 */
export function keptReply(message: StoredMessage | undefined): object {
  assert.ok(message?.role === 'assistant', 'a reply was kept')
  const { at, ...rest } = message
  assert.ok(typeof at === 'number' && at >= started && at <= Date.now(), 'with the time it was finished at')
  return rest
}
