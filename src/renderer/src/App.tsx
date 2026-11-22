import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CHATGPT_USAGE_URL } from '../../shared/types.ts'
import type {
  ModelInfo,
  PermissionDecision,
  ReasoningEffort,
  SessionIcon,
  SessionSummary,
  Settings,
  ToolCall
} from '../../shared/types.ts'
import { Composer } from './Composer.tsx'
import { FolderMenu } from './FolderMenu.tsx'
import { itemsFromMessages, itemsReducer } from './items.ts'
import type { Item } from './items.ts'
import { Notice } from './Notice.tsx'
import { SettingsDialog } from './Settings.tsx'
import { Sidebar } from './Sidebar.tsx'
import { errorText } from './util.ts'

const api = window.harness
const LAST_WORKSPACE_KEY = 'lastWorkspace'

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

function ToolCard({ item }: { item: Extract<Item, { kind: 'tool' }> }) {
  const { label: status, failed } = toolStatus(item.output)
  return (
    <details className={`tool ${failed ? 'tool-failed' : ''}`}>
      <summary>
        <span className="tool-name">{TOOL_LABELS[item.call.name] ?? item.call.name}</span>
        <span className="tool-summary">{callSummary(item.call)}</span>
        <span className="tool-status">{status}</span>
      </summary>
      <ToolDetails call={item.call} />
      {item.output !== undefined && (
        <div className="arg">
          <div className="arg-name">结果</div>
          <pre className="code">{item.output}</pre>
        </div>
      )}
    </details>
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

function Transcript({ items, onOpenSettings }: { items: Item[]; onOpenSettings: () => void }) {
  return (
    <>
      {items.map((item, index) => {
        if (item.kind === 'user') {
          return (
            <div key={index} className="msg msg-user">
              {item.skill && <span className="chip chip-block">Skill · {item.skill}</span>}
              {item.text}
            </div>
          )
        }
        if (item.kind === 'assistant') {
          return (
            <div key={index} className="msg msg-assistant">
              {item.reasoning && (
                <details className="reasoning" open={item.open && !item.text}>
                  <summary>思考过程</summary>
                  <div className="reasoning-body">{item.reasoning}</div>
                </details>
              )}
              {item.text && (
                <div className="markdown">
                  <Markdown
                    remarkPlugins={[remarkGfm]}
                    components={{ a: (props) => <a {...props} target="_blank" rel="noreferrer" /> }}
                  >
                    {item.text}
                  </Markdown>
                </div>
              )}
            </div>
          )
        }
        if (item.kind === 'tool') return <ToolCard key={index} item={item} />
        if (item.kind === 'notice') {
          return (
            <Notice key={index} className="msg" role="status">
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
  /** The note shown once, after the first sign-in with ChatGPT plan usage. */
  const [welcome, setWelcome] = useState(false)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [workspace, setWorkspace] = useState(readLastWorkspace)
  const [items, dispatch] = useReducer(itemsReducer, [])
  const [running, setRunning] = useState(false)
  const [permission, setPermission] = useState<{ id: string; call: ToolCall } | null>(null)

  // The event listener is registered once, so it reads the current session through a ref.
  const sessionRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

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
      if (event.type === 'turn_end') {
        setRunning(false)
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

  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [items, permission])

  const openSession = async (id: string): Promise<void> => {
    const session = await api.loadSession(id)
    if (!session) return refreshSessions()
    sessionRef.current = id
    setSessionId(id)
    setWorkspace(session.workspace)
    stickToBottom.current = true
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
    setSessionId(null)
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

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        activeId={sessionId}
        busy={running}
        onNewChat={newChat}
        onOpen={(id) => void openSession(id)}
        onRename={renameSession}
        onArchive={archiveSession}
        onIcon={markSession}
        onDelete={removeSession}
        onSettings={() => setShowSettings(true)}
      />

      <main className={`main ${empty ? 'main-empty' : ''}`}>
        {empty ? (
          <h1 className="hero">StarBench</h1>
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
                stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
              }}
            >
              <Transcript items={items} onOpenSettings={() => setShowSettings(true)} />
              {running && !permission && <div className="working">工作中…</div>}
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
            onSend={(text, skill) => void send(text, skill)}
            onStop={() => sessionId && void api.stop(sessionId)}
          />
          {/* Whose quota a message uses is said where the message is written. */}
          {onPlan && (
            <div className="plan-note">
              正在使用 ChatGPT 套餐 ·{' '}
              <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">
                管理用量
              </a>
            </div>
          )}
        </div>
      </main>

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
    </div>
  )
}
