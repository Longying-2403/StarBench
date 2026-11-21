import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  ModelInfo,
  PermissionDecision,
  ReasoningEffort,
  SessionSummary,
  Settings,
  ToolCall
} from '../../shared/types.ts'
import { Composer } from './Composer.tsx'
import { FolderMenu } from './FolderMenu.tsx'
import { itemsFromMessages, itemsReducer } from './items.ts'
import type { Item } from './items.ts'
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

function Transcript({ items }: { items: Item[] }) {
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
      if (!s.hasApiKey) setShowSettings(true)
    })
    refreshSessions()
    return api.onEvent(({ sessionId: id, event }) => {
      if (id !== sessionRef.current) return
      if (event.type === 'permission_request') setPermission({ id: event.id, call: event.call })
      if (event.type === 'turn_end') {
        setRunning(false)
        setPermission(null)
        refreshSessions()
      }
      dispatch({ type: 'event', event })
    })
  }, [refreshSessions])

  // The service is asked again when the connection changes; an older answer must not overwrite a newer one.
  // `saves` covers a corrected API key, which changes none of the three values the page can see.
  const { baseURL, model, hasApiKey } = settings ?? {}
  useEffect(() => {
    let current = true
    setModelInfo(null)
    if (hasApiKey) {
      api.getModelInfo().then(
        (info) => current && setModelInfo(info),
        () => {}
      )
    }
    return () => {
      current = false
    }
  }, [baseURL, model, hasApiKey, saves])

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

  const decide = (decision: PermissionDecision): void => {
    if (!permission) return
    void api.respondPermission(permission.id, decision)
    setPermission(null)
  }

  const blocked = !settings?.hasApiKey ? '请先在设置中填写 API Key' : !workspace ? '请先选择工作文件夹' : ''
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
              <Transcript items={items} />
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
            model={settings?.model ?? ''}
            modelInfo={modelInfo}
            effort={settings?.reasoningEffort ?? 'default'}
            onEffortChange={changeEffort}
            onSend={(text, skill) => void send(text, skill)}
            onStop={() => sessionId && void api.stop(sessionId)}
          />
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
        />
      )}
    </div>
  )
}
