// What the conversation shows of the memory (main/memory.ts): the notice above the message box
// when a model has kept, changed or removed a note, the question asked before a note that looks
// sensitive is kept, and how the memory's tool calls read in the record of the conversation.
// Both boxes look like the question about a tool call, and stand where it stands.

import { useEffect, useRef, useState } from 'react'
import { KIND_LABELS, NOTICE_MS, cleanText, defaultScope, findSensitive, isMemoryKind, isMemoryTool, sensitiveLabels } from '../../shared/memory.ts'
import type { MemoryChange, MemoryKind, MemoryScope, SensitiveMatch } from '../../shared/memory.ts'
import type { PermissionDecision, ToolCall } from '../../shared/types.ts'
import { memoryApi } from './memory-api.ts'
import { errorText } from './util.ts'
import './MemoryPage.css'

/** What the record of a conversation calls the memory's tools. */
export const MEMORY_TOOL_LABELS: Record<string, string> = { remember: '记住', forget: '删除记忆', recall: '查记忆' }

/** What the result of a call the person turned down reads as: for a note, that it was not kept. */
export const MEMORY_DENIED_LABEL = '未写入'

const SCOPE_WORDS: Record<MemoryScope, string> = { global: '全局', workspace: '本工作区' }

function argsOf(call: ToolCall): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(call.arguments || '{}')
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

/** A note a model asks to keep, as its call says it. */
function noteOf(call: ToolCall): { text: string; details: string; kind: MemoryKind; scope: MemoryScope } {
  const args = argsOf(call)
  const kind: MemoryKind = isMemoryKind(args.kind) ? args.kind : 'project'
  const scope: MemoryScope = args.scope === 'global' || args.scope === 'workspace' ? args.scope : defaultScope(kind)
  return { text: cleanText(textOf(args.text)), details: textOf(args.details).trim(), kind, scope }
}

/** What a call of the memory's tools shows at a glance in the record of the conversation. Null for any other tool. */
export function memoryCallSummary(call: ToolCall): string | null {
  if (!isMemoryTool(call.name)) return null
  const args = argsOf(call)
  if (call.name === 'remember') {
    const note = noteOf(call)
    return `${SCOPE_WORDS[note.scope]} · ${KIND_LABELS[note.kind]} · ${note.text}`
  }
  if (call.name === 'forget') return `#${textOf(args.name).replace(/^#/, '')}`
  return textOf(args.name) ? `#${textOf(args.name).replace(/^#/, '')}` : textOf(args.query)
}

/** Whether a question about a tool call is the memory's: a note that looks sensitive, which the person is asked about before it is kept. */
export function isSensitiveMemoryCall(call: ToolCall): boolean {
  if (call.name !== 'remember') return false
  const note = noteOf(call)
  return findSensitive(note.text).length > 0 || findSensitive(note.details).length > 0
}

/** A text with what looks sensitive in it framed in red, as the question about a command frames characters that would not show. */
function Marked({ text, matches }: { text: string; matches: readonly SensitiveMatch[] }) {
  const pieces: (string | { text: string; label: string })[] = []
  let at = 0
  for (const match of matches) {
    if (match.start > at) pieces.push(text.slice(at, match.start))
    pieces.push({ text: text.slice(match.start, match.end), label: match.label })
    at = match.end
  }
  if (at < text.length) pieces.push(text.slice(at))
  return (
    <>
      {pieces.map((piece, i) =>
        typeof piece === 'string' ? (
          <span key={i}>{piece}</span>
        ) : (
          <span key={i} className="memory-marked" data-tip={piece.label}>
            {piece.text}
          </span>
        )
      )}
    </>
  )
}

/**
 * The question asked before a note that looks as if it holds a secret or personal data is kept:
 * where the question about a tool call stands, and like it. It waits for the answer, whatever the
 * conversation is set to. Not keeping it is the first answer.
 */
export function MemorySensitiveBar({ call, onDecide }: { call: ToolCall; onDecide: (decision: PermissionDecision) => void }) {
  const note = noteOf(call)
  const inText = findSensitive(note.text)
  const inDetails = findSensitive(note.details)
  return (
    <div className="permission memory-sensitive" role="alertdialog" aria-label="敏感资料确认">
      <div className="permission-title">这条记忆里可能有敏感资料，要写入吗？</div>
      <div className="hint">写入后，它会随每个请求发给模型服务；{note.scope === 'global' ? '这条是全局的，所有工作区的对话都会带上。' : '这条只在这个工作区的对话里用。'}</div>
      <div className="permission-body">
        <div className="memory-sensitive-line">
          <span className={`badge memory-kind memory-kind-${note.kind}`}>{KIND_LABELS[note.kind]}</span>
          <span>
            <Marked text={note.text} matches={inText} />
          </span>
        </div>
        {note.details && (
          <pre className="code">
            <Marked text={note.details} matches={inDetails} />
          </pre>
        )}
        <div className="hint">认出的：{sensitiveLabels([...inText, ...inDetails]).join('、')}（红框）</div>
      </div>
      <div className="permission-actions">
        <button className="btn btn-primary" onClick={() => onDecide('deny')}>
          不写入
        </button>
        <button className="btn" onClick={() => onDecide('allow')}>
          写入
        </button>
      </div>
    </div>
  )
}

/** A change told of, with what the person did about it here. */
interface Row extends MemoryChange {
  undone?: boolean
  problem?: string
}

const titleOf = (rows: readonly Row[]): string => {
  if (rows.length > 1) return `这一轮改了 ${rows.length} 条记忆`
  const { action, entry } = rows[0]
  const where = entry.scope === 'global' ? '全局' : '本工作区的'
  return action === 'saved' ? `已写入${where}记忆` : action === 'updated' ? `已更新${where}记忆` : `已删除一条${where}记忆`
}

const hintOf = (rows: readonly Row[]): string => {
  if (rows.length > 1) return '新写入和改过的从下一个对话起进入清单，删掉的从下一轮起不再发给模型。'
  const { action, entry } = rows[0]
  if (action === 'deleted') return '从下一轮起不再发给模型。'
  return entry.scope === 'global' ? '全局记忆会带进所有工作区的对话，从下一个对话起进入清单。' : '只在这个工作区的对话里用，从下一个对话起进入清单。'
}

/**
 * The notice that a model kept, changed or removed notes in the conversation on the page: above
 * the message box, like the question about a tool call. It goes by itself after a while, which the
 * line along its lower edge shows running out. The time stands still while the pointer or the
 * keyboard is on it, and while the window is not the one in front, so that it is not missed. What
 * a model changes in the same turn joins it, and its time starts anew.
 */
export function MemoryNotice({ sessionId, onOpen }: { sessionId: string | null; onOpen: (change: MemoryChange) => void }) {
  const [rows, setRows] = useState<Row[]>([])
  /** Counts the times the time began anew. */
  const [run, setRun] = useState(0)
  const [over, setOver] = useState(false)
  const [away, setAway] = useState(() => document.hidden || !document.hasFocus())
  const current = useRef(sessionId)
  current.current = sessionId
  const clock = useRef<{ left: number; since: number | null }>({ left: NOTICE_MS, since: null })
  const paused = over || away
  const shown = rows.length > 0

  useEffect(
    () =>
      memoryApi.onEvent((event) => {
        if (event.type !== 'notice' || event.sessionId !== current.current) return
        setRows((now) => [...now.filter((row) => row.id !== event.change.id), event.change])
        setRun((n) => n + 1)
      }),
    []
  )
  // What was told of one conversation is not shown with another.
  useEffect(() => setRows([]), [sessionId])
  useEffect(() => {
    const look = (): void => setAway(document.hidden || !document.hasFocus())
    window.addEventListener('focus', look)
    window.addEventListener('blur', look)
    document.addEventListener('visibilitychange', look)
    return () => {
      window.removeEventListener('focus', look)
      window.removeEventListener('blur', look)
      document.removeEventListener('visibilitychange', look)
    }
  }, [])
  // A change that joins starts the time anew.
  useEffect(() => {
    clock.current = { left: NOTICE_MS, since: null }
  }, [run])
  useEffect(() => {
    if (!shown || paused) return
    const time = clock.current
    time.since = Date.now()
    const timer = setTimeout(() => setRows([]), time.left)
    return () => {
      clearTimeout(timer)
      if (time.since !== null) time.left = Math.max(0, time.left - (Date.now() - time.since))
      time.since = null
    }
  }, [shown, paused, run])

  if (!shown) return null

  const undo = (row: Row): void => {
    memoryApi.undo(row.id).then(
      (did) => setRows((now) => now.map((r) => (r.id === row.id ? { ...r, undone: did, ...(did ? {} : { problem: '已经撤销不了了' }) } : r))),
      (err) => setRows((now) => now.map((r) => (r.id === row.id ? { ...r, problem: errorText(err) } : r)))
    )
  }
  const undoText = (row: Row): string => (row.undone ? (row.action === 'deleted' ? '已恢复' : '已撤销') : row.action === 'deleted' ? '恢复' : '撤销')
  const single = rows.length === 1 ? rows[0] : null

  return (
    <div
      className="permission memory-notice"
      role="status"
      aria-live="polite"
      data-paused={paused ? '' : undefined}
      onMouseEnter={() => setOver(true)}
      onMouseLeave={() => setOver(false)}
      onFocus={() => setOver(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
      }}
    >
      <div className="permission-title">{titleOf(rows)}</div>
      <div className="hint">{hintOf(rows)}</div>
      <div className="permission-body memory-notice-rows">
        {rows.map((row) => (
          <div key={row.id} className={`memory-notice-row${row.action === 'deleted' || row.undone ? ' memory-notice-gone' : ''}`}>
            {!single && <span className="memory-notice-what">{row.action === 'saved' ? '写入' : row.action === 'updated' ? '更新' : '删除'} · {SCOPE_WORDS[row.entry.scope]}</span>}
            <span className={`badge memory-kind memory-kind-${row.entry.kind}`}>{KIND_LABELS[row.entry.kind]}</span>
            <span className="memory-notice-text">{row.entry.text}</span>
            {!single && (
              <button type="button" className="btn btn-small" disabled={row.undone} onClick={() => undo(row)}>
                {undoText(row)}
              </button>
            )}
            {row.problem && <span className="row-error">{row.problem}</span>}
          </div>
        ))}
      </div>
      <div className="permission-actions">
        <button className="btn btn-primary" onClick={() => onOpen(rows[rows.length - 1])}>
          查看
        </button>
        {single && (
          <button className="btn" disabled={single.undone} onClick={() => undo(single)}>
            {undoText(single)}
          </button>
        )}
      </div>
      <span key={run} className="memory-notice-bar" style={{ animationDuration: `${NOTICE_MS}ms` }} aria-hidden="true" />
    </div>
  )
}
