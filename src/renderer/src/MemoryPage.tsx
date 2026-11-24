// The memory as the person sees it: a page in the main part of the window with every note, which
// they can add to, change and delete, and the settings of the memory. Also the entry in the
// sidebar that leads to it, and its row on the plugins page, where it is listed as a built-in
// feature with its switch. The notes are kept by the main process (main/memory.ts).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { folderKey, workspaceName } from '../../shared/folders.ts'
import {
  BUDGET_MAX,
  BUDGET_MIN,
  BUDGET_STEP,
  DETAILS_MAX,
  KIND_LABELS,
  MEMORY_COMMANDS,
  MEMORY_KINDS,
  MEMORY_TOOLS,
  SMALL_CONTEXT,
  SMALL_SHARE,
  TEXT_MAX,
  defaultScope,
  findSensitive,
  lineOf,
  sensitiveLabels,
  toSnapshotEntry
} from '../../shared/memory.ts'
import type { MemoryEntry, MemoryKind, MemoryListing, MemoryScope, MemoryState, ProviderMemoryMode } from '../../shared/memory.ts'
import { estimateTokens, formatCount, formatTokens } from '../../shared/stats.ts'
import { isLocalAddress } from '../../shared/types.ts'
import type { ProviderInfo } from '../../shared/types.ts'
import { whenExact, whenText } from '../../shared/when.ts'
import { ChevronLeftIcon, PlusIcon, WarningIcon, line } from './icons.tsx'
import { memoryApi } from './memory-api.ts'
import { Marked } from './MemoryNotice.tsx'
import { Notice } from './Notice.tsx'
import { Slider } from './PluginControls.tsx'
import { errorText, isWindows, useNow } from './util.ts'
import './MemoryPage.css'

const api = window.harness

/** The memory's mark: a brain, in the line style of the app's other icons. */
export function BrainIcon() {
  return (
    <svg {...line}>
      <path d="M15.5 13a3.5 3.5 0 0 0-3.5 3.5v1a3.5 3.5 0 0 0 7 0v-1.8" />
      <path d="M8.5 13a3.5 3.5 0 0 1 3.5 3.5v1a3.5 3.5 0 0 1-7 0v-1.8" />
      <path d="M17.5 16a3.5 3.5 0 0 0 0-7H17" />
      <path d="M19 9.3V6.5a3.5 3.5 0 0 0-7 0" />
      <path d="M6.5 16a3.5 3.5 0 0 1 0-7H7" />
      <path d="M5 9.3V6.5a3.5 3.5 0 0 1 7 0v10" />
    </svg>
  )
}

/** The settings of the memory, read anew whenever something of it changed. Null until read. */
export function useMemoryState(): MemoryState | null {
  const [state, setState] = useState<MemoryState | null>(null)
  useEffect(() => {
    let live = true
    const read = (): void => {
      memoryApi.state().then(
        (next) => live && setState(next),
        () => {}
      )
    }
    read()
    const stop = memoryApi.onEvent((event) => {
      if (event.type === 'changed') read()
    })
    return () => {
      live = false
      stop()
    }
  }, [])
  return state
}

/** The entry in the sidebar, under the plugins. Not there while the memory is off: its page is then reached from the plugins page. */
export function MemoryNavButton({ pressed, onOpen }: { pressed: boolean; onOpen: () => void }) {
  const state = useMemoryState()
  if (!state?.enabled) return null
  return (
    <button type="button" className="sidebar-item" aria-pressed={pressed} onClick={onOpen}>
      <BrainIcon />
      记忆
    </button>
  )
}

/** The memory's row on the plugins page: a feature of the app itself, with its switch, and the way to its page. */
export function MemoryFeatureRow({ onOpen }: { onOpen: () => void }) {
  const state = useMemoryState()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const on = state?.enabled ?? false
  const toggle = (): void => {
    setBusy(true)
    setError('')
    memoryApi
      .setEnabled(!on)
      .catch((err) => setError(errorText(err)))
      .finally(() => setBusy(false))
  }
  return (
    <li className="row">
      <div className="row-main">
        <div className="row-title">
          记忆
          <span className="badge memory-kind-user" data-tip="应用自己的功能，不是插件">
            内置功能
          </span>
          {state && <span className={`badge badge-${on ? 'active' : 'disabled'}`}>{on ? '运行中' : '未启用'}</span>}
        </div>
        <div className="row-desc">让模型跨对话记住关于你和项目的事，存在本机。</div>
        <div className="row-meta">工具：{MEMORY_TOOLS.join('、')}</div>
        <div className="row-meta">指令：{MEMORY_COMMANDS.join('、')}</div>
        {error && <div className="row-error">{error}</div>}
      </div>
      <button className="btn btn-small" onClick={onOpen} aria-label="打开记忆页">
        打开
      </button>
      <input type="checkbox" role="switch" className="switch" checked={on} disabled={busy || !state} onChange={toggle} aria-label="启用记忆" />
    </li>
  )
}

type View = 'global' | 'workspace' | 'all'

const MODE_LABELS: Record<ProviderMemoryMode, { label: string; tip: string }> = {
  rw: { label: '读写', tip: '模型看得到记忆，也能写入和删除' },
  ro: { label: '只读', tip: '模型看得到记忆、能查细节，但不能写入或删除' },
  off: { label: '不用', tip: '不把记忆发给这个服务，也不给它记忆的工具' }
}

const keyOf = (entry: Pick<MemoryEntry, 'id' | 'scope' | 'workspace'>): string => `${entry.scope}:${entry.workspace ?? ''}:${entry.id}`

/** What a line of the most a note can say weighs in the instructions, for saying how many such notes fit. */
const FULL_LINE = estimateTokens(lineOf({ id: 'abcd', kind: 'reference', text: '字'.repeat(TEXT_MAX) }))
/** What a line weighs when there are too few notes to tell: measured on notes of the usual length (2026-11-24). */
const USUAL_LINE = 26
/** What the headings of the two groups of notes weigh together. */
const HEADS = 9

/** A note being written or changed. */
interface Draft {
  text: string
  details: string
  kind: MemoryKind
  scope: MemoryScope
  localOnly: boolean
}

function MemoryForm({
  entry,
  workspace,
  names,
  onDone,
  onCancel
}: {
  /** The note being changed; absent for a new one. */
  entry?: MemoryEntry
  /** The workspace a note of a workspace goes with: the note's own, or the one of the conversation. */
  workspace: string
  names?: Readonly<Record<string, string>>
  onDone: () => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<Draft>(() =>
    entry
      ? { text: entry.text, details: entry.details ?? '', kind: entry.kind, scope: entry.scope, localOnly: Boolean(entry.localOnly) }
      : { text: '', details: '', kind: 'user', scope: 'global', localOnly: false }
  )
  const [scopeTouched, setScopeTouched] = useState(Boolean(entry))
  const [problem, setProblem] = useState('')
  const [saving, setSaving] = useState(false)
  const place = entry?.workspace ?? workspace
  const sensitive = sensitiveLabels([...findSensitive(draft.text), ...findSensitive(draft.details)])
  const save = (): void => {
    if (!draft.text.trim()) return setProblem('先写这条记忆的内容。')
    setSaving(true)
    setProblem('')
    memoryApi
      .save({
        ...(entry ? { id: entry.id, from: { scope: entry.scope, ...(entry.workspace ? { workspace: entry.workspace } : {}) } } : {}),
        scope: draft.scope,
        ...(draft.scope === 'workspace' ? { workspace: place } : {}),
        kind: draft.kind,
        text: draft.text,
        details: draft.details,
        localOnly: draft.localOnly
      })
      .then(onDone, (err) => setProblem(errorText(err)))
      .finally(() => setSaving(false))
  }
  return (
    <form
      className="memory-form"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.stopPropagation()
        onCancel()
      }}
    >
      <label className="memory-form-field">
        <span>
          内容（一句话，尽量短）{' '}
          <span className="memory-count" data-over={draft.text.length > TEXT_MAX ? '' : undefined}>
            {draft.text.length}/{TEXT_MAX}
          </span>
        </span>
        <input type="text" value={draft.text} maxLength={TEXT_MAX} autoFocus onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
      </label>
      <label className="memory-form-field">
        <span>细节（可选：为什么、怎么用）</span>
        <textarea rows={3} value={draft.details} maxLength={DETAILS_MAX} onChange={(e) => setDraft({ ...draft, details: e.target.value })} />
      </label>
      {sensitive.length > 0 && <Notice>看起来有{sensitive.join('、')}：写入后，它会随每个请求发给模型服务。</Notice>}
      <div className="memory-form-row">
        <select
          aria-label="类型"
          value={draft.kind}
          onChange={(e) => {
            const kind = e.target.value as MemoryKind
            // Until the person picks where it goes, it goes where its kind goes by default.
            setDraft({ ...draft, kind, ...(scopeTouched || !place ? {} : { scope: defaultScope(kind) }) })
          }}
        >
          {MEMORY_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {KIND_LABELS[kind]}
            </option>
          ))}
        </select>
        <select
          aria-label="范围"
          value={draft.scope}
          onChange={(e) => {
            setScopeTouched(true)
            setDraft({ ...draft, scope: e.target.value as MemoryScope })
          }}
        >
          <option value="global">全局</option>
          <option value="workspace" disabled={!place}>
            {place ? `工作区：${workspaceName(place, names, isWindows)}` : '工作区（先选一个工作文件夹）'}
          </option>
        </select>
        <label data-tip="只发给本机或局域网里的模型">
          <input type="checkbox" checked={draft.localOnly} onChange={(e) => setDraft({ ...draft, localOnly: e.target.checked })} />
          只给本地模型用
        </label>
        <span className="memory-form-grow" />
        <button type="button" className="btn btn-small" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="btn btn-small btn-primary" disabled={saving}>
          保存
        </button>
      </div>
      {problem && (
        <div className="msg-error" role="alert">
          {problem}
        </div>
      )}
    </form>
  )
}

/** The page of the memory. */
export function MemoryPage({
  workspace,
  names,
  providers,
  focus,
  onBack
}: {
  /** The workspace of the conversation on the page; empty where none was chosen. */
  workspace: string
  names?: Readonly<Record<string, string>>
  providers: readonly ProviderInfo[]
  /** A note to show first: the one a notice was about. */
  focus: { id: string; scope: MemoryScope; workspace?: string } | null
  onBack: () => void
}) {
  const state = useMemoryState()
  const [listing, setListing] = useState<MemoryListing | null>(null)
  const [error, setError] = useState('')
  const [view, setView] = useState<View>(workspace ? 'workspace' : 'global')
  const [query, setQuery] = useState('')
  /** The note being changed, by its key, or 'new' while one is being added. */
  const [editing, setEditing] = useState<string | null>(null)
  /** Notes deleted here, which can be brought back for as long as the page is open. */
  const [gone, setGone] = useState<{ key: string; change: string; entry: MemoryEntry }[]>([])
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const [flash, setFlash] = useState<string | null>(null)
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(new Map())
  const [budget, setBudget] = useState<number | null>(null)
  const saveBudget = useRef<ReturnType<typeof setTimeout> | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const now = useNow(30_000)

  const refresh = useCallback(() => {
    memoryApi.list(workspace).then(
      (next) => {
        setListing(next)
        setError('')
      },
      (err) => setError(errorText(err))
    )
  }, [workspace])
  useEffect(() => {
    refresh()
    return memoryApi.onEvent((event) => {
      if (event.type === 'changed') refresh()
    })
  }, [refresh])
  // The names of the conversations notes were written in.
  useEffect(() => {
    api.listSessions().then(
      (sessions) => setTitles(new Map(sessions.map((s) => [s.id, s.title]))),
      () => {}
    )
  }, [])
  useEffect(() => {
    if (state && budget === null) setBudget(state.budget)
  }, [state, budget])
  useEffect(
    () => () => {
      if (saveBudget.current) clearTimeout(saveBudget.current)
    },
    []
  )

  const same = (a: string | undefined, b: string): boolean => Boolean(a) && Boolean(b) && folderKey(a!, isWindows) === folderKey(b, isWindows)
  const own = listing?.workspaces.find((w) => same(w.folder, workspace))

  // A note a notice was about: shown where it is, and marked for a moment.
  useEffect(() => {
    if (!focus) return
    setView(focus.scope === 'global' ? 'global' : same(focus.workspace, workspace) ? 'workspace' : 'all')
    setFlash(keyOf(focus))
    const timer = setTimeout(() => setFlash(null), 2500)
    return () => clearTimeout(timer)
    // Only when another note is asked for.
  }, [focus?.id, focus?.scope, focus?.workspace])
  useEffect(() => {
    if (!flash || !listing) return
    listRef.current?.querySelector(`[data-key="${CSS.escape(flash)}"]`)?.scrollIntoView({ block: 'center' })
  }, [flash, listing, view])

  const use = listing?.use
  const listed = useMemo(() => new Set(use?.listed ?? []), [use])
  // A global note that waits for the person holds only in the workspace it was kept in (main/memory.ts).
  const inScope = (entry: MemoryEntry): boolean => (entry.scope === 'global' && (!entry.pending || same(entry.origin, workspace))) || same(entry.workspace, workspace)
  const notListed = (entry: MemoryEntry): boolean =>
    Boolean(use) && use!.mode !== 'off' && inScope(entry) && (use!.provider.local || !entry.localOnly) && !listed.has(entry.id)

  const matches = (entry: MemoryEntry): boolean => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return words.every((word) => `${entry.text}\n${entry.details ?? ''}`.toLowerCase().includes(word))
  }
  const groups: { title?: string; entries: MemoryEntry[] }[] = !listing
    ? []
    : view === 'global'
      ? [{ entries: listing.global }]
      : view === 'workspace'
        ? [{ entries: own?.entries ?? [] }]
        : [
            { title: '全局', entries: listing.global },
            ...listing.workspaces.filter((w) => w.present).map((w) => ({ title: `工作区：${workspaceName(w.folder, names, isWindows)}`, entries: w.entries })),
            ...listing.workspaces.filter((w) => !w.present).map((w) => ({ title: `已移除的工作区：${workspaceName(w.folder, names, isWindows)}`, entries: w.entries }))
          ]
  const shown = groups.map((group) => ({ ...group, entries: group.entries.filter(matches) })).filter((group) => group.entries.length > 0 || !group.title)
  const total = listing ? listing.global.length + listing.workspaces.reduce((sum, w) => sum + w.entries.length, 0) : 0

  const remove = (entry: MemoryEntry): void => {
    setError('')
    memoryApi.remove({ id: entry.id, scope: entry.scope, ...(entry.workspace ? { workspace: entry.workspace } : {}) }).then(
      (change) => setGone((now) => [{ key: keyOf(entry), change, entry }, ...now]),
      (err) => setError(errorText(err))
    )
  }
  /** Lets a global note a model kept hold in every workspace. */
  const confirm = (entry: MemoryEntry): void => {
    setError('')
    memoryApi.confirm(entry.id).catch((err) => setError(errorText(err)))
  }
  /** Makes a global note a model kept a note of the workspace it was kept in. */
  const keepHere = (entry: MemoryEntry): void => {
    setError('')
    memoryApi
      .save({
        id: entry.id,
        from: { scope: 'global' },
        scope: 'workspace',
        workspace: entry.origin ?? '',
        kind: entry.kind,
        text: entry.text,
        ...(entry.details ? { details: entry.details } : {}),
        ...(entry.localOnly ? { localOnly: true } : {})
      })
      .catch((err) => setError(errorText(err)))
  }
  const bringBack = (key: string, change: string): void => {
    memoryApi.undo(change).then(
      (did) => {
        setGone((now) => now.filter((g) => g.key !== key))
        if (!did) setError('这条已经恢复不了了。')
      },
      (err) => setError(errorText(err))
    )
  }

  const sourceText = (entry: MemoryEntry): string => {
    const source = entry.source
    const parts: string[] = []
    if (source?.user) parts.push('你自己写的')
    else if (source?.conversation) {
      parts.push(`来自「${titles.get(source.conversation) ?? '已删除的对话'}」`)
      const who = [source.providerName ?? source.provider, source.model].filter(Boolean).join(' · ')
      if (who) parts.push(source.local ? `${who}（本地）` : who)
    }
    if (entry.byUser && !source?.user && entry.byUser > entry.created) parts.push('你改过')
    return parts.join(' · ')
  }

  // How many notes fit, said of the notes there are: what their lines weigh on average.
  const lines = listing ? [...listing.global, ...listing.workspaces.flatMap((w) => w.entries)].map((entry) => estimateTokens(lineOf(toSnapshotEntry(entry)))) : []
  const lineWeight = lines.length >= 3 ? lines.reduce((sum, n) => sum + n, 0) / lines.length : USUAL_LINE
  const shownBudget = budget ?? state?.budget ?? 0
  const budgetHint = `常见长度的记忆约 ${Math.floor((shownBudget - HEADS) / lineWeight)} 条；每条都写满 ${TEXT_MAX} 字时约 ${Math.floor((shownBudget - HEADS) / FULL_LINE)} 条。上下文小于 ${formatTokens(SMALL_CONTEXT)} 的模型按上下文的 ${Math.round(SMALL_SHARE * 100)}% 算。`
  const changeBudget = (tokens: number): void => {
    setBudget(tokens)
    // Saved once the thumb rests, not at every step of the drag.
    if (saveBudget.current) clearTimeout(saveBudget.current)
    saveBudget.current = setTimeout(() => {
      memoryApi.setBudget(tokens).catch((err) => setError(errorText(err)))
    }, 400)
  }
  const setMode = (providerId: string, mode: ProviderMemoryMode): void => {
    memoryApi.setProviderMode(providerId, mode).then(refresh, (err) => setError(errorText(err)))
  }

  const useText = (): string => {
    if (!use) return ''
    const name = use.provider.name
    if (use.mode === 'off') return `${name} 设成了不用记忆，新对话不带记忆。`
    const where = workspace ? '在这个工作区开新对话' : '开新对话'
    const left = use.left ? `；另有 ${use.left} 条放不下，模型用 recall 仍查得到` : ''
    return `${where}，${name} 会带上 ${use.listed.length} 条记忆，约 ${formatCount(use.tokens)} / ${formatCount(use.limit)} token${left}${use.mode === 'ro' ? '（只读）' : ''}。`
  }

  const row = (entry: MemoryEntry) => {
    const key = keyOf(entry)
    if (editing === key) {
      return (
        <li key={key} className="row memory-row" data-key={key}>
          <MemoryForm entry={entry} workspace={workspace} names={names} onDone={() => setEditing(null)} onCancel={() => setEditing(null)} />
        </li>
      )
    }
    const open = opened.has(key)
    // A global note a model kept, waiting for the person: the bar and the tint of a warning.
    const waiting = entry.scope === 'global' && entry.pending === true
    // What looks like a key or personal data in a note already kept, framed in red as when it was asked about.
    const inText = findSensitive(entry.text)
    const inDetails = findSensitive(entry.details ?? '')
    const risky = [...inText, ...inDetails]
    const secret = risky.some((match) => match.kind === 'secret')
    return (
      <li key={key} className="row memory-row" data-key={key} data-focus={flash === key ? '' : undefined} data-pending={waiting ? '' : undefined}>
        <div className="row-main">
          <div className="row-title">
            <span className={`badge memory-kind memory-kind-${entry.kind}`}>{KIND_LABELS[entry.kind]}</span>
            <span className="memory-text">
              <Marked text={entry.text} matches={inText} />
            </span>
            {waiting && (
              <span className="badge memory-pending" data-tip="模型写下的全局记忆。设为全局之前，只在写下它的工作区里用">
                <WarningIcon />
                待确认
              </span>
            )}
            {risky.length > 0 && (
              <span className="badge memory-risky" data-tip={`认出的：${sensitiveLabels(risky).join('、')}`}>
                {secret ? '可能是密钥' : '可能有个人资料'}
              </span>
            )}
            {entry.localOnly && (
              <span className="badge" data-tip="只发给本机或局域网里的模型">
                仅本地
              </span>
            )}
            {notListed(entry) && (
              <span className="badge badge-waiting" data-tip="清单放不下：新对话的提示里没有它，模型用 recall 仍查得到">
                未放入清单
              </span>
            )}
          </div>
          {entry.details && (
            <div
              className="row-desc memory-details"
              data-open={open ? '' : undefined}
              data-tip={open ? undefined : '点一下看全部'}
              onClick={() =>
                setOpened((now) => {
                  const next = new Set(now)
                  if (open) next.delete(key)
                  else next.add(key)
                  return next
                })
              }
            >
              <Marked text={entry.details} matches={inDetails} />
            </div>
          )}
          <div className="row-meta">
            {waiting
              ? `全局（待确认，目前只在"${workspaceName(entry.origin ?? '', names, isWindows)}"里用）`
              : entry.scope === 'global'
                ? '全局'
                : `工作区：${workspaceName(entry.workspace ?? '', names, isWindows)}`}{' '}
            · <span data-tip={whenExact(entry.updated)}>{whenText(entry.updated, now)}</span>
            {sourceText(entry) && ` · ${sourceText(entry)}`}
            {risky.length > 0 && ` · 记忆会随请求发给模型服务，${secret ? '建议删掉这条并更换 Key' : '建议删掉或改写这条'}`}
          </div>
        </div>
        {waiting && (
          <button type="button" className="btn btn-small" onClick={() => confirm(entry)}>
            设为全局
          </button>
        )}
        {waiting && entry.origin && (
          <button type="button" className="btn btn-small" onClick={() => keepHere(entry)}>
            只留在本工作区
          </button>
        )}
        <button type="button" className="btn btn-small" onClick={() => setEditing(key)}>
          编辑
        </button>
        <button type="button" className="btn btn-small" onClick={() => remove(entry)}>
          删除
        </button>
      </li>
    )
  }

  const goneHere = gone.filter((g) => {
    const entry = g.entry
    return view === 'all' || (view === 'global' ? entry.scope === 'global' : entry.scope === 'workspace' && same(entry.workspace, workspace))
  })

  return (
    <>
      <header className="page-head">
        <button className="btn btn-small page-back" onClick={onBack}>
          <ChevronLeftIcon />
          返回对话
        </button>
        <h1 id="memory-title">记忆</h1>
        {state && (
          <label className="memory-switch">
            启用
            <input
              type="checkbox"
              role="switch"
              className="switch"
              checked={state.enabled}
              onChange={(e) => memoryApi.setEnabled(e.target.checked).catch((err) => setError(errorText(err)))}
              aria-label="启用记忆"
            />
          </label>
        )}
      </header>
      <div className="page-body" ref={listRef}>
        <Notice>记忆会随每个请求发给当前的模型服务。进行中的对话用的是它开始时的那一份，你在这里的改动从下一轮起生效。</Notice>
        {state && !state.enabled && <Notice>记忆已关闭：不会发给模型，模型也不能写入或删除。已有的记忆还留在这里。</Notice>}
        <div className="toolbar toolbar-wrap">
          <div className="memory-views" role="tablist" aria-label="看哪些记忆">
            <button type="button" role="tab" aria-selected={view === 'global'} onClick={() => setView('global')}>
              全局 {listing ? listing.global.length : ''}
            </button>
            {workspace && (
              <button type="button" role="tab" aria-selected={view === 'workspace'} onClick={() => setView('workspace')}>
                本工作区 · {workspaceName(workspace, names, isWindows)} {own ? own.entries.length : 0}
              </button>
            )}
            <button type="button" role="tab" aria-selected={view === 'all'} onClick={() => setView('all')}>
              全部 {listing ? total : ''}
            </button>
          </div>
          <input className="memory-search" type="search" placeholder="搜索记忆" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="搜索记忆" />
          <button type="button" className="btn btn-primary memory-add" onClick={() => setEditing('new')} disabled={editing === 'new'}>
            <PlusIcon />
            添加记忆
          </button>
        </div>
        {error && (
          <div className="msg-error" role="alert">
            {error}
          </div>
        )}
        {editing === 'new' && (
          <ul className="rows">
            <li className="row memory-row">
              <MemoryForm workspace={workspace} names={names} onDone={() => setEditing(null)} onCancel={() => setEditing(null)} />
            </li>
          </ul>
        )}
        {goneHere.length > 0 && (
          <ul className="rows">
            {goneHere.map((g) => (
              <li key={g.key} className="row memory-gone">
                <span className="row-main">已删除「{g.entry.text}」</span>
                <button type="button" className="btn btn-small" onClick={() => bringBack(g.key, g.change)}>
                  撤销
                </button>
              </li>
            ))}
          </ul>
        )}
        {listing && total === 0 && editing !== 'new' && <p className="hint">还没有记忆。模型会在对话里记下值得记住的事；你也可以点"添加记忆"自己写一条。</p>}
        {listing && total > 0 && shown.every((group) => group.entries.length === 0) && <p className="hint">{query ? '没有找到包含这些字的记忆。' : '这里还没有记忆。'}</p>}
        {shown.map((group, i) => (
          <div key={group.title ?? i}>
            {group.title && <div className="memory-group-title">{group.title}</div>}
            <ul className="rows">{group.entries.map(row)}</ul>
          </div>
        ))}
        <div className="memory-foot">
          <span className="hint">{useText()}</span>
          <button type="button" className="btn btn-small" onClick={() => memoryApi.openFolder().catch((err) => setError(errorText(err)))}>
            打开记忆文件夹
          </button>
        </div>

        <h2 className="page-group-title">设置</h2>
        {state && (
          <Slider label="清单上限（token）" hint={budgetHint} value={shownBudget} min={BUDGET_MIN} max={BUDGET_MAX} step={BUDGET_STEP} onChange={changeBudget} />
        )}
        <div className="setting-name">各模型服务</div>
        {providers.map((provider) => {
          const mode = state?.providers[provider.id] ?? 'rw'
          const active = use?.provider.id === provider.id
          const small = active && use!.limit < shownBudget
          return (
            <div key={provider.id} className="setting-row memory-provider">
              <span className="setting-words">
                <span className="setting-name">
                  {provider.name}
                  {isLocalAddress(provider.baseURL) && <span className="badge">本地</span>}
                </span>
                {small && (
                  <span className="hint">
                    {use!.window ? `上下文 ${formatTokens(use!.window)}：` : '不知道上下文多长：'}清单上限 {formatCount(use!.limit)} token，约 {Math.floor((use!.limit - HEADS) / lineWeight)} 条
                  </span>
                )}
              </span>
              <span className="memory-modes" role="group" aria-label={`${provider.name} 怎么用记忆`}>
                {(['rw', 'ro', 'off'] as const).map((choice) => (
                  <button key={choice} type="button" aria-pressed={mode === choice} data-tip={MODE_LABELS[choice].tip} disabled={!state} onClick={() => setMode(provider.id, choice)}>
                    {MODE_LABELS[choice].label}
                  </button>
                ))}
              </span>
            </div>
          )
        })}
      </div>
    </>
  )
}
