import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { PermissionDecision, SessionSummary, Settings, ToolCall } from '../../shared/types.ts'
import { itemsFromMessages, itemsReducer } from './items.ts'
import type { Item } from './items.ts'
import { SettingsDialog } from './Settings.tsx'
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
  const value = args.command ?? args.path ?? args.pattern ?? ''
  return typeof value === 'string' ? value : ''
}

const TOOL_LABELS: Record<string, string> = {
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

function ToolCard({ item }: { item: Extract<Item, { kind: 'tool' }> }) {
  const failed = item.output?.startsWith('Error:') || item.output === 'The user denied this tool call.'
  const status = item.output === undefined ? '运行中…' : failed ? '失败' : '完成'
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
      <div className="permission-title">允许{TOOL_LABELS[call.name] ?? call.name}？</div>
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
  const [showSettings, setShowSettings] = useState(false)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [workspace, setWorkspace] = useState(readLastWorkspace)
  const [items, dispatch] = useReducer(itemsReducer, [])
  const [running, setRunning] = useState(false)
  const [permission, setPermission] = useState<{ id: string; call: ToolCall } | null>(null)
  const [draft, setDraft] = useState('')

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

  const newChat = (): void => {
    sessionRef.current = null
    setSessionId(null)
    setWorkspace(readLastWorkspace())
    dispatch({ type: 'reset', items: [] })
  }

  const removeSession = async (id: string): Promise<void> => {
    await api.deleteSession(id)
    if (id === sessionId) newChat()
    refreshSessions()
  }

  const pickWorkspace = async (): Promise<void> => {
    const picked = await api.pickWorkspace()
    if (!picked) return
    setWorkspace(picked)
    try {
      localStorage.setItem(LAST_WORKSPACE_KEY, picked)
    } catch {
      // Remembering the folder is a convenience; the app works without it.
    }
  }

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || running || !workspace) return
    setDraft('')
    setRunning(true)
    stickToBottom.current = true
    dispatch({ type: 'user', text })
    try {
      const id = await api.send(sessionId, workspace, text)
      sessionRef.current = id
      setSessionId(id)
      refreshSessions()
    } catch (err) {
      setRunning(false)
      dispatch({ type: 'event', event: { type: 'error', message: errorText(err) } })
    }
  }

  const decide = (decision: PermissionDecision): void => {
    if (!permission) return
    void api.respondPermission(permission.id, decision)
    setPermission(null)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // isComposing: Enter that confirms an IME candidate must not send the message.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    }
  }

  const blocked = !settings?.hasApiKey ? '请先在设置中填写 API Key' : !workspace ? '请先选择工作文件夹' : ''

  return (
    <div className="app">
      <aside className="sidebar">
        <button className="btn btn-primary" onClick={newChat} disabled={running}>
          新对话
        </button>
        <nav className="sessions" aria-label="历史会话">
          {sessions.map((s) => (
            <div key={s.id} className={`session ${s.id === sessionId ? 'session-active' : ''}`}>
              <button
                className="session-open"
                disabled={running}
                onClick={() => void openSession(s.id)}
                title={s.workspace}
              >
                {s.title}
              </button>
              <button
                className="session-delete"
                disabled={running}
                onClick={() => void removeSession(s.id)}
                aria-label={`删除会话 ${s.title}`}
                title="删除"
              >
                ×
              </button>
            </div>
          ))}
        </nav>
        <button className="btn" onClick={() => setShowSettings(true)}>
          设置
        </button>
      </aside>

      <main className="main">
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
          <span className="model">{settings?.model}</span>
        </header>

        <div
          className="transcript"
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          }}
        >
          {items.length === 0 ? (
            <div className="empty">
              <h1>StarBench</h1>
              <p>选择一个工作文件夹，然后告诉我要做什么。</p>
            </div>
          ) : (
            <Transcript items={items} />
          )}
          {running && !permission && <div className="working">工作中…</div>}
        </div>

        {permission && <PermissionBar call={permission.call} onDecide={decide} />}

        <div className="composer">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={blocked || '输入消息，Enter 发送，Shift+Enter 换行'}
            disabled={Boolean(blocked)}
            rows={3}
          />
          {running ? (
            <button className="btn" onClick={() => sessionId && void api.stop(sessionId)}>
              停止
            </button>
          ) : (
            <button className="btn btn-primary" onClick={() => void send()} disabled={Boolean(blocked) || !draft.trim()}>
              发送
            </button>
          )}
        </div>
      </main>

      {showSettings && settings && (
        <SettingsDialog settings={settings} onClose={() => setShowSettings(false)} onSaved={setSettings} />
      )}
    </div>
  )
}
