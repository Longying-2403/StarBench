import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { startingEffort } from '../../shared/effort-defaults.ts'
import { REASONING_EFFORTS, effortName, isLocalAddress, offersFastMode, usualEfforts } from '../../shared/types.ts'
import type { EffortLevel, ModelChoice, ModelInfo, ProviderInfo, ReasoningEffort, Settings } from '../../shared/types.ts'
import { BoltIcon, CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ResetIcon, SettingsIcon } from './icons.tsx'
import { Slider } from './Slider.tsx'
import { errorText, roomStyle, useOutsidePress, usePopupPlace } from './util.ts'

const api = window.harness

/**
 * What a stop of the slider is called. A level of thinking goes by the name its service gives
 * it (`effortName`); only "no thinking at all" is the app's own word.
 */
const levelName = (level: EffortLevel, baseURL: string | undefined): string => (level === 'none' ? '关闭' : effortName(level, baseURL))

/** The list gets a search field above this many models. */
const SEARCH_THRESHOLD = 8

/**
 * The height that is enough for each pane to open below the button. The slider needs all of its
 * own; the list of models can be shorter than it would like, and scrolls.
 */
const PANE_HEIGHT = { effort: 130, models: 240 } as const

/** The distance between the button and its card, at its largest: `.effort-panel` opens 16px below it or 8px above. */
const PANEL_GAP = 16

/** What is known about the models of one provider. */
interface ModelList {
  /** Null while the first answer is on its way. */
  models: ModelChoice[] | null
  error?: string
}

/** Model lists by provider, kept while the app runs so the list shows at once the next time. */
const listCache = new Map<string, ModelChoice[]>()
// The account is part of the key: what a ChatGPT plan offers differs from one account to the next.
const cacheKey = (provider: ProviderInfo): string => `${provider.id}\n${provider.baseURL}\n${provider.account?.email ?? ''}`

/**
 * The levels the slider offers for a model, lowest first. They follow the service when it says
 * which ones the model takes. "Off" comes first for services where thinking can be switched off.
 * The saved choice is always among them, so the slider never shows something else than what is sent.
 */
function levelsFor(settings: Settings, info: ModelInfo | null): EffortLevel[] {
  const active = settings.providers.find((p) => p.id === settings.activeProviderId)
  const usual = usualEfforts(active?.baseURL ?? '', active?.kind)
  const offered = new Set<ReasoningEffort>(info?.efforts ?? usual)
  if (usual.includes('none')) offered.add('none')
  offered.add(settings.reasoningEffort)
  return REASONING_EFFORTS.filter((id): id is EffortLevel => id !== 'default' && offered.has(id))
}

/**
 * The model in use and its thinking effort, shown in the message box. Pressing it opens a small
 * card with a slider for the effort; the model's name in the card leads to the list of models.
 */
export function ModelControl({
  settings,
  modelInfo,
  onEffortChange,
  onFastChange,
  onSelectModel,
  onOpenSettings
}: {
  settings: Settings
  /** What the service says about the current model, once known. */
  modelInfo: ModelInfo | null
  onEffortChange: (effort: ReasoningEffort) => void
  onFastChange: (on: boolean) => void
  onSelectModel: (providerId: string, model: string) => void
  onOpenSettings: () => void
}) {
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<'effort' | 'models'>('effort')
  /** The stop under the pointer while the slider is dragged. */
  const [preview, setPreview] = useState<number | null>(null)
  const [lists, setLists] = useState<Record<string, ModelList>>({})
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLSpanElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // Decided each time the card opens, since the message box moves from the middle to the bottom,
  // and again for the list of models: where the slider fitted, the taller pane may not.
  const place = usePopupPlace(open, triggerRef, PANE_HEIGHT[pane], PANEL_GAP)

  const effort = settings.reasoningEffort
  const levels = levelsFor(settings, modelInfo)
  const active = settings.providers.find((p) => p.id === settings.activeProviderId)
  // Where the slider goes back to. A well-known model starts at a level of its own, which is in
  // use until another is chosen: for such a model `effort` is never "nothing chosen". For any
  // other model nothing is sent then and the service decides, at a level it may have told.
  const recommended = (active && startingEffort({ model: settings.model, baseURL: active.baseURL, kind: active.kind })) ?? modelInfo?.defaultEffort
  const chosen = effort === 'default' ? undefined : effort
  /** With nothing chosen the service decides; the slider shows its level when that is known. */
  const shown = chosen ?? recommended
  const index = shown ? levels.indexOf(shown) : -1
  const displayedAt = preview ?? index
  const displayed = levels[displayedAt]
  /** The levels are named as the service in use names them. */
  const named = (level: EffortLevel): string => levelName(level, active?.baseURL)
  const levelText = displayed ? named(displayed) : '默认'
  // The top of the scale gets its own look, and the step below it a little of it.
  const fromTop = displayed && displayed !== 'none' && levels.length >= 3 ? levels.length - 1 - displayedAt : -1

  const name = settings.model ? (modelInfo?.name ?? settings.model) : '选择模型'
  /** Faster answers for a higher price: a switch of the service's, there for some models only. */
  const fastOffered = active ? offersFastMode(active) : false
  const fastOn = fastOffered && settings.fastMode
  const fastCost = active?.auth === 'chatgpt' ? '消耗的套餐用量约为 2 倍' : '价格约为 2 倍'
  const fastText = !fastOffered
    ? '当前模型不支持 Fast Mode'
    : fastOn
      ? `Fast Mode 已开启：回答更快，${fastCost}。点击关闭`
      : `开启 Fast Mode：回答更快，${fastCost}`
  // Faster answers show as particles streaming through the slider, at every level. Without them,
  // only the top of the scale has particles, and those twinkle where they are.
  const sparks = displayedAt < 0 ? 'none' : fastOn ? 'stream' : fromTop === 0 ? 'still' : 'none'
  const canReset = chosen !== undefined && chosen !== recommended
  // "Recommended" where there is a level to go back to; otherwise it is simply whatever the service does.
  const resetText = recommended
    ? canReset
      ? `重设为推荐值（${named(recommended)}）`
      : '已经是推荐值'
    : canReset
      ? '重设为默认值'
      : '已经是默认值'

  const close = (refocus: boolean): void => {
    setOpen(false)
    setPane('effort')
    setPreview(null)
    setQuery('')
    if (refocus) triggerRef.current?.focus()
  }
  useOutsidePress(open, rootRef, () => close(false))

  /** Asks every provider that can be used for its models; what was learned before shows meanwhile. */
  const loadLists = (): void => {
    for (const provider of settings.providers) {
      if (!provider.ready) continue
      const key = cacheKey(provider)
      setLists((all) => ({ ...all, [provider.id]: { models: listCache.get(key) ?? null } }))
      api.listModels(provider.id).then(
        (models) => {
          listCache.set(key, models)
          setLists((all) => ({ ...all, [provider.id]: { models } }))
        },
        (err) => setLists((all) => ({ ...all, [provider.id]: { models: listCache.get(key) ?? [], error: errorText(err) } }))
      )
    }
  }

  const showModels = (): void => {
    setQuery('')
    setPane('models')
    loadLists()
  }

  // The keyboard starts where the pane's main control is.
  useEffect(() => {
    if (!open) return
    const target = pane === 'effort' ? '[role="slider"]' : '.model-search, .model-option[aria-current="true"], .model-option'
    rootRef.current?.querySelector<HTMLElement>(target)?.focus({ preventScroll: true })
  }, [open, pane])

  const onPanelKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (pane === 'models' && settings.model) setPane('effort')
      else close(true)
      return
    }
    if (pane !== 'models' || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
    const options = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('.model-option:not(:disabled)'))
    if (options.length === 0) return
    const at = options.indexOf(document.activeElement as HTMLElement)
    e.preventDefault()
    const next = e.key === 'ArrowDown' ? Math.min(options.length - 1, at + 1) : at <= 0 ? -1 : at - 1
    const target = next === -1 ? (e.currentTarget.querySelector<HTMLElement>('.model-search') ?? options[0]) : options[next]
    target.focus({ preventScroll: true })
    target.scrollIntoView({ block: 'nearest' })
  }

  /** The models to show for a provider: what the service lists, with the model in use always among them. */
  const choicesOf = (provider: ProviderInfo): ModelChoice[] => {
    const listed = lists[provider.id]?.models ?? []
    const all = provider.model && !listed.some((m) => m.id === provider.model) ? [{ id: provider.model }, ...listed] : listed
    const needle = query.trim().toLowerCase()
    return needle ? all.filter((m) => m.id.toLowerCase().includes(needle) || m.name?.toLowerCase().includes(needle)) : all
  }

  const total = settings.providers.reduce((sum, p) => sum + (lists[p.id]?.models?.length ?? 0), 0)

  const effortPane = (
    <>
      <div className="effort-head">
        <button
          type="button"
          className="icon-btn"
          disabled={!fastOffered}
          aria-label="Fast Mode"
          aria-pressed={fastOffered ? fastOn : undefined}
          title={fastText}
          onClick={() => onFastChange(!fastOn)}
        >
          <BoltIcon />
        </button>
        <div className="effort-heading">
          <div className="effort-level-name">{levelText}</div>
          <button type="button" className="effort-model-name" title={`切换模型（当前：${settings.model}）`} onClick={showModels}>
            <span>{name}</span>
            <ChevronRightIcon />
          </button>
        </div>
        <button
          type="button"
          className="icon-btn"
          disabled={!canReset}
          aria-label={resetText}
          title={resetText}
          onClick={() => {
            onEffortChange('default')
            // The button disables itself once the default is back; the keyboard stays in the card.
            rootRef.current?.querySelector<HTMLElement>('[role="slider"]')?.focus({ preventScroll: true })
          }}
        >
          <ResetIcon />
        </button>
      </div>
      <Slider
        stops={levels.map(named)}
        index={index}
        label="思考强度"
        emptyText="默认"
        sparks={sparks}
        onPreview={setPreview}
        onCommit={(at) => levels[at] !== shown && onEffortChange(levels[at])}
      />
    </>
  )

  const modelsPane = (
    <>
      <div className="effort-head effort-head-models">
        {settings.model ? (
          <button type="button" className="icon-btn" aria-label="返回" title="返回" onClick={() => setPane('effort')}>
            <ChevronLeftIcon />
          </button>
        ) : (
          <span />
        )}
        <div className="model-pane-title">切换模型</div>
        <button type="button" className="icon-btn" aria-label="管理模型服务" title="管理模型服务" onClick={() => (close(false), onOpenSettings())}>
          <SettingsIcon />
        </button>
      </div>
      {total > SEARCH_THRESHOLD && (
        <input
          className="model-search"
          type="text"
          role="searchbox"
          aria-label="搜索模型"
          placeholder="搜索模型"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      <div className="model-list">
        {settings.providers.map((provider) => {
          const list = lists[provider.id]
          const choices = choicesOf(provider)
          return (
            <div key={provider.id} role="group" aria-label={provider.name}>
              <div className="model-group">{provider.name}</div>
              {!provider.ready && (
                <div className="model-note">
                  {provider.auth !== 'chatgpt' ? '还没有填写 API Key' : provider.account?.signedIn ? '还没有启用套餐额度' : '还没有登录'}
                </div>
              )}
              {provider.ready && list?.models === null && choices.length === 0 && <div className="model-note">正在获取模型列表…</div>}
              {list?.error && (
                <div className="model-note model-note-error" title={list.error}>
                  {/* A server on one's own machine is usually just not running. */}
                  {isLocalAddress(provider.baseURL) ? '连不上，本地的模型服务启动了吗？' : '无法获取模型列表'}
                </div>
              )}
              {provider.ready && list?.models && choices.length === 0 && !list.error && (
                <div className="model-note">{query.trim() ? '没有匹配的模型' : '服务没有列出模型，请在设置里填写模型名'}</div>
              )}
              {provider.ready &&
                choices.map((choice) => {
                  const current = provider.id === settings.activeProviderId && choice.id === settings.model
                  return (
                    <button
                      key={choice.id}
                      type="button"
                      className="model-option"
                      aria-current={current ? 'true' : undefined}
                      title={choice.id}
                      onClick={() => {
                        if (!current) onSelectModel(provider.id, choice.id)
                        setQuery('')
                        setPane('effort')
                      }}
                    >
                      <span className="model-option-name">{choice.name ?? choice.id}</span>
                      {current && <CheckIcon />}
                    </button>
                  )
                })}
            </div>
          )
        })}
      </div>
    </>
  )

  return (
    <span className="effort" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="effort-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={settings.model ? `模型 ${name}，思考强度 ${levelText}${fastOn ? '，Fast Mode 已开启' : ''}，点击调整` : '选择模型'}
        title={
          settings.model
            ? `模型：${settings.model}\n思考强度：${levelText}${fastOn ? '\nFast Mode：已开启' : ''}（从下一条消息开始生效）`
            : '选择模型'
        }
        onClick={() => {
          if (open) return close(false)
          setOpen(true)
          // Without a model there is no effort to set yet: the card starts on the list.
          if (!settings.model) showModels()
        }}
      >
        <span className="effort-model">{name}</span>
        {settings.model && <span className="effort-level">{levelText}</span>}
        {/* Seen without opening the card: this one costs more. */}
        {fastOn && (
          <span className="effort-fast">
            <BoltIcon />
          </span>
        )}
        <ChevronDownIcon />
      </button>
      {open && (
        <div
          className="effort-panel"
          role="dialog"
          aria-label={pane === 'effort' ? '调整思考强度' : '切换模型'}
          data-peak={pane === 'effort' && fromTop === 0 ? '' : undefined}
          data-side={place.side}
          style={roomStyle(place)}
          onKeyDown={onPanelKeyDown}
        >
          {pane === 'effort' ? effortPane : modelsPane}
        </div>
      )}
    </span>
  )
}
