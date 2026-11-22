import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ABOUT } from '../../shared/about.ts'
import { formatShare, formatTokens } from '../../shared/stats.ts'
import type { SessionStats } from '../../shared/stats.ts'
import { CHATGPT_USAGE_URL, isLocalAddress } from '../../shared/types.ts'
import type {
  CompactionMark,
  ModelInfo,
  PermissionDecision,
  ReasoningEffort,
  SessionIcon,
  SessionSummary,
  Settings,
  ToolCall
} from '../../shared/types.ts'
import { AnswerText } from './AnswerText.tsx'
import { Composer } from './Composer.tsx'
import { FolderMenu } from './FolderMenu.tsx'
import { itemsFromMessages, itemsReducer, lastSummaryAt } from './items.ts'
import type { Item } from './items.ts'
import { Notice } from './Notice.tsx'
import { PluginPanel, useAnnouncePlace } from './PluginUi.tsx'
import { PluginsPage } from './PluginsPage.tsx'
import { PromptDialog } from './PromptDialog.tsx'
import { SettingsDialog } from './Settings.tsx'
import { Sidebar } from './Sidebar.tsx'
import { StatusRow } from './StatusRow.tsx'
import { ToastStack, notify, toasts } from './Toasts.tsx'
import { errorText } from './util.ts'

const api = window.harness
const LAST_WORKSPACE_KEY = 'lastWorkspace'
/** What the notice about the ChatGPT plan is known by, so that there is one of it at most. */
const PLAN_NOTICE = 'chatgpt-plan'

function readLastWorkspace(): string {
  try {
    return localStorage.getItem(LAST_WORKSPACE_KEY) ?? ''
  } catch {
    return ''
  }
}

function parseArgs(call: ToolCall): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(call.arguments || '{}')
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The one argument that best identifies a tool call at a glance. */
function callSummary(call: ToolCall): string {
  const args = parseArgs(call)
  const value = args.command ?? args.path ?? args.pattern ?? args.name ?? ''
  return typeof value === 'string' ? value : ''
}

const TOOL_LABELS: Record<string, string> = {
  load_skill: '加载 Skill',
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '编辑文件',
  list_dir: '列出目录',
  search: '搜索',
  run_command: '执行命令'
}

function ToolDetails({ call }: { call: ToolCall }) {
  const args = parseArgs(call)
  const entries = Object.entries(args)
  if (entries.length === 0) return <pre className="code">{call.arguments}</pre>
  return (
    <>
      {entries.map(([key, value]) => (
        <div key={key} className="arg">
          <div className="arg-name">{key}</div>
          <pre className="code">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>
        </div>
      ))}
    </>
  )
}

/** How a tool call ended, judged from the result text the agent loop recorded for it. */
function toolStatus(output: string | undefined): { label: string; failed: boolean } {
  if (output === undefined) return { label: '运行中…', failed: false }
  if (output === 'The user denied this tool call.') return { label: '已拒绝', failed: true }
  // A command stopped part-way keeps the output it had and ends with the reason in brackets.
  if (output === 'Cancelled by user' || output.endsWith('[Cancelled by user]')) return { label: '已取消', failed: true }
  if (/\[Timed out after \d+s\]$/.test(output)) return { label: '超时', failed: true }
  if (output.startsWith('Error:')) return { label: '失败', failed: true }
  return { label: '完成', failed: false }
}

function ToolCard({ item, faded }: { item: Extract<Item, { kind: 'tool' }>; faded: boolean }) {
  const { label: status, failed } = toolStatus(item.output)
  return (
    <details className={`tool${failed ? ' tool-failed' : ''}${faded ? ' faded' : ''}`}>
      <summary>
        <span className="tool-name">{TOOL_LABELS[item.call.name] ?? item.call.name}</span>
        <span className="tool-summary">{callSummary(item.call)}</span>
        {/* Still shown here in full; the model is sent a line in its place. */}
        {item.cleared && <span className="tool-cleared">结果已清理</span>}
        <span className="tool-status">{status}</span>
      </summary>
      <ToolDetails call={item.call} />
      {item.output !== undefined && (
        <div className="arg">
          <div className="arg-name">结果</div>
          <pre className="code">{item.output}</pre>
          {item.cleared && <div className="hint">为了给上下文腾出空间，这个结果已经不再发给模型；模型需要时会重新读取或执行。</div>}
        </div>
      )}
    </details>
  )
}

/**
 * Whether the size of a compacted conversation is said as a share of the model's room: where
 * that room was known, and the conversation took a part of it worth naming. A conversation kept
 * small by a limit of the person's, in a model with room for a hundred times as much, is said in tokens.
 */
const inShares = (mark: CompactionMark): boolean => mark.window !== undefined && mark.before / mark.window >= 0.1

/**
 * A place where the conversation was compacted: a line across it that says what was done and
 * what it saved. Where a summary was put in the place of what stands above, the summary can be read.
 */
function MarkLine({ mark, workspace, faded }: { mark: CompactionMark; workspace: string; faded: boolean }) {
  const [open, setOpen] = useState(false)
  const { summary } = mark
  const what = summary ? `以上 ${summary.covers} 条消息已压缩为摘要` : `已清理 ${mark.cleared ?? 0} 个较早的工具结果`
  const full = (tokens: number): string => (inShares(mark) && mark.window ? formatShare(Math.min(1, tokens / mark.window)) : formatTokens(tokens))
  // What is left is the app's guess until the service has counted it.
  const saved = `${full(mark.before)} → ${mark.rough ? '约 ' : ''}${full(mark.after)}${inShares(mark) ? '' : ' token'}`
  return (
    <div className={`compact${faded ? ' faded' : ''}`}>
      <div className="compact-line" role="separator" aria-label={`${what}，上下文占用 ${saved}`}>
        <span className="compact-text">
          {/* The numbers stay together where the line has to break. */}
          {what} · <span className="compact-saved">{saved}</span>
        </span>
        {summary && (
          <button type="button" className="status-link" aria-expanded={open} onClick={() => setOpen((now) => !now)}>
            {open ? '收起摘要' : '查看摘要'}
          </button>
        )}
      </div>
      {summary && open && (
        <div className="compact-summary">
          <AnswerText text={summary.text} workspace={workspace} />
          <p className="hint">
            这是模型现在看到的摘要，代替上面的消息。
            {summary.said > 0 && `摘要后面还附有你说过的 ${summary.said} 条原话`}
            {summary.said > 0 && summary.files > 0 && '，以及'}
            {summary.said === 0 && summary.files > 0 && '摘要后面还附有'}
            {summary.files > 0 && `读过、改过的 ${summary.files} 个文件的清单`}
            {(summary.said > 0 || summary.files > 0) && '。'}
          </p>
        </div>
      )}
    </div>
  )
}

/**
 * An error that comes with something to do about it. `detail` is what the service said, kept
 * small underneath for looking the problem up.
 */
function ErrorNotice({ title, text, detail, children }: { title: string; text: string; detail: string; children: ReactNode }) {
  return (
    <div className="msg error-notice" role="alert">
      <div className="error-notice-title">{title}</div>
      <div>{text}</div>
      <div className="error-notice-actions">{children}</div>
      <div className="error-notice-detail">{detail}</div>
    </div>
  )
}

function Transcript({ items, workspace, onOpenSettings }: { items: Item[]; workspace: string; onOpenSettings: () => void }) {
  // What stands above the last summary is no longer sent to the model. It stays, paler, for the person to read.
  const from = lastSummaryAt(items)
  return (
    <>
      {items.map((item, index) => {
        const faded = index < from
        const pale = faded ? ' faded' : ''
        if (item.kind === 'mark') return <MarkLine key={index} mark={item.mark} workspace={workspace} faded={faded} />
        if (item.kind === 'user') {
          return (
            <div key={index} className={`msg msg-user${pale}`}>
              {item.skill && <span className="chip chip-block">Skill · {item.skill}</span>}
              {item.text}
            </div>
          )
        }
        if (item.kind === 'assistant') {
          return (
            <div key={index} className={`msg msg-assistant${pale}`}>
              {item.reasoning && (
                <details className="reasoning" open={item.open && !item.text}>
                  <summary>思考过程</summary>
                  <div className="reasoning-body">{item.reasoning}</div>
                </details>
              )}
              {item.text && <AnswerText text={item.text} workspace={workspace} />}
            </div>
          )
        }
        if (item.kind === 'tool') return <ToolCard key={index} item={item} faded={faded} />
        if (item.kind === 'notice') {
          return (
            <Notice key={index} className={`msg${pale}`} role="status">
              {item.text}
            </Notice>
          )
        }
        if (item.hint === 'chatgpt-usage') {
          return (
            <ErrorNotice
              key={index}
              title="ChatGPT 套餐：已达到用量上限"
              text="请到 ChatGPT 的设置里查看你的套餐用量，或者给这个应用设置的用量上限。"
              detail={item.message}
            >
              <a className="btn btn-primary" href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">
                管理用量
              </a>
            </ErrorNotice>
          )
        }
        if (item.hint === 'chatgpt-sign-in') {
          return (
            <ErrorNotice key={index} title="ChatGPT 登录已失效" text="需要重新用 ChatGPT 登录，才能继续使用套餐额度。" detail={item.message}>
              <button className="btn btn-primary" onClick={onOpenSettings}>
                打开设置重新登录
              </button>
            </ErrorNotice>
          )
        }
        return (
          <div key={index} className="msg msg-error" role="alert">
            {item.message}
          </div>
        )
      })}
    </>
  )
}

function PermissionBar({
  call,
  onDecide
}: {
  call: ToolCall
  onDecide: (decision: PermissionDecision) => void
}) {
  return (
    <div className="permission" role="alertdialog" aria-label="权限确认">
      <div className="permission-title">
        {TOOL_LABELS[call.name] ? `允许${TOOL_LABELS[call.name]}？` : `允许调用工具 ${call.name}？`}
      </div>
      <div className="permission-body">
        <ToolDetails call={call} />
      </div>
      <div className="permission-actions">
        <button className="btn btn-primary" onClick={() => onDecide('allow')}>
          允许
        </button>
        <button className="btn" onClick={() => onDecide('always')}>
          本次会话始终允许
        </button>
        <button className="btn" onClick={() => onDecide('deny')}>
          拒绝
        </button>
      </div>
    </div>
  )
}

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null)
  /** Counts saves of the settings dialog. */
  const [saves, setSaves] = useState(0)
  const [showSettings, setShowSettings] = useState(false)
  /** What the main part of the window shows: the conversation, or the page of the plugins lying over it. */
  const [page, setPage] = useState<'chat' | 'plugins'>('chat')
  /** The person's own prompt for the provider in use is being edited. */
  const [showPrompt, setShowPrompt] = useState(false)
  /** The note shown once, after the first sign-in with ChatGPT plan usage. */
  const [welcome, setWelcome] = useState(false)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [workspace, setWorkspace] = useState(readLastWorkspace)
  const [items, dispatch] = useReducer(itemsReducer, [])
  const [running, setRunning] = useState(false)
  const [permission, setPermission] = useState<{ id: string; call: ToolCall } | null>(null)
  /** What was measured of the conversation on the page, as far as the app has kept count of it. */
  const [stats, setStats] = useState<SessionStats | null>(null)
  /** The model is writing the summary of the conversation, which takes a while and shows nothing. */
  const [compacting, setCompacting] = useState(false)

  // The components of plugins are told which conversation is on the page, and which model it talks to.
  useAnnouncePlace(sessionId, workspace, running, settings)

  // The event listener is registered once, so it reads the current session through a ref.
  const sessionRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  /** Where the conversation was scrolled to when last looked at, to tell the person moving up from the conversation growing. */
  const lastTop = useRef(0)

  /** Brings the end of the conversation into view, unless the person has moved away from it. */
  const keepEndInView = useCallback((): void => {
    const el = scrollRef.current
    if (!el || !stickToBottom.current) return
    el.scrollTop = el.scrollHeight
    lastTop.current = el.scrollTop
  }, [])

  const refreshSessions = useCallback(() => {
    void api.listSessions().then(setSessions)
  }, [])

  useEffect(() => {
    void api.getSettings().then((s) => {
      setSettings(s)
      if (!s.ready) setShowSettings(true)
    })
    refreshSessions()
    return api.onEvent(({ sessionId: id, event }) => {
      // The switch was taken back for the model, whichever session found out; the page shows it at once.
      if (event.type === 'notice' && event.code === 'fast-mode-refused') setSettings((s) => (s ? { ...s, fastMode: false } : s))
      if (id !== sessionRef.current) return
      if (event.type === 'permission_request') setPermission({ id: event.id, call: event.call })
      if (event.type === 'stats') return setStats(event.stats)
      if (event.type === 'compacting') return setCompacting(event.on)
      if (event.type === 'turn_end') {
        setRunning(false)
        setCompacting(false)
        setPermission(null)
        refreshSessions()
      }
      // The sign-in was given up behind the page's back; what it shows about it is out of date.
      if (event.type === 'error' && event.hint === 'chatgpt-sign-in') void api.getSettings().then(setSettings)
      dispatch({ type: 'event', event })
    })
  }, [refreshSessions])

  // The welcome note sits on top of everything, so Escape closes it and nothing underneath.
  useEffect(() => {
    if (!welcome) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      setWelcome(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [welcome])

  // The service is asked again when the connection changes; an older answer must not overwrite a newer one.
  // `saves` covers a corrected API key, which changes none of the three values the page can see.
  const { activeProviderId, model, ready } = settings ?? {}
  useEffect(() => {
    let current = true
    setModelInfo(null)
    if (ready && model) {
      api.getModelInfo().then(
        (info) => current && setModelInfo(info),
        () => {}
      )
    }
    return () => {
      current = false
    }
  }, [activeProviderId, model, ready, saves])

  useEffect(keepEndInView, [items, permission, keepEndInView])

  const openSession = async (id: string): Promise<void> => {
    const session = await api.loadSession(id)
    if (!session) return refreshSessions()
    sessionRef.current = id
    setPage('chat')
    setSessionId(id)
    setStats(session.stats ?? null)
    setWorkspace(session.workspace)
    stickToBottom.current = true
    // Where the conversation before this one was scrolled to says nothing about this one.
    lastTop.current = 0
    dispatch({ type: 'reset', items: itemsFromMessages(session.messages) })
  }

  const chooseWorkspace = (dir: string): void => {
    setWorkspace(dir)
    try {
      localStorage.setItem(LAST_WORKSPACE_KEY, dir)
    } catch {
      // Remembering the folder is a convenience; the app works without it.
    }
  }

  /** Starts an empty chat: in the given folder, or else in the one used last. */
  const newChat = (dir?: string): void => {
    sessionRef.current = null
    setPage('chat')
    setSessionId(null)
    setStats(null)
    if (dir) chooseWorkspace(dir)
    else setWorkspace(readLastWorkspace())
    dispatch({ type: 'reset', items: [] })
  }

  const removeSession = async (id: string): Promise<void> => {
    await api.deleteSession(id)
    if (id === sessionId) newChat()
    refreshSessions()
  }

  const renameSession = async (id: string, title: string): Promise<void> => {
    await api.renameSession(id, title)
    refreshSessions()
  }

  const markSession = async (id: string, icon: SessionIcon | null): Promise<void> => {
    await api.setSessionIcon(id, icon)
    refreshSessions()
  }

  const archiveSession = async (id: string, archived: boolean): Promise<void> => {
    await api.setSessionArchived(id, archived)
    // The session leaves the list, so the window moves on from it too.
    if (archived && id === sessionId) newChat()
    refreshSessions()
  }

  const pickWorkspace = async (): Promise<void> => {
    const picked = await api.pickWorkspace()
    if (picked) chooseWorkspace(picked)
  }

  const send = async (text: string, skill?: string): Promise<void> => {
    if (running || !workspace) return
    setRunning(true)
    stickToBottom.current = true
    lastTop.current = 0
    dispatch({ type: 'user', text, skill })
    try {
      const id = await api.send(sessionId, workspace, text, skill)
      sessionRef.current = id
      setSessionId(id)
      refreshSessions()
    } catch (err) {
      setRunning(false)
      dispatch({ type: 'event', event: { type: 'error', message: errorText(err) } })
      // A sign-in that turned out to be over is the usual reason; the page then says so by the message box.
      void api.getSettings().then(setSettings)
    }
  }

  const changeEffort = (effort: ReasoningEffort): void => {
    // Shown at once; the saved settings replace it when they come back.
    setSettings((s) => (s ? { ...s, reasoningEffort: effort } : s))
    api.setReasoningEffort(effort).then(setSettings, (err) => {
      dispatch({ type: 'event', event: { type: 'error', message: errorText(err) } })
      void api.getSettings().then(setSettings)
    })
  }

  const changeFast = (on: boolean): void => {
    // Shown at once, like the effort; the saved settings replace it when they come back.
    setSettings((s) => (s ? { ...s, fastMode: on } : s))
    api.setFastMode(on).then(setSettings, (err) => {
      dispatch({ type: 'event', event: { type: 'error', message: errorText(err) } })
      void api.getSettings().then(setSettings)
    })
  }

  const selectModel = (providerId: string, modelId: string): void => {
    api.selectModel(providerId, modelId).then(setSettings, (err) => {
      dispatch({ type: 'event', event: { type: 'error', message: errorText(err) } })
    })
  }

  /** Says how many tokens the context of the model in use holds, and has the page ask anew what is known of the model. */
  const setContextWindow = async (tokens: number | null): Promise<void> => {
    if (!settings?.model) return
    setSettings(await api.setContextWindow(settings.activeProviderId, settings.model, tokens))
    setSaves((n) => n + 1)
  }

  /** Has the conversation on the page compacted now, and says what came of it where the conversation itself does not show it. */
  const compactNow = async (): Promise<void> => {
    if (!sessionId || running) return
    setRunning(true)
    try {
      const report = await api.compactSession(sessionId)
      if (report.problem) {
        notify({ kind: 'error', title: '没能写出摘要', text: report.done ? `较早的工具结果已经清理。服务返回：${report.problem}` : `服务返回：${report.problem}` })
      } else if (!report.done) {
        notify({ title: '没有可以压缩的内容', text: '对话还不长，或者较早的部分已经压缩过了。' })
      }
    } catch (err) {
      notify({ kind: 'error', title: '压缩没有完成', text: errorText(err) })
    } finally {
      setRunning(false)
      setCompacting(false)
      refreshSessions()
    }
  }

  const decide = (decision: PermissionDecision): void => {
    if (!permission) return
    void api.respondPermission(permission.id, decision)
    setPermission(null)
  }

  const active = settings?.providers.find((p) => p.id === settings.activeProviderId)
  /** Requests go to a signed-in ChatGPT account and count against its plan. */
  const onPlan = active?.auth === 'chatgpt' && active.ready
  const blocked = !settings?.ready
    ? active?.auth !== 'chatgpt'
      ? '请先在设置中填写 API Key'
      : active.account?.signedIn
        ? '请先在设置中启用 ChatGPT 套餐额度'
        : '请先在设置中用 ChatGPT 登录'
    : !settings.model
      ? '请先在右下角选择模型'
      : !workspace
        ? '请先选择工作文件夹'
        : ''
  /** A new chat with nothing in it: the message box sits in the middle of the window. */
  const empty = items.length === 0

  // Whose quota a message uses is said when that becomes the plan: as the app starts with it in
  // use, and when a model of it is picked. The note of the very first sign-in says the same at
  // length, so the notice is left out beside it.
  const planTold = useRef(false)
  useEffect(() => {
    if (!onPlan) {
      planTold.current = false
      toasts.dismissKey(PLAN_NOTICE)
      return
    }
    if (planTold.current) return
    planTold.current = true
    if (welcome) return
    notify({
      key: PLAN_NOTICE,
      title: '正在使用 ChatGPT 套餐',
      text: '消息会计入你的套餐额度。',
      link: { label: '管理用量', href: CHATGPT_USAGE_URL }
    })
  }, [onPlan, welcome])

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        // While another page lies over the conversation, the list points at none of them.
        activeId={page === 'chat' ? sessionId : null}
        busy={running}
        page={page}
        onNewChat={newChat}
        onOpen={(id) => void openSession(id)}
        onRename={renameSession}
        onArchive={archiveSession}
        onIcon={markSession}
        onDelete={removeSession}
        onSearch={api.searchSessions}
        onPlugins={() => setPage((now) => (now === 'plugins' ? 'chat' : 'plugins'))}
        onSettings={() => setShowSettings(true)}
      />

      <div className="stage">
        {/* The conversation stays as it is under a page that lies over it: what was typed, and where it was scrolled to. */}
        <main className={`main ${empty ? 'main-empty' : ''}`} inert={page !== 'chat'}>
          {empty ? (
            <h1 className="hero">
              {/* The mark hangs at the upper right of the name and takes no room, so the name stays in the middle. */}
              <span className="hero-name">
                StarBench
                <span className="hero-badge">{ABOUT.stage}</span>
              </span>
            </h1>
          ) : (
            <>
              <header className="header">
                <span className="workspace" title={workspace}>
                  {workspace || '未选择工作文件夹'}
                </span>
                {/* A session is tied to the folder it started in. */}
                {!sessionId && (
                  <button className="btn" onClick={() => void pickWorkspace()}>
                    选择文件夹
                  </button>
                )}
              </header>

              <div
                className="transcript"
                ref={scrollRef}
                onScroll={(e) => {
                  const el = e.currentTarget
                  // Only the person moving up, away from the end, lets go of it. A picture that takes
                  // its room further down leaves the end out of view too, with nobody having moved:
                  // this is told of only after the room is taken, and must not count as letting go.
                  if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) stickToBottom.current = true
                  else if (el.scrollTop < lastTop.current) stickToBottom.current = false
                  lastTop.current = el.scrollTop
                }}
                // A picture takes its room only once it is read, after the answer it belongs to was drawn.
                onLoadCapture={keepEndInView}
              >
                <Transcript items={items} workspace={workspace} onOpenSettings={() => setShowSettings(true)} />
                {running && !permission && <div className="working">{compacting ? '正在压缩上下文…' : '工作中…'}</div>}
              </div>
            </>
          )}

          {permission && <PermissionBar call={permission.call} onDecide={decide} />}

          <div className="dock">
            {/* Before the first message the folder is chosen right above the box it applies to. */}
            {empty && <FolderMenu workspace={workspace} onChoose={chooseWorkspace} />}
            <Composer
              blocked={blocked}
              running={running}
              settings={settings}
              modelInfo={modelInfo}
              onEffortChange={changeEffort}
              onFastChange={changeFast}
              onSelectModel={selectModel}
              onOpenSettings={() => setShowSettings(true)}
              onOpenPrompt={() => setShowPrompt(true)}
              onSend={(text, skill) => void send(text, skill)}
              onStop={() => sessionId && void api.stop(sessionId)}
            />
            {/* What the conversation has cost, once there is a reply to count. */}
            {settings?.stats && stats && stats.steps > 0 && !empty && (
              <StatusRow
                stats={stats}
                modelInfo={modelInfo}
                local={Boolean(active && isLocalAddress(active.baseURL))}
                compaction={settings.compaction}
                busy={running}
                onSetWindow={setContextWindow}
                onCompact={() => void compactNow()}
              />
            )}
          </div>
        </main>
        {page === 'plugins' && (
          <section className="page" aria-labelledby="plugins-title">
            <PluginsPage onBack={() => setPage('chat')} />
            {/* The model waits for an answer wherever the person is looking. */}
            {permission && <PermissionBar call={permission.call} onDecide={decide} />}
          </section>
        )}
      </div>

      {/* A plugin's panel, when one is open: a third column, to the right of the conversation. */}
      <PluginPanel />

      {showSettings && settings && (
        <SettingsDialog
          settings={settings}
          onClose={() => setShowSettings(false)}
          onSaved={(saved) => {
            setSettings(saved)
            setSaves((n) => n + 1)
          }}
          onWelcome={() => setWelcome(true)}
        />
      )}

      {showPrompt && active && <PromptDialog provider={active} onClose={() => setShowPrompt(false)} onSaved={setSettings} />}

      {welcome && (
        <div className="overlay">
          <div className="dialog dialog-small" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
            <h2 id="welcome-title">你正在使用 ChatGPT 套餐</h2>
            <p className="plan-text">
              在 StarBench 里用这个 ChatGPT 账号发出的请求，会计入你的 ChatGPT 套餐额度。用量可以在 ChatGPT 的设置里查看和管理。
            </p>
            <div className="dialog-actions">
              <a className="btn" href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">
                管理用量
              </a>
              <button className="btn btn-primary" autoFocus onClick={() => setWelcome(false)}>
                知道了
              </button>
            </div>
          </div>
        </div>
      )}

      {/* The notices of the app, in the corner of the window over everything else. */}
      <ToastStack />
    </div>
  )
}
