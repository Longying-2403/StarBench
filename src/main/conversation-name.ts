// The name a model service is given for a conversation.

import { createHash } from 'node:crypto'

/**
 * The name a model service is given for a conversation, where it wants one to send all of the
 * conversation's requests to the same server (`ModelRequest.conversation`). Made from the id the
 * conversation is saved under, so that it stays the same from message to message and after a
 * restart, without being that id or telling anything else about the conversation.
 */
export function conversationName(sessionId: string): string {
  return createHash('sha256').update(`starbench:${sessionId}`).digest('hex').slice(0, 32)
}
