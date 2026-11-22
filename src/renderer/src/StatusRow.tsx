// The row under the message box that says what the conversation has cost so far: how many
// requests it took and how fast the model wrote, how many tokens went back and forth, and how
// full the model's context is. The pointer resting on one of the three shows a word of what it
// is; a press opens its card with the details, which stays until the next press. The card of the
// context is also where the conversation is compacted by hand.
// What the numbers mean and how they are added up is in shared/stats.ts.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { compactFrom } from '../../shared/compaction.ts'
import type { CompactionSettings } from '../../shared/compaction.ts'
import {
  cacheHitRate,
  contextView,
  firstPieceAverage,
  formatCount,
  formatDuration,
  formatShare,
  formatShareFine,
  formatTokens,
  outputSpeed,
  readWindow,
  totalTokens
} from '../../shared/stats.ts'
import type { SessionStats, ShownPart } from '../../shared/stats.ts'
import type { ModelInfo } from '../../shared/types.ts'
import { ClockIcon, StackIcon } from './icons.tsx'
import { errorText, useOutsidePress } from './util.ts'

type Which = 'stats' | 'tokens' | 'context'

/** What stands where a service told nothing. Not a nought: nothing is known. */
const UNKNOWN = '—'

const tokens = (value: number | undefined): string => (value === undefined ? UNKNOWN : formatCount(value))
const speedText = (perSecond: number): string => (perSecond >= 10 ? String(Math.round(perSecond)) : perSecond.toFixed(1))
const speedOf = (stats: SessionStats): string | null => {
  const speed = outputSpeed(stats)
  return speed ? `${speed.rough ? '约 ' : ''}${speedText(speed.perSecond)} tok/s` : null
}

function Line({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="status-line">
      <span>{label}</span>
      <span className="status-value">{value}</span>
    </div>
  )
}

function StatsCard({ stats }: { stats: SessionStats }) {
  const first = firstPieceAverage(stats)
  return (
    <>
      <div className="status-head">
        <span>会话统计</span>
        <span>
          {stats.turns} 轮 {stats.steps} 步
        </span>
      </div>
      <Line label="模型用时" value={formatDuration(stats.modelMs)} />
      <Line label="工具调用用时" value={formatDuration(stats.toolMs)} />
      <Line label="首 token 平均" value={first === undefined ? UNKNOWN : formatDuration(first)} />
      <Line label="输出速度" value={speedOf(stats) ?? UNKNOWN} />
      {stats.compactions ? <Line label="上下文压缩" value={`${stats.compactions} 次`} /> : null}
      {stats.partial && <p className="status-note">这个对话在开始统计之前就有了，数字从那之后算起。</p>}
    </>
  )
}

function TokensCard({ stats }: { stats: SessionStats }) {
  const { usage } = stats
  const total = totalTokens(usage)
  const rate = cacheHitRate(usage)
  /** The service says how much of the input it read from its cache. */
  const cached = usage.cacheRead !== undefined
  return (
    <>
      <div className="status-head">
        <span>Token 用量</span>
        <span>{tokens(total)}</span>
      </div>
      <Line label="缓存命中" value={rate === undefined ? UNKNOWN : formatShare(rate)} />
      <Line label={cached ? '未缓存输入' : '输入'} value={tokens(usage.input)} />
      {cached && <Line label="缓存读取" value={tokens(usage.cacheRead)} />}
      {usage.cacheWrite ? <Line label="缓存写入" value={tokens(usage.cacheWrite)} /> : null}
      <Line label="输出" value={tokens(usage.output)} />
      {usage.reasoning ? <Line label="其中思考" value={tokens(usage.reasoning)} /> : null}
      {total === undefined ? (
        <p className="status-note">这个模型服务没有报告用量。</p>
      ) : (
        !cached && <p className="status-note">这个模型服务不报告缓存。</p>
      )}
    </>
  )
}

/** Where the size of the context is from, said to the person. */
const SOURCE: Record<NonNullable<ModelInfo['contextSource']>, string> = {
  manual: '总量是手动填写的。',
  service: '总量由模型服务报告。',
  known: '总量来自应用内置的常见模型表。'
}

/** What each part of the context is called. */
const PART_NAMES: Record<ShownPart, string> = {
  messages: '对话消息',
  thinking: '思考',
  summary: '压缩摘要',
  toolResults: '工具调用和结果',
  tools: '内置工具',
  pluginTools: '插件工具',
  mcpTools: 'MCP 工具',
  system: '系统提示词',
  custom: '自定义提示词',
  skills: 'Skills 列表'
}

/** How full the context is, as a state for colouring: nearly full is a warning, full an alarm. */
const fullness = (share: number | undefined): '' | ' status-near' | ' status-full' => (share === undefined || share < 0.8 ? '' : share < 0.95 ? ' status-near' : ' status-full')

/** When the conversation is compacted by itself, said in a few words: at a share of the model's room, past a number of tokens, or never. */
function autoText(compaction: CompactionSettings, room: number | undefined): string {
  if (!compaction.auto) return '自动压缩已关闭'
  const from = compactFrom(compaction, room)
  if (from === undefined) return '不知道上下文长度，不会自动压缩'
  // The share is what counts unless a limit in tokens comes first.
  return room && from === Math.floor(room * compaction.share) ? `到 ${Math.round(compaction.share * 100)}% 时自动压缩` : `超过 ${formatTokens(from)} 时自动压缩`
}

function ContextCard({
  stats,
  info,
  local,
  compaction,
  busy,
  onSetWindow,
  onCompact
}: {
  stats: SessionStats
  info: ModelInfo | null
  local: boolean
  compaction: CompactionSettings
  busy: boolean
  onSetWindow: (tokens: number | null) => Promise<void>
  onCompact: () => void
}) {
  /** The size being typed; null while none is. */
  const [draft, setDraft] = useState<string | null>(null)
  const [problem, setProblem] = useState('')
  /** How many tokens the context of the model holds, where that is known. */
  const room = info?.contextWindow
  const context = stats.context
  // Thinking is a part of its own only where the service has counted any in this conversation.
  const view = context ? contextView(context, room, Boolean(stats.usage.reasoning)) : null
  const thinking = view?.parts.some(({ part }) => part === 'thinking')

  const save = (value: number | null): void => {
    setProblem('')
    onSetWindow(value).then(
      () => setDraft(null),
      (err) => setProblem(errorText(err))
    )
  }
  const submit = (): void => {
    const typed = readWindow(draft ?? '')
    if (typed === null) return setProblem('写成 128K、1M 或 32768 这样的数字。')
    save(typed)
  }
  const edit = (): void => {
    setProblem('')
    setDraft(room ? formatTokens(room) : '')
  }

  return (
    <>
      <div className="status-head">
        <span>上下文</span>
        <span>
          {view ? `${view.exact ? '' : '约 '}${formatTokens(view.tokens)}` : UNKNOWN}
          {room ? ` / ${formatTokens(room)}` : ''}
        </span>
      </div>
      {view ? (
        <>
          {view.share !== undefined && <div className={`status-used${fullness(view.share)}`}>已用 {formatShare(view.share)}</div>}
          {/* One piece of the bar for each part, as wide as its share; what is left of the bar is the room left. */}
          <div className="status-bar" aria-hidden="true">
            {view.parts.map(({ part, share }) => (
              <span key={part} className={`status-part-${part}`} style={{ width: `${share * 100}%` }} />
            ))}
          </div>
          <div className="status-parts">
            {view.parts.map(({ part, tokens: weight, share }) => (
              <div key={part} className="status-part">
                <span className={`status-swatch status-part-${part}`} aria-hidden="true" />
                <span className="status-part-name">{PART_NAMES[part]}</span>
                <span className="status-value">{formatTokens(weight)}</span>
                <span className="status-share">{formatShareFine(share)}</span>
              </div>
            ))}
            {view.free !== undefined && room && (
              <div className="status-part">
                <span className="status-swatch status-part-free" aria-hidden="true" />
                <span className="status-part-name">剩余空间</span>
                <span className="status-value">{formatTokens(view.free)}</span>
                <span className="status-share">{formatShareFine(view.free / room)}</span>
              </div>
            )}
          </div>
          <p className="status-note">
            {view.exact ? '各部分按文字长度估算，合计与模型服务报告的用量一致。' : '模型服务没有报告用量，全部按文字长度估算。'}
            {thinking && ' "思考"是报告的用量里超出文字的部分：随回复一起带回去的思考。'}
            {view.share === undefined && ' 百分比是各部分占已用的比例。'}
          </p>
        </>
      ) : (
        <p className="status-note">下一次请求之后会显示。</p>
      )}
      {draft === null ? (
        <p className="status-note">
          {room && info?.contextSource ? SOURCE[info.contextSource] : '不知道这个模型的上下文长度，所以算不出占了多少。'}{' '}
          <button type="button" className="status-link" onClick={edit}>
            {room ? '修改' : '填写'}
          </button>
          {info?.contextSource === 'manual' && (
            <>
              {' '}
              <button type="button" className="status-link" onClick={() => save(null)}>
                清除
              </button>
            </>
          )}
        </p>
      ) : (
        <form
          className="status-edit"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <input
            autoFocus
            value={draft}
            placeholder="例如 128K"
            aria-label="这个模型的上下文长度"
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Escape gives up the typing, and not the card with it.
              if (e.key !== 'Escape') return
              e.stopPropagation()
              setDraft(null)
            }}
          />
          <button type="submit" className="btn btn-small btn-primary">
            保存
          </button>
          <button type="button" className="btn btn-small" onClick={() => setDraft(null)}>
            取消
          </button>
        </form>
      )}
      {draft !== null && local && <p className="status-note">本地模型的上下文长度是在模型服务那边设置的，这里填它实际的数值。</p>}
      {problem && (
        <p className="status-note status-problem" role="alert">
          {problem}
        </p>
      )}
      {/* Compacting: when it happens by itself, and the button that does it now. */}
      <div className="status-compact">
        <span>{autoText(compaction, room)}</span>
        <button type="button" className="btn btn-small" disabled={busy} onClick={onCompact}>
          立即压缩
        </button>
      </div>
    </>
  )
}

/** A ring that fills as the context does. Empty while the size of the context is not known. */
function Ring({ share }: { share: number | undefined }) {
  const radius = 7
  const around = 2 * Math.PI * radius
  return (
    <svg className={`status-ring${fullness(share)}`} width="14" height="14" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="3" />
      {share !== undefined && (
        <circle className="status-ring-filled" cx="10" cy="10" r={radius} fill="none" strokeWidth="3" strokeDasharray={`${around * share} ${around}`} transform="rotate(-90 10 10)" />
      )}
    </svg>
  )
}

/** One of the three: what stands in the row, the word shown while the pointer rests on it, and the card a press opens. */
function Widget({
  open,
  tip,
  label,
  chip,
  onPress,
  children
}: {
  open: boolean
  /** A word of what this is, shown while the pointer rests on it. */
  tip: string
  /** What it is and what it says, for a screen reader. */
  label: string
  chip: ReactNode
  onPress: () => void
  children: ReactNode
}) {
  const pop = useRef<HTMLDivElement>(null)
  // The card opens above its own place in the row, and is moved left as far as it takes to stay
  // inside the column of the conversation.
  useLayoutEffect(() => {
    const card = pop.current
    if (!card) return
    card.style.left = '0px'
    const room = card.closest('.dock')?.getBoundingClientRect()
    if (!room) return
    const over = card.getBoundingClientRect().right - (room.right - 16)
    if (over > 0) card.style.left = `${-over}px`
  }, [open])
  return (
    <div className="status-widget">
      <button type="button" className="status-chip" aria-expanded={open} aria-label={label} onClick={onPress}>
        {chip}
      </button>
      {/* Said by the label already to whoever cannot see it. Not shown beside the open card, which says more. */}
      {!open && (
        <span className="status-tip" aria-hidden="true">
          {tip}
        </span>
      )}
      {open && (
        <div className="status-pop" ref={pop}>
          <div className="status-card" role="group" aria-label={label}>
            {children}
          </div>
        </div>
      )}
    </div>
  )
}

export function StatusRow({
  stats,
  modelInfo,
  local,
  compaction,
  busy,
  onSetWindow,
  onCompact
}: {
  stats: SessionStats
  /** What is known of the model in use, the size of its context among it. */
  modelInfo: ModelInfo | null
  /** The model runs on a server of the person's own, where the size of the context is set. */
  local: boolean
  /** Whether, and from where on, the conversation is compacted by itself. */
  compaction: CompactionSettings
  /** A turn or a compaction is under way: no other can be started. */
  busy: boolean
  /** Says how many tokens the context of the model in use holds; null takes that back. */
  onSetWindow: (tokens: number | null) => Promise<void>
  /** Has the conversation compacted now. */
  onCompact: () => void
}) {
  /** The card that is open. A press opens one and closes it again; so do Escape and a press elsewhere. */
  const [shown, setShown] = useState<Which | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const close = (): void => setShown(null)
  useOutsidePress(shown !== null, root, close)
  useEffect(() => {
    if (shown === null) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shown])

  const widget = (which: Which) => ({ open: shown === which, onPress: () => setShown((now) => (now === which ? null : which)) })

  const speed = speedOf(stats)
  const total = totalTokens(stats.usage)
  const rate = cacheHitRate(stats.usage)
  const view = stats.context ? contextView(stats.context, modelInfo?.contextWindow) : null
  const steps = `${stats.turns} 轮 ${stats.steps} 步`
  const used = total === undefined ? `${UNKNOWN} tok` : `${formatTokens(total)} tok`
  const full = !view ? UNKNOWN : view.share !== undefined ? formatShare(view.share) : `${view.exact ? '' : '约 '}${formatTokens(view.tokens)}`

  return (
    <div className="status-row" ref={root}>
      <Widget
        {...widget('stats')}
        tip="会话统计"
        label={`会话统计：${steps}`}
        chip={
          <>
            <ClockIcon />
            {steps}
            {speed && ` · ${speed}`}
          </>
        }
      >
        <StatsCard stats={stats} />
      </Widget>
      <Widget
        {...widget('tokens')}
        tip="Token 用量"
        label={`Token 用量：${used}`}
        chip={
          <>
            <StackIcon />
            {used}
            {rate !== undefined && ` · 缓存命中 ${formatShare(rate)}`}
          </>
        }
      >
        <TokensCard stats={stats} />
      </Widget>
      <Widget
        {...widget('context')}
        tip={view ? `上下文已用 ${full}` : '上下文'}
        label={`上下文已用：${full}`}
        chip={
          <>
            <Ring share={view?.share} />
            {full}
          </>
        }
      >
        <ContextCard stats={stats} info={modelInfo} local={local} compaction={compaction} busy={busy} onSetWindow={onSetWindow} onCompact={onCompact} />
      </Widget>
    </div>
  )
}
