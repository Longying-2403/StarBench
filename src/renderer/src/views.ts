// The conversations the page holds at once. Several can be at work at the same time: the page
// shows one of them and goes on following the others, so that going back to one shows it as it
// stands by then. A view is kept for each conversation the page has on show, has sent a message
// to, or has heard at work, and every event goes to the view of the conversation it is of.
// Nothing here touches the page or the main process.

import type { Attachment } from '../../shared/attachments.ts'
import type { SessionStats } from '../../shared/stats.ts'
import type { AgentEvent } from '../../shared/types.ts'
import { itemsReducer } from './items.ts'
import type { Item } from './items.ts'

/** What the page holds of one conversation. */
export interface View {
  items: Item[]
  /** A turn of it is under way, or the app is at work on it otherwise (`betweenTurns`). */
  running: boolean
  /** The model is writing the summary of the conversation, which takes a while and shows nothing. */
  compacting: boolean
  /**
   * The app is at work on the conversation without a turn being under way: a compaction the person
   * asked for. The last turn is over all the same, and keeps the time it was finished at.
   */
  betweenTurns: boolean
  /** What was measured of the conversation, as far as the app has kept count of it. */
  stats: SessionStats | null
  /**
   * The page did not follow the turn under way from its start: the turn was begun elsewhere, or the
   * page was loaded anew while it ran. What the view shows of that turn may have gaps, so the
   * conversation is read from its file again once the turn is over.
   */
  partial: boolean
  /**
   * A turn of it ended while another conversation was on the page, and it has not been looked at
   * since. The view is kept until then, with whatever the turn ended in.
   */
  unseen: boolean
}

export const EMPTY_VIEW: View = { items: [], running: false, compacting: false, betweenTurns: false, stats: null, partial: false, unseen: false }

/** The views, each under the id of its conversation; a chat that has no id yet goes by a key of the page's own (`draftKey`). */
export type Views = Readonly<Record<string, View>>

/** The key of a chat that has not been sent yet, and so has no id. Each new chat gets one of its own: one that is being sent stays apart from the next. */
export const draftKey = (n: number): string => `draft:${n}`
export const isDraft = (key: string): boolean => key.startsWith('draft:')

export type ViewsAction =
  /** A conversation was read from its file. `running`: a turn of it is under way all the same, which the page did not follow from its start. */
  | { type: 'opened'; id: string; items: Item[]; stats: SessionStats | null; running: boolean }
  /** A new, empty chat. */
  | { type: 'draft'; key: string }
  /** The person sent a message: it shows at once, and the conversation is at work from then on. */
  | { type: 'user'; key: string; text: string; skill?: string; attachments?: Attachment[]; at: number }
  /** A chat that had no id was given one by the main process, which has begun its first turn. `onPage`: it is the conversation on show. */
  | { type: 'bound'; key: string; id: string; onPage: boolean }
  /** The message sent at `at` went out as a plain chat. */
  | { type: 'plain'; key: string; at: number }
  /** Something happened in a conversation. `onPage`: it is the one on show. */
  | { type: 'event'; key: string; event: AgentEvent; at?: number; onPage: boolean }
  /** The app began, or ended, work on a conversation that is no turn (a compaction the person asked for). */
  | { type: 'work'; key: string; on: boolean }
  /** A message could not be sent. */
  | { type: 'failed'; key: string; message: string }
  /** The conversation is on show: what happened in it has been seen. */
  | { type: 'seen'; key: string }
  /** The page holds the conversation no longer. */
  | { type: 'dropped'; key: string }

/**
 * The events that only come while a turn is under way: one of them, of a conversation the page
 * knows nothing of, says that it is at work. A notice is one of them: it is said in a turn, or in a
 * compaction the page itself asked for of a conversation it has open, and may come before anything
 * else of a turn (one of a PDF too long for the model is told as the turn begins, before the page
 * knows a new chat's id). A notice said outside both would leave a view that seems at work for good.
 */
const IN_TURN: ReadonlySet<AgentEvent['type']> = new Set(['reasoning_delta', 'text_delta', 'assistant_rewrite', 'assistant_done', 'tool_start', 'tool_result', 'web_activity', 'permission_request', 'stats', 'notice'])

const put = (views: Views, key: string, view: View): Views => ({ ...views, [key]: view })
const without = (views: Views, key: string): Views => {
  const { [key]: _gone, ...rest } = views
  return rest
}

export function viewsReducer(views: Views, action: ViewsAction): Views {
  switch (action.type) {
    case 'opened':
      return put(views, action.id, { ...EMPTY_VIEW, items: action.items, stats: action.stats, running: action.running, partial: action.running })
    case 'draft':
      return put(views, action.key, EMPTY_VIEW)
    case 'user': {
      const view = views[action.key] ?? EMPTY_VIEW
      const { type: _type, key: _key, ...message } = action
      return put(views, action.key, { ...view, items: itemsReducer(view.items, { type: 'user', ...message }), running: true })
    }
    case 'bound': {
      const draft = views[action.key] ?? EMPTY_VIEW
      // What was heard of the conversation before its id was known here follows what the page had of it.
      const early = views[action.id]
      const merged: View = early ? { ...early, items: [...draft.items, ...early.items], partial: false, unseen: action.onPage ? false : early.unseen } : draft
      return put(without(views, action.key), action.id, merged)
    }
    case 'plain': {
      const view = views[action.key]
      return view ? put(views, action.key, { ...view, items: itemsReducer(view.items, { type: 'plain', at: action.at }) }) : views
    }
    case 'event': {
      const { event } = action
      const known = views[action.key]
      // A conversation the page holds nothing of: only what says it is at work makes a view of it.
      if (!known && !IN_TURN.has(event.type)) return views
      const view = known ?? { ...EMPTY_VIEW, running: true, partial: true }
      const next: View = { ...view, items: itemsReducer(view.items, { type: 'event', event, ...(action.at !== undefined ? { at: action.at } : {}) }) }
      if (event.type === 'stats') next.stats = event.stats
      else if (event.type === 'compacting') next.compacting = event.on
      else if (event.type === 'turn_end') {
        next.running = false
        next.compacting = false
        // Off the page, the list says that something is new there. What was followed of the turn is
        // kept until it is looked at: a notice of the turn is in no file, only here. The error a
        // turn ended in is kept with the conversation (shared/failures.ts).
        if (!action.onPage) next.unseen = true
      }
      return put(views, action.key, next)
    }
    case 'work': {
      const view = views[action.key]
      return view ? put(views, action.key, { ...view, running: action.on, betweenTurns: action.on, compacting: action.on ? view.compacting : false }) : views
    }
    case 'failed': {
      const view = views[action.key] ?? EMPTY_VIEW
      return put(views, action.key, { ...view, running: false, items: itemsReducer(view.items, { type: 'event', event: { type: 'error', message: action.message } }) })
    }
    case 'seen': {
      const view = views[action.key]
      return view?.unseen ? put(views, action.key, { ...view, unseen: false }) : views
    }
    case 'dropped':
      return action.key in views ? without(views, action.key) : views
  }
}

/** The conversations at work, by their ids: a chat that has no id yet is not in the list of conversations. */
export const workingIds = (views: Views): string[] => Object.keys(views).filter((key) => views[key].running && !isDraft(key))
/** The conversations in which a turn ended that the person has not looked at since. */
export const unseenIds = (views: Views): string[] => Object.keys(views).filter((key) => views[key].unseen)
