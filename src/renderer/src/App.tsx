import { Fragment, useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ABOUT } from '../../shared/about.ts'
import type { Attachment } from '../../shared/attachments.ts'
import { folderKey, workspaceName } from '../../shared/folders.ts'
import { hasHidden, revealHidden } from '../../shared/hidden-chars.ts'
import { DEFAULT_PERMISSION_MODE, VIEW_ONLY_RESULT, runsOnItsOwnPart } from '../../shared/permissions.ts'
import type { PermissionMode } from '../../shared/permissions.ts'
import { formatShare, formatTokens } from '../../shared/stats.ts'
import { CHATGPT_USAGE_URL, isLocalAddress } from '../../shared/types.ts'
import type {
  CompactionMark,
  ModelInfo,
  PermissionDecision,
  ProviderInfo,
  ReasoningEffort,
  SessionIcon,
  SessionSummary,
  Settings,
  ToolCall
} from '../../shared/types.ts'
import { AnswerText } from './AnswerText.tsx'
import { AttachmentRow } from './Attachments.tsx'
import { Composer } from './Composer.tsx'
import { FolderMenu } from './FolderMenu.tsx'
import { FolderIcon, PromptIcon, StarIcon, WarningIcon } from './icons.tsx'
import { whenExact, whenText } from '../../shared/when.ts'
import { itemsFromMessages, lastSummaryAt, turnEnds } from './items.ts'
import type { Item } from './items.ts'
import { MEMORY_DENIED_LABEL, MEMORY_TOOL_LABELS, MemoryNotice, MemorySensitiveBar, isSensitiveMemoryCall, memoryCallSummary } from './MemoryNotice.tsx'
import { MemoryPage } from './MemoryPage.tsx'
import type { MemoryScope } from '../../shared/memory.ts'
import { Notice } from './Notice.tsx'
import { PluginPanel, PluginRow, useAnnouncePlace } from './PluginUi.tsx'
import { PluginsPage } from './PluginsPage.tsx'
import { PromptDialog } from './PromptDialog.tsx'
import { SettingsPage } from './Settings.tsx'
import type { SettingsTab } from './Settings.tsx'
import { Sidebar } from './Sidebar.tsx'
import { StatusRow } from './StatusRow.tsx'
import { TipLayer } from './Tips.tsx'
import { ToastStack, notify, toasts } from './Toasts.tsx'
import { BalanceNotices } from './Balance.tsx'
import { balanceServiceOf } from '../../shared/usage.ts'
import { newerBuild, useUpdateNotice, useUpdates } from './UpdateCheck.tsx'
import { LinkAsk } from './LinkAsk.tsx'
import { TrustDialog } from './TrustDialog.tsx'
import { TurnRail } from './TurnRail.tsx'
import { EMPTY_VIEW, draftKey, unseenIds, viewsReducer, workingIds } from './views.ts'
import { errorText, isWindows, useNow } from './util.ts'

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
  // A note of the memory reads as where it goes, its kind and what it says.
  const memory = memoryCallSummary(call)
  if (memory !== null) return memory
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
  run_command: '执行命令',
  ...MEMORY_TOOL_LABELS
}

/** What is shown of a call's arguments: each by its name, the value as written or as JSON; with none to name, the raw text. */
function shownArgs(call: ToolCall): { entries: [string, string][]; raw: string | null } {
  const entries = Object.entries(parseArgs(call))
  if (entries.length === 0) return { entries: [], raw: call.arguments }
  return { entries: entries.map(([key, value]): [string, string] => [key, typeof value === 'string' ? value : JSON.stringify(value, null, 2)]), raw: null }
}

/** Whether what is shown of a call holds a character that would not show (shared/hidden-chars.ts). */
function hidesCharacters(call: ToolCall): boolean {
  const { entries, raw } = shownArgs(call)
  return [raw ?? '', ...entries.flat()].some(hasHidden)
}

/**
 * The folder a write of the app's own goes into where git or an editor runs commands from its
 * files by itself (shared/permissions.ts), for saying why such a write is asked about; null for
 * any other call. The main process also follows links, which the page cannot: there it may ask
 * without this to say why.
 */
function runsOnItsOwnTarget(call: ToolCall, workspace: string): string | null {
  if (call.name !== 'write_file' && call.name !== 'edit_file') return null
  const target = parseArgs(call).path
  return typeof target === 'string' ? runsOnItsOwnPart(workspace, target) : null
}

/** How a character that would not show is marked: its code point in a red frame. */
const HIDDEN_MARK = { color: 'var(--danger)', border: '1px solid var(--danger)', borderRadius: 3, padding: '0 2px', margin: '0 1px', fontSize: '0.85em' } as const

/**
 * Text as it will be used, with every character that would not show marked where it is: a mark
 * that turns the direction of the text around can make a command read as something it is not.
 */
function Shown({ text }: { text: string }) {
  return (
    <>
      {revealHidden(text).map((piece, i) =>
        typeof piece === 'string' ? (
          <Fragment key={i}>{piece}</Fragment>
        ) : (
          <span key={i} data-tip="看不见的字符" style={HIDDEN_MARK}>
            {piece.hidden}
          </span>
        )
      )}
    </>
  )
}

function ToolDetails({ call }: { call: ToolCall }) {
  const { entries, raw } = shownArgs(call)
  if (raw !== null) {
    return (
      <pre className="code">
        <Shown text={raw} />
      </pre>
    )
  }
  return (
    <>
      {entries.map(([key, value]) => (
        <div key={key} className="arg">
          <div className="arg-name">
            <Shown text={key} />
          </div>
          <pre className="code">
            <Shown text={value} />
          </pre>
        </div>
      ))}
    </>
  )
}

/**
 * How a tool call ended, judged from the result text the agent loop recorded for it. `held`: it
 * was kept from running, or stopped, by the person: their no, their stop, or the conversation
 * being set to view-only. That is their decision at work and not a failure, so it is shown as a
 * warning and not as an error.
 */
function toolStatus(output: string | undefined): { label: string; how: 'fine' | 'held' | 'failed' } {
  if (output === undefined) return { label: '运行中…', how: 'fine' }
  if (output === 'The user denied this tool call.') return { label: '存取被拒', how: 'held' }
  // Not run, and nobody was asked: the conversation is set to view-only.
  if (output === VIEW_ONLY_RESULT) return { label: '存取被拒（仅可查看）', how: 'held' }
  // A command stopped part-way keeps the output it had and ends with the reason in brackets.
  if (output === 'Cancelled by user' || output.endsWith('[Cancelled by user]')) return { label: '已取消', how: 'held' }
  if (/\[Timed out after \d+s\]$/.test(output)) return { label: '超时', how: 'failed' }
  if (output.startsWith('Error:')) return { label: '失败', how: 'failed' }
  return { label: '完成', how: 'fine' }
}

function ToolCard({ item, faded }: { item: Extract<Item, { kind: 'tool' }>; faded: boolean }) {
  const told = toolStatus(item.output)
  const { how } = told
  // A note the person did not let the memory keep was not kept: their decision, said in those words.
  const status = how === 'held' && item.call.name === 'remember' && item.output === 'The user denied this tool call.' ? MEMORY_DENIED_LABEL : told.label
  return (
    <details className={`tool${how === 'failed' ? ' tool-failed' : how === 'held' ? ' tool-held' : ''}${faded ? ' faded' : ''}`}>
      <summary>
        <span className="tool-name">{TOOL_LABELS[item.call.name] ?? item.call.name}</span>
        <span className="tool-summary">
          <Shown text={callSummary(item.call)} />
        </span>
        {/* Still shown here in full; the model is sent a line in its place. */}
        {item.cleared && <span className="tool-cleared">结果已清理</span>}
        <span className="tool-status">
          {how === 'held' && <WarningIcon />}
          {status}
        </span>
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

/** What the services' error codes for a search or page read mean; one not listed is shown as it came. */
const WEB_ERRORS: Record<string, string> = {
  max_uses_exceeded: '这一步能用的搜索次数用完了',
  too_many_requests: '请求太频繁，服务暂时拒绝了',
  query_too_long: '搜索词太长',
  invalid_input: '服务认为输入无效',
  invalid_tool_input: '服务认为输入无效',
  unavailable: '搜索服务暂时不可用',
  url_not_accessible: '打不开这个网址',
  url_not_allowed: '这个网址不允许读取',
  url_too_long: '网址太长',
  unsupported_content_type: '不支持这种网页内容'
}

/** A link in Markdown that shows `title` and leads to `url`, whatever either holds. */
const linkTo = (title: string, url: string): string => `[${title.replace(/[\\[\]]/g, '\\$&')}](<${url.replace(/[<>\s]/g, encodeURIComponent)}>)`

/**
 * Google's Search Suggestions for an answer that its search went into: a row of links to the same
 * searches on Google. Google's terms want them shown with the answer, as they came and with nothing
 * put between them and where they lead (Gemini API Additional Terms, "Grounding with Google
 * Search"), so they are not folded away with the search. The HTML is Google's and is drawn
 * unchanged, in a frame of its own that runs no script and cannot reach the page: all it can do
 * is ask for a link to be opened, which the app does in the browser. It follows the app's light
 * or dark look (设置 → 外观), as the page does.
 */
function SearchSuggestions({ html, faded }: { html: string; faded: boolean }) {
  // Google's suggestions are styles, drawings of their own and links. The frame fetches nothing:
  // a picture from the web would tell its server each time the conversation is opened, past the
  // rule that web pictures load only when pressed.
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><meta name="color-scheme" content="light dark"><base target="_blank"><style>html,body{margin:0;padding:1px;background:transparent;overflow:hidden}</style></head><body>${html}</body></html>`
  return <iframe className={`search-suggestions${faded ? ' faded' : ''}`} title="Google 搜索建议" sandbox="allow-popups" srcDoc={page} />
}

/**
 * A web search or page read that the model's service did by itself. Nothing ran on this
 * computer and nothing was asked: it says what the service told, and links the pages it found.
 */
function WebCard({ item, faded, workspace }: { item: Extract<Item, { kind: 'web' }>; faded: boolean; workspace: string }) {
  const { activity } = item
  const reading = activity.kind === 'open'
  const sources = activity.sources ?? []
  const status = activity.status === 'running' ? (reading ? '读取中…' : '搜索中…') : activity.status === 'failed' ? '失败' : '完成'
  const summary = reading ? (activity.url ?? activity.queries?.join(' · ') ?? '') : (activity.queries?.join(' · ') ?? '')
  return (
    <>
      <details className={`tool tool-web${activity.status === 'failed' ? ' tool-failed' : ''}${faded ? ' faded' : ''}`}>
        <summary>
          <span className="tool-name">{reading ? '读取网页' : '搜索网页'}</span>
          <span className="tool-summary">
            <Shown text={summary} />
          </span>
          <span className="tool-status">{status}</span>
        </summary>
        {activity.error && (
          <div className="arg">
            <div className="arg-name">原因</div>
            {/* A name of the service's choosing finds only the table's own entries, never what every object inherits. */}
            <div className="hint">{(Object.hasOwn(WEB_ERRORS, activity.error) ? WEB_ERRORS[activity.error] : undefined) ?? String(activity.error)}</div>
          </div>
        )}
        {sources.length > 0 && (
          <div className="arg web-sources">
            <div className="arg-name">{reading ? '读到的网页' : `找到 ${sources.length} 个网页`}</div>
            <AnswerText text={sources.map((s) => `1. ${linkTo(s.title ?? s.url, s.url)}`).join('\n')} workspace={workspace} />
          </div>
        )}
        {activity.status !== 'running' && sources.length === 0 && !activity.error && <div className="hint">服务没有列出找到的网页。</div>}
      </details>
      {/* Not folded away with the search: Google wants these seen with the answer. */}
      {activity.suggestions && <SearchSuggestions html={activity.suggestions} faded={faded} />}
    </>
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

/** When something in the conversation happened, under it: said from now, with the exact moment for whoever asks. */
function MessageTime({
  at,
  now,
  sent,
  plain,
  faded
}: {
  at: number
  now: number
  /** Under a message of the person, at the right like the message. */
  sent?: boolean
  /** The message went out as a plain chat, which is said in front of its time. */
  plain?: boolean
  faded: boolean
}) {
  return (
    <div className={`msg-time${sent ? ' msg-time-sent' : ''}${faded ? ' faded' : ''}`}>
      {plain && (
        <span className="badge msg-plain" data-tip="这条消息是以纯对话发出的：没有给模型任何工具，也没有带 StarBench 的提示词、Skills 列表和记忆。">
          纯对话
        </span>
      )}
      <span data-tip={`${sent ? '发送于' : '完成于'} ${whenExact(at)}`}>{whenText(at, now)}</span>
    </div>
  )
}

function Transcript({
  items,
  workspace,
  running,
  providers,
  onOpenSettings
}: {
  items: Item[]
  workspace: string
  /** A turn is under way: what the model has written of it so far is not finished, and has no time yet. */
  running: boolean
  /** The model services as they are set up: an error of a ChatGPT sign-in says which account it is of. */
  providers: readonly ProviderInfo[]
  onOpenSettings: () => void
}) {
  // What stands above the last summary is no longer sent to the model. It stays, paler, for the person to read.
  const from = lastSummaryAt(items)
  // Under each message of the person, when it was sent; under the last thing of each turn, when the model had finished.
  const ends = turnEnds(items, running)
  const now = useNow(30_000)

  /** One item as it is drawn, with the moment a message of the person was sent under it. */
  const draw = (item: Item, faded: boolean): ReactNode => {
    const pale = faded ? ' faded' : ''
    if (item.kind === 'mark') return <MarkLine mark={item.mark} workspace={workspace} faded={faded} />
    if (item.kind === 'user') {
      return (
        <>
          {/* `data-turn`: where a turn begins, for the rail of the turns (TurnRail.tsx). */}
          <div className={`msg msg-user${pale}`} data-turn="">
            {item.skill && <span className="chip chip-block">Skill · {item.skill}</span>}
            {item.attachments && <AttachmentRow files={item.attachments} sent />}
            {item.text}
          </div>
          {item.at !== undefined && <MessageTime at={item.at} now={now} sent plain={item.plain} faded={faded} />}
        </>
      )
    }
    if (item.kind === 'assistant') {
      return (
        <div className={`msg msg-assistant${pale}`}>
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
    if (item.kind === 'tool') return <ToolCard item={item} faded={faded} />
    if (item.kind === 'web') return <WebCard item={item} faded={faded} workspace={workspace} />
    if (item.kind === 'notice') {
      return (
        <Notice className={`msg${pale}`} role="status">
          {item.text}
        </Notice>
      )
    }
    // Whose request it was: several ChatGPT accounts can be signed in, and the way out is that account's.
    const account = item.provider ? providers.find((p) => p.id === item.provider)?.account?.email : undefined
    const whose = account ? `账号 ${account}：` : ''
    if (item.hint === 'chatgpt-usage') {
      return (
        <ErrorNotice title="ChatGPT 套餐：已达到用量上限" text={`${whose}请到 ChatGPT 的设置里查看你的套餐用量，或者给这个应用设置的用量上限。`} detail={item.message}>
          <a className="btn btn-primary" href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">
            管理用量
          </a>
        </ErrorNotice>
      )
    }
    if (item.hint === 'chatgpt-sign-in') {
      return (
        <ErrorNotice title="ChatGPT 登录已失效" text={`${whose}需要重新用 ChatGPT 登录，才能继续使用套餐额度。`} detail={item.message}>
          <button className="btn btn-primary" onClick={onOpenSettings}>
            打开设置重新登录
          </button>
        </ErrorNotice>
      )
    }
    return (
      <div className="msg msg-error" role="alert">
        {item.message}
      </div>
    )
  }

  return (
    <>
      {items.map((item, index) => {
        const faded = index < from
        const finished = ends.get(index)
        return (
          <Fragment key={index}>
            {draw(item, faded)}
            {/* Where a turn ends: when the model had finished the last thing it wrote in it. */}
            {finished !== undefined && <MessageTime at={finished} now={now} faded={faded} />}
          </Fragment>
        )
      })}
    </>
  )
}

function PermissionBar({
  call,
  workspace,
  onDecide
}: {
  call: ToolCall
  /** The folder of the conversation that asks: where its files are, and where a command runs. */
  workspace: string
  onDecide: (decision: PermissionDecision) => void
}) {
  // A note that looks sensitive is asked about in the memory's own words (MemoryNotice.tsx).
  if (isSensitiveMemoryCall(call)) return <MemorySensitiveBar call={call} onDecide={onDecide} />
  const label = TOOL_LABELS[call.name]
  const runsCommands = runsOnItsOwnTarget(call, workspace)
  return (
    <div className="permission" role="alertdialog" aria-label="权限确认">
      <div className="permission-title">{label ? `允许${label}？` : `允许调用工具 ${call.name}？`}</div>
      <div className="hint" data-tip={workspace}>
        工作文件夹：{workspace || '（未选择）'}
      </div>
      {hidesCharacters(call) && (
        <Notice role="alert">这次调用里有看不见的字符，已用红框标出。显示出来的内容可能和实际执行的不一样，看清楚再决定。</Notice>
      )}
      {runsCommands && (
        <Notice role="status">
          要改的文件在 {runsCommands} 文件夹里。git 和编辑器会自己运行这类文件夹里写的命令（编辑器打开文件夹时就会运行 git），所以这类改动在“工作区内修改”模式下也会先问你。
        </Notice>
      )}
      <div className="permission-body">
        <ToolDetails call={call} />
      </div>
      <div className="permission-actions">
        <button className="btn btn-primary" onClick={() => onDecide('allow')}>
          允许
        </button>
        {/* What it lets through is said on it: every later call of this kind in this conversation, until the app starts again. */}
        <button className="btn" onClick={() => onDecide('always')} data-tip="这个对话里之后同类的调用都直接放行，重启应用后恢复询问。">
          {`本次会话不再询问「${label ?? call.name}」`}
        </button>
        <button className="btn" onClick={() => onDecide('deny')}>
          拒绝
        </button>
      </div>
    </div>
  )
}

/**
 * The button for the person's own prompt, at the right end of the bar above the message box: it
 * is about every message to the models of the provider in use, not about the one being written.
 * Lit when a prompt is set, which changes every answer.
 */
function PromptButton({ settings, onOpen }: { settings: Settings | null; onOpen: () => void }) {
  /** What the person wrote for the models of the provider in use, if anything. */
  const prompt = settings?.providers.find((p) => p.id === settings.activeProviderId)?.prompt
  const text = !prompt ? '提示词：给当前模型服务写一段固定的要求' : prompt.replace ? '提示词：已设置，替换了内置提示' : '提示词：已设置，加在内置提示后面'
  return (
    // Does not wait for a folder or a model: what it sets counts from the next message, whenever that is.
    <button type="button" className="btn btn-small" aria-haspopup="dialog" aria-label={text} data-tip={text} data-set={prompt ? '' : undefined} disabled={!settings} onClick={onOpen}>
      <PromptIcon />
      <span>提示词</span>
    </button>
  )
}

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null)
  /** Counts saves made on the settings page. */
  const [saves, setSaves] = useState(0)
  /** What the main part of the window shows: the conversation, or a page lying over it: the plugins, the settings, or the memory. */
  const [page, setPage] = useState<'chat' | 'plugins' | 'settings' | 'memory'>('chat')
  /** The note the memory's page shows first: the one a notice above the message box was about. */
  const [memoryFocus, setMemoryFocus] = useState<{ id: string; scope: MemoryScope; workspace?: string } | null>(null)
  /** The person's own prompt for the provider in use is being edited. */
  const [showPrompt, setShowPrompt] = useState(false)
  /** The note shown once, after the first sign-in with ChatGPT plan usage. */
  const [welcome, setWelcome] = useState(false)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [workspace, setWorkspace] = useState(readLastWorkspace)
  /** What the model may do without asking in the conversation on the page. A new chat starts by asking. */
  const [mode, setMode] = useState<PermissionMode>(DEFAULT_PERMISSION_MODE)
  /** The mode as the person set it last, for a message whose sending began before they changed it (`send`). */
  const modeRef = useRef(mode)
  modeRef.current = mode
  /**
   * The folder a new chat is about to be in that the app has not been in before, while the person
   * is asked whether a model may read it. `entered`: the chat is in it already (it was the folder
   * used last), so a no has to take the chat out of it again.
   */
  const [trust, setTrust] = useState<{ folder: string; entered?: true } | null>(null)
  /**
   * What the page holds of each conversation: the one on show, and every other that is at work
   * (views.ts). Several can be at work at once, and each goes on being followed while another is
   * on show.
   */
  const [views, dispatchViews] = useReducer(viewsReducer, { [draftKey(0)]: EMPTY_VIEW })
  /** The chat on the page while it has no id yet. Each new chat gets a key of its own, so that one being sent stays apart from the next. */
  const [draft, setDraft] = useState(draftKey(0))
  const drafts = useRef(0)
  /** Which view is on show: that of the session on the page, or of the chat that has no id yet. */
  const pageKey = sessionId ?? draft
  const { items, running, compacting, betweenTurns, stats } = views[pageKey] ?? EMPTY_VIEW
  /** Both again for what runs later than this drawing of the page: an answer of the main process, an event. */
  const pageKeyRef = useRef(pageKey)
  pageKeyRef.current = pageKey
  const viewsRef = useRef(views)
  viewsRef.current = views
  /** Says in the conversation on show that something went wrong. */
  const complain = (message: string): void => dispatchViews({ type: 'event', key: pageKeyRef.current, event: { type: 'error', message }, onPage: true })
  /** The modes set here for conversations that are at work: their files hold them only once the turn is over. */
  const modesAtWork = useRef(new Map<string, PermissionMode>())
  /**
   * The questions waiting for an answer, by the session that asked. A question waits with its
   * session whether that is on the page or not: going back to the session shows it again, and a
   * question is never shown with another session's conversation.
   */
  const [prompts, setPrompts] = useState<Record<string, { id: string; call: ToolCall }>>({})
  const permission = sessionId ? (prompts[sessionId] ?? null) : null

  // The components of plugins are told which conversation is on the page, and which model it talks to.
  useAnnouncePlace(sessionId, workspace, running, settings)
  // A newer build that a look of the app's own finds is said in the corner of the window.
  useUpdateNotice()
  /** What is known about newer builds: while one is out, the way to it stands beside the settings at the foot of the sidebar. */
  const updates = useUpdates()
  /** The section of the settings the person was sent to. Forgotten when they leave the settings, so that the next visit starts where it always does. */
  const [settingsFocus, setSettingsFocus] = useState<{ tab: SettingsTab } | null>(null)
  useEffect(() => {
    if (page !== 'settings') setSettingsFocus(null)
  }, [page])

  // The event listener is registered once, so it reads the current session through a ref.
  const sessionRef = useRef<string | null>(null)
  /** The sessions other than the one on the page that were heard to be at work, until their turn ends. */
  const elsewhere = useRef(new Set<string>())
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
      // Nothing can be sent yet: the settings are where that is put right.
      if (!s.ready) setPage('settings')
    })
    refreshSessions()
    return api.onEvent(({ sessionId: id, event }) => {
      // A conversation was given the name the model wrote for it: nothing of a turn, and the list is all that shows it.
      if (event.type === 'titled') return refreshSessions()
      // The switch was taken back for the model, whichever session found out; the page shows it at once.
      if (event.type === 'notice' && event.code === 'fast-mode-refused') setSettings((s) => (s ? { ...s, fastMode: false } : s))
      // So was a level of thinking the service would not take. What the model is at now depends on
      // the model, and it may not be the one in use any more: the settings are read again.
      if (event.type === 'notice' && event.code === 'effort-refused') void api.getSettings().then(setSettings)
      // A question is kept with the session that asked it, and goes when that session's turn ends.
      if (event.type === 'permission_request') {
        setPrompts((all) => ({ ...all, [id]: { id: event.id, call: event.call } }))
        if (id !== sessionRef.current) {
          // A session started elsewhere than on this page: it is put in the list, if it is not there yet, and named in a notice.
          const tell = (title?: string): void => {
            notify({ key: `permission:${id}`, title: '有对话在等你确认', text: `${title ? `「${title}」` : '另一个对话'}要调用一个需要你允许的工具，打开它就能看到。` })
          }
          api.listSessions().then(
            (list) => {
              setSessions(list)
              tell(list.find((s) => s.id === id)?.title)
            },
            () => tell()
          )
        }
      }
      if (event.type === 'turn_end') {
        setPrompts(({ [id]: _ended, ...rest }) => rest)
        toasts.dismissKey(`permission:${id}`)
        modesAtWork.current.delete(id)
      }
      // A session at work elsewhere than on this page is shown as such in the list, which is
      // asked for anew when the first word of its turn comes and when the turn ends.
      if (id !== sessionRef.current) {
        if (event.type === 'turn_end') {
          elsewhere.current.delete(id)
          refreshSessions()
        } else if (!elsewhere.current.has(id)) {
          elsewhere.current.add(id)
          refreshSessions()
        }
      }
      const onPage = id === sessionRef.current
      if (event.type === 'turn_end' && onPage) {
        refreshSessions()
        // A turn the page did not follow from its start may show with gaps: the conversation is
        // read from its file, now that it is whole there. Not if the person has sent again meanwhile.
        if (viewsRef.current[id]?.partial) {
          void api.loadSession(id).then((session) => {
            if (!session || sessionRef.current !== id || viewsRef.current[id]?.running) return
            dispatchViews({ type: 'opened', id, items: itemsFromMessages(session.messages), stats: session.stats ?? null, running: false })
          })
        }
      }
      // The sign-in was given up behind the page's back; what it shows about it is out of date.
      if (event.type === 'error' && event.hint === 'chatgpt-sign-in') void api.getSettings().then(setSettings)
      // Every conversation keeps what happens in it, on show or not (views.ts). With the time, for
      // what the event finishes: the conversation says under a reply when it was done.
      dispatchViews({ type: 'event', key: id, event, at: Date.now(), onPage })
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

  /**
   * Lets go of the conversation on show as another takes its place. One that is at work is kept:
   * it goes on being followed, and shows as it stands by then when it is gone back to.
   */
  const leave = (next: string): void => {
    const from = pageKeyRef.current
    if (from !== next && !viewsRef.current[from]?.running) dispatchViews({ type: 'dropped', key: from })
  }

  const openSession = async (id: string): Promise<void> => {
    // A question this session asked is answered on its page, which is about to show.
    toasts.dismissKey(`permission:${id}`)
    const session = await api.loadSession(id)
    if (!session) return refreshSessions()
    leave(id)
    sessionRef.current = id
    setPage('chat')
    setSessionId(id)
    setWorkspace(session.workspace)
    setMode(modesAtWork.current.get(id) ?? session.permissionMode ?? DEFAULT_PERMISSION_MODE)
    stickToBottom.current = true
    // Where the conversation before this one was scrolled to says nothing about this one.
    lastTop.current = 0
    const held = viewsRef.current[id]
    // A conversation the page has followed since its turn began shows as the page has it. While
    // the turn runs its file is behind; and a turn that ended while another conversation was on
    // show may have ended in an error, which no file holds. Any other is shown as its file has it.
    if (held && !held.partial && (held.running || held.unseen)) dispatchViews({ type: 'seen', key: id })
    else {
      const atWork = held?.running ?? sessions.find((s) => s.id === id)?.running === true
      dispatchViews({ type: 'opened', id, items: itemsFromMessages(session.messages), stats: session.stats ?? null, running: atWork })
    }
  }

  /** Whether the person said a model may read a folder. Unknown, and taken for yes, until the settings have been read. */
  const trusted = (dir: string): boolean => !settings || settings.trustedFolders.some((known) => folderKey(known, isWindows) === folderKey(dir, isWindows))

  /** Makes a folder the one the chat on the page is in, and the one a new chat starts in. */
  const enterWorkspace = (dir: string): void => {
    setWorkspace(dir)
    try {
      localStorage.setItem(LAST_WORKSPACE_KEY, dir)
    } catch {
      // Remembering the folder is a convenience; the app works without it.
    }
  }

  /** A folder was chosen for a new chat. One the app has not been in before is asked about first. */
  const chooseWorkspace = (dir: string): void => {
    if (trusted(dir)) enterWorkspace(dir)
    else setTrust({ folder: dir })
  }

  // A new chat starts in the folder used last. Should that be one the person never said yes to
  // (the settings were changed by hand, or the workspace was taken out of the app), it is asked
  // about like any other, and a no leaves the chat without a folder.
  const unasked = !sessionId && Boolean(workspace) && !trust && !trusted(workspace)
  useEffect(() => {
    if (unasked) setTrust({ folder: workspace, entered: true })
  }, [unasked, workspace])

  /** The person's yes to the folder they are asked about. */
  const trustFolder = async (): Promise<void> => {
    if (!trust) return
    const saved = await api.trustFolder(trust.folder)
    setSettings(saved)
    enterWorkspace(trust.folder)
    setTrust(null)
  }

  /** Their no. A chat that was already in the folder is taken out of it; otherwise it stays where it was. */
  const distrustFolder = (): void => {
    if (trust?.entered) {
      setWorkspace('')
      try {
        localStorage.removeItem(LAST_WORKSPACE_KEY)
      } catch {
        // Nothing else depends on it.
      }
    }
    setTrust(null)
  }

  /** Starts an empty chat: in the given folder, or else in the one used last. */
  const newChat = (dir?: string): void => {
    const key = draftKey(++drafts.current)
    leave(key)
    dispatchViews({ type: 'draft', key })
    setDraft(key)
    sessionRef.current = null
    setPage('chat')
    setSessionId(null)
    // What a conversation was allowed is not carried over to the next one.
    setMode(DEFAULT_PERMISSION_MODE)
    if (dir && trusted(dir)) enterWorkspace(dir)
    else {
      // Not the folder of the conversation that was on the page: a new chat is in the one used last, until another is said yes to.
      setWorkspace(readLastWorkspace())
      if (dir) setTrust({ folder: dir })
    }
  }

  const removeSession = async (id: string): Promise<void> => {
    await api.deleteSession(id)
    if (id === sessionId) newChat()
    dispatchViews({ type: 'dropped', key: id })
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

  const renameWorkspace = async (folder: string, name: string): Promise<void> => {
    setSettings(await api.renameWorkspace(folder, name))
  }

  const archiveWorkspace = async (folder: string): Promise<void> => {
    try {
      const archived = await api.archiveWorkspace(folder)
      if (sessionId && archived.includes(sessionId)) newChat()
    } finally {
      // Also when it failed: the list then shows how far it came.
      refreshSessions()
    }
  }

  /** Deletes the sessions the person was shown under a workspace, and takes the workspace out of the list and out of the folders on offer. */
  const removeWorkspace = async (folder: string, ids: string[]): Promise<void> => {
    try {
      setSettings(await api.removeWorkspace(folder, ids))
      const same = (dir: string): boolean => folderKey(dir, isWindows) === folderKey(folder, isWindows)
      // A new chat no longer starts in the folder by itself.
      if (same(readLastWorkspace())) {
        try {
          localStorage.removeItem(LAST_WORKSPACE_KEY)
        } catch {
          // Without it the folder is remembered until another one is used; nothing else depends on it.
        }
      }
      if (sessionId ? ids.includes(sessionId) : same(workspace)) newChat()
    } finally {
      refreshSessions()
    }
  }

  const pickWorkspace = async (): Promise<void> => {
    const picked = await api.pickWorkspace()
    if (picked) chooseWorkspace(picked)
  }

  /** Sets what the model may do without asking in the conversation on the page. A saved one keeps it; in one at work it counts from the next tool call. */
  const changeMode = (next: PermissionMode): void => {
    setMode(next)
    modeRef.current = next
    if (!sessionId) return
    if (running) modesAtWork.current.set(sessionId, next)
    saveMode(sessionId, next)
  }
  const saveMode = (id: string, next: PermissionMode): void => {
    api.setPermissionMode(id, next).catch((err: unknown) => notify({ kind: 'error', title: '权限设置没有保存', text: errorText(err) }))
  }

  const send = async (text: string, skill: string | undefined, attachments: Attachment[]): Promise<void> => {
    // Of the conversation on show: others may be at work at the same time.
    if (running || !workspace) return
    const key = pageKey
    stickToBottom.current = true
    lastTop.current = 0
    const sentAt = Date.now()
    dispatchViews({ type: 'user', key, text, skill, attachments, at: sentAt })
    const sentMode = mode
    try {
      const { id, plain } = await api.send(sessionId, workspace, text, skill, { mode: sentMode, ...(attachments.length ? { attachments } : {}) })
      // The person may have gone to another conversation while the message was on its way: the
      // page stays where they are, and this one goes on in the list.
      const onPage = pageKeyRef.current === key
      // A new chat has its id from here on, and what the page held of it goes by that.
      if (key !== id) dispatchViews({ type: 'bound', key, id, onPage })
      // Whether it went out as a plain chat is for the main process to say: the message gets its mark from that.
      if (plain) dispatchViews({ type: 'plain', key: id, at: sentAt })
      if (onPage) {
        sessionRef.current = id
        setSessionId(id)
        // Changed while the message was on its way: a new chat had no id to send the change with
        // then, and the turn began with the mode it was sent with. It goes by the button from here on.
        if (modeRef.current !== sentMode) {
          modesAtWork.current.set(id, modeRef.current)
          saveMode(id, modeRef.current)
        }
      }
      refreshSessions()
    } catch (err) {
      dispatchViews({ type: 'failed', key, message: errorText(err) })
      // A sign-in that turned out to be over is the usual reason; the page then says so by the message box.
      void api.getSettings().then(setSettings)
    }
  }

  const changeEffort = (effort: ReasoningEffort): void => {
    // Shown at once; the saved settings replace it when they come back.
    setSettings((s) => (s ? { ...s, reasoningEffort: effort } : s))
    api.setReasoningEffort(effort).then(setSettings, (err) => {
      complain(errorText(err))
      void api.getSettings().then(setSettings)
    })
  }

  const changeFast = (on: boolean): void => {
    // Shown at once, like the effort; the saved settings replace it when they come back.
    setSettings((s) => (s ? { ...s, fastMode: on } : s))
    api.setFastMode(on).then(setSettings, (err) => {
      complain(errorText(err))
      void api.getSettings().then(setSettings)
    })
  }

  const changeWebSearch = (on: boolean): void => {
    // Like Fast Mode: shown at once, replaced by the saved settings when they come back.
    setSettings((s) => (s ? { ...s, webSearch: on } : s))
    api.setWebSearch(on).then(setSettings, (err) => {
      complain(errorText(err))
      void api.getSettings().then(setSettings)
    })
  }

  const selectModel = (providerId: string, modelId: string): void => {
    api.selectModel(providerId, modelId).then(setSettings, (err) => {
      complain(errorText(err))
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
    const id = sessionId
    dispatchViews({ type: 'work', key: id, on: true })
    try {
      const report = await api.compactSession(id)
      if (report.problem) {
        notify({ kind: 'error', title: '没能写出摘要', text: report.done ? `较早的工具结果已经清理。服务返回：${report.problem}` : `服务返回：${report.problem}` })
      } else if (!report.done) {
        notify({ title: '没有可以压缩的内容', text: '对话还不长，或者较早的部分已经压缩过了。' })
      }
    } catch (err) {
      notify({ kind: 'error', title: '压缩没有完成', text: errorText(err) })
    } finally {
      dispatchViews({ type: 'work', key: id, on: false })
      refreshSessions()
    }
  }

  const decide = (decision: PermissionDecision): void => {
    if (!permission || !sessionId) return
    void api.respondPermission(permission.id, decision)
    setPrompts(({ [sessionId]: _answered, ...rest }) => rest)
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
        names={settings?.workspaceNames}
        // While another page lies over the conversation, the list points at none of them.
        activeId={page === 'chat' ? sessionId : null}
        // The conversations the page knows to be at work: its own at once, and those it has heard of. Of the rest the list says so.
        workingIds={workingIds(views)}
        // Those in which a turn ended while another conversation was on show.
        unseenIds={unseenIds(views)}
        // The sessions whose turn stands still until the person has answered a question of theirs.
        waitingIds={Object.keys(prompts)}
        page={page}
        // Until the settings are read, as the app comes: with them.
        showTimes={settings?.sessionTimes !== false}
        onNewChat={newChat}
        onOpen={(id) => void openSession(id)}
        onRename={renameSession}
        onArchive={archiveSession}
        onIcon={markSession}
        onDelete={removeSession}
        onRenameWorkspace={renameWorkspace}
        onArchiveWorkspace={archiveWorkspace}
        onRemoveWorkspace={removeWorkspace}
        onSearch={api.searchSessions}
        onPlugins={() => setPage((now) => (now === 'plugins' ? 'chat' : 'plugins'))}
        onMemory={() => {
          setMemoryFocus(null)
          setPage((now) => (now === 'memory' ? 'chat' : 'memory'))
        }}
        onSettings={() => setPage((now) => (now === 'settings' ? 'chat' : 'settings'))}
        update={newerBuild(updates.state)}
        onUpgrade={() => {
          // To the About page of the settings, where the newer build is named and the page of its files is linked.
          setSettingsFocus({ tab: 'about' })
          setPage('settings')
        }}
      />

      <div className="stage">
        {/* The conversation stays as it is under a page that lies over it: what was typed, and where it was scrolled to. */}
        <main className={`main ${empty ? 'main-empty' : ''}`} inert={page !== 'chat'}>
          {empty ? (
            <h1 className="hero" aria-label={`StarBench ${ABOUT.stage}`}>
              {/* The name as typed at a prompt, the cursor behind it. The star and the mark hang at its upper right and take no room, so the name stays in the middle. */}
              <span className="hero-name" aria-hidden="true">
                <span className="hero-text">
                  <span className="hero-prompt">&gt;</span>StarBench<span className="hero-cursor">_</span>
                </span>
                <span className="hero-marks">
                  <StarIcon />
                  <span className="hero-badge">{ABOUT.stage}</span>
                </span>
              </span>
            </h1>
          ) : (
            <>
              <header className="header">
                <span className="workspace" data-tip={workspace}>
                  {workspace || '未选择工作文件夹'}
                </span>
                {/* A session is tied to the folder it started in. */}
                {!sessionId && (
                  <button className="btn" onClick={() => void pickWorkspace()}>
                    选择文件夹
                  </button>
                )}
              </header>

              {/* The conversation, and over its left edge the rail of its turns, which stays where it is while the conversation moves. A rail is there from the second turn on, and the conversation leaves it room. */}
              <div className="transcript-frame" data-rail={items.filter((item) => item.kind === 'user').length >= 2 ? '' : undefined}>
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
                  <Transcript items={items} workspace={workspace} running={running && !betweenTurns} providers={settings?.providers ?? []} onOpenSettings={() => setPage('settings')} />
                  {running && !permission && (
                    <div className="working">
                      {/* A slash that turns in four steps, as a terminal shows that it is busy, and the cursor behind it. */}
                      <span className="working-mark" aria-hidden="true">
                        <span className="working-slash" />
                        <span className="working-cursor" />
                      </span>
                      {compacting ? '正在压缩上下文…' : '工作中…'}
                    </div>
                  )}
                </div>
                <TurnRail items={items} scroller={scrollRef} />
              </div>
            </>
          )}

          {permission && <PermissionBar call={permission.call} workspace={workspace} onDecide={decide} />}
          {/* A note a model kept, changed or removed in this conversation: told where a question would be asked, for a while. */}
          <MemoryNotice
            sessionId={sessionId}
            onOpen={(change) => {
              setMemoryFocus(change.action === 'deleted' ? null : { id: change.entry.id, scope: change.entry.scope, ...(change.entry.workspace ? { workspace: change.entry.workspace } : {}) })
              setPage('memory')
            }}
          />

          <div className="dock">
            {/* The box stands in a frame with a bar on top of it, for what the chat is set in. That is
                its folder: chosen there before the first message, and only said once the conversation
                has begun, since a conversation stays in the folder it started in. */}
            <div className="composer-frame">
              <div className="composer-top">
                {sessionId ? (
                  <span className="composer-place" data-tip={`工作文件夹：${workspace}`}>
                    <FolderIcon />
                    <span>{workspaceName(workspace, settings?.workspaceNames, isWindows)}</span>
                  </span>
                ) : (
                  <FolderMenu workspace={workspace} names={settings?.workspaceNames} onChoose={chooseWorkspace} />
                )}
                {/* At the right end of the bar: what is not about the message being written (the person's own prompt, what plugins add). */}
                <div className="dock-tools">
                  <PromptButton settings={settings} onOpen={() => setShowPrompt(true)} />
                  <PluginRow />
                </div>
              </div>
              <Composer
                blocked={blocked}
                running={running}
                settings={settings}
                modelInfo={modelInfo}
                mode={mode}
                onModeChange={changeMode}
                onEffortChange={changeEffort}
                onFastChange={changeFast}
                onWebSearchChange={changeWebSearch}
                onSelectModel={selectModel}
                onOpenSettings={() => setPage('settings')}
                onSend={(text, skill, attachments) => void send(text, skill, attachments)}
                onStop={() => sessionId && void api.stop(sessionId)}
              />
            </div>
            {/* Under the box, in the middle: what the conversation has cost, once there is a reply to count. */}
            {settings?.stats && stats && stats.steps > 0 && !empty && (
              <div className="dock-row">
                <StatusRow
                  stats={stats}
                  modelInfo={modelInfo}
                  local={Boolean(active && isLocalAddress(active.baseURL))}
                  compaction={settings.compaction}
                  busy={running}
                  onSetWindow={setContextWindow}
                  onCompact={() => void compactNow()}
                  onOpenMemory={() => {
                    setMemoryFocus(null)
                    setPage('memory')
                  }}
                  // What is left on the account, where the service in use tells it (DeepSeek).
                  balance={active && active.hasApiKey && balanceServiceOf(active) ? { provider: active.id, name: active.name } : undefined}
                  onOpenUsage={() => {
                    setSettingsFocus({ tab: 'usage' })
                    setPage('settings')
                  }}
                />
              </div>
            )}
          </div>
        </main>
        {page === 'plugins' && (
          <section className="page" aria-labelledby="plugins-title">
            <PluginsPage
              onBack={() => setPage('chat')}
              onOpenMemory={() => {
                setMemoryFocus(null)
                setPage('memory')
              }}
            />
            {/* The model waits for an answer wherever the person is looking. */}
            {permission && <PermissionBar call={permission.call} workspace={workspace} onDecide={decide} />}
          </section>
        )}
        {page === 'settings' && settings && (
          <section className="page" aria-labelledby="settings-title">
            <SettingsPage
              settings={settings}
              focus={settingsFocus}
              onBack={() => setPage('chat')}
              onSaved={(saved) => {
                setSettings(saved)
                setSaves((n) => n + 1)
              }}
              onWelcome={() => setWelcome(true)}
            />
            {/* As on the page of the plugins: a question of the model's is answered wherever the person is looking. */}
            {permission && <PermissionBar call={permission.call} workspace={workspace} onDecide={decide} />}
          </section>
        )}
        {page === 'memory' && (
          <section className="page" aria-labelledby="memory-title">
            <MemoryPage workspace={workspace} names={settings?.workspaceNames} providers={settings?.providers ?? []} focus={memoryFocus} onBack={() => setPage('chat')} />
            {permission && <PermissionBar call={permission.call} workspace={workspace} onDecide={decide} />}
          </section>
        )}
      </div>

      {/* A plugin's panel, when one is open: a third column, to the right of the conversation. */}
      <PluginPanel />

      {showPrompt && active && <PromptDialog provider={active} onClose={() => setShowPrompt(false)} onSaved={setSettings} />}

      {/* Asked anew for each folder: what was typed into the one before is not left in it. */}
      {trust && <TrustDialog key={trust.folder} folder={trust.folder} onTrust={trustFolder} onCancel={distrustFolder} />}
      {/* The question before a link of an answer is followed to the web; a site kept as one not to ask about again shows in the settings at once. */}
      <LinkAsk onSettings={setSettings} />

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
      <BalanceNotices />
      {/* What an element says of itself while the pointer rests on it (`data-tip`), in the app's own look. */}
      <TipLayer />
    </div>
  )
}
