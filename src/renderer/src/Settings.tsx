import { Fragment, useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { CHATGPT_HELP_URL, LOCAL_SERVERS, PROVIDER_KINDS, PROVIDER_PRESETS, isLocalAddress } from '../../shared/types.ts'
import { sendsKeySafely } from '../../shared/key-address.ts'
import type { McpServerStatus, ModelChoice, ProviderInfo, ProviderKind, Settings, SkillInfo } from '../../shared/types.ts'
import { ABOUT } from '../../shared/about.ts'
import { CAP_MIN, SHARE_MAX, SHARE_MIN, isCap } from '../../shared/compaction.ts'
import type { CompactionChange } from '../../shared/compaction.ts'
import { formatTokens, readWindow } from '../../shared/stats.ts'
import { ChatGptButton, ChatGptPane } from './ChatGptPane.tsx'
import { Notice } from './Notice.tsx'
import { errorText } from './util.ts'

const api = window.harness
/** The shares of the context at which a conversation can be set to be compacted, in percent. */
const LEAST = Math.round(SHARE_MIN * 100)
const MOST = Math.round(SHARE_MAX * 100)

const TABS = [
  { id: 'model', label: '模型' },
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP' },
  { id: 'general', label: '通用' },
  { id: 'about', label: '关于' }
] as const
type TabId = (typeof TABS)[number]['id']

const KIND_LABELS: Record<ProviderKind, string> = {
  'openai-chat': 'OpenAI 兼容（Chat Completions）',
  'openai-responses': 'OpenAI（Responses API）',
  anthropic: 'Anthropic（Messages API）'
}
const KIND_HINTS: Record<ProviderKind, string> = {
  'openai-chat': 'DeepSeek、xAI 和大多数兼容 OpenAI 格式的服务都用这种。',
  'openai-responses': 'OpenAI 自己的新接口，能返回思考摘要。',
  anthropic: 'Claude 的接口。'
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** What the form is filled with: an existing provider, or a starting point for a new one. */
interface Draft {
  /** Absent for a provider that is being added. */
  id?: string
  name: string
  kind: ProviderKind
  baseURL: string
  model: string
  /** Whether a key is stored for it. */
  hasApiKey: boolean
  keyHint: string
}

function ProviderForm({
  draft,
  removable,
  planOffered,
  onBack,
  onChanged
}: {
  draft: Draft
  /** The last provider stays. */
  removable: boolean
  /** Signing in with ChatGPT is on offer one step back, for a person without a key. */
  planOffered: boolean
  onBack: () => void
  onChanged: (settings: Settings) => void
}) {
  const [name, setName] = useState(draft.name)
  const [kind, setKind] = useState(draft.kind)
  const [baseURL, setBaseURL] = useState(draft.baseURL)
  const [model, setModel] = useState(draft.model)
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState<ModelChoice[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  /** Removing takes a second press. */
  const [confirming, setConfirming] = useState(false)

  /** A model server on this computer or the local network: it asks for no key, and has its own needs. */
  const local = isLocalAddress(baseURL)
  /** The address names another host than the stored key was given for: saving leaves that key behind (settings-model.ts). */
  const movedHost = draft.hasApiKey && hostOf(baseURL.trim()) !== hostOf(draft.baseURL)
  /** A key sent here would cross the network as it is, or reach whoever answers for a name: none is saved for it (shared/key-address.ts). */
  const plainHttp = /^http:\/\//i.test(baseURL.trim()) && !sendsKeySafely(baseURL.trim())
  /** A key goes along when the form is saved: one typed in, or the stored one where the host stays. */
  const keyGoesAlong = Boolean(apiKey.trim()) || (draft.hasApiKey && !movedHost)

  // The service's own list makes the model field a pick list. It is a convenience: typing still
  // works, and a provider that cannot be asked yet simply has no list.
  useEffect(() => {
    if (draft.id) api.listModels(draft.id).then(setModels, () => {})
  }, [draft.id])

  /** Fills in where one of the usual local servers listens, and its name unless another was typed. */
  const pickServer = (server: (typeof LOCAL_SERVERS)[number]): void => {
    setBaseURL(server.baseURL)
    if (!name.trim() || LOCAL_SERVERS.some((s) => s.name === name)) setName(server.name)
  }

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      // An empty key field means "keep the stored key".
      onChanged(await api.saveProvider({ id: draft.id, name, kind, baseURL, model, ...(apiKey ? { apiKey } : {}) }))
      onBack()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!draft.id) return
    if (!confirming) return setConfirming(true)
    setBusy(true)
    try {
      onChanged(await api.removeProvider(draft.id))
      onBack()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <form className="tab-body" onSubmit={submit}>
      <label>
        名称
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="显示在模型列表里的名字" />
      </label>
      <label>
        接口类型
        <select value={kind} onChange={(e) => setKind(e.target.value as ProviderKind)}>
          {PROVIDER_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
        <span className="hint">{KIND_HINTS[kind]}</span>
      </label>
      <label>
        接口地址
        <input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder="https://…" />
      </label>
      {local && (
        <div className="local-help">
          <div className="toolbar toolbar-wrap">
            <span className="hint">常用地址：</span>
            {LOCAL_SERVERS.map((server) => (
              <button
                key={server.name}
                type="button"
                className="btn btn-small"
                aria-pressed={baseURL.trim() === server.baseURL}
                title={server.baseURL}
                onClick={() => pickServer(server)}
              >
                {server.name}
              </button>
            ))}
          </div>
          <span className="hint">
            模型跑在另一台电脑上时，把 localhost 换成那台电脑的地址。模型需要支持工具调用，并且把上下文长度调到 16K 以上（Ollama 默认只有
            4K），否则读不了几个文件就会忘记前面的内容。
          </span>
        </div>
      )}
      <label>
        API Key
        <input
          type="password"
          value={apiKey}
          autoFocus={!draft.hasApiKey && !isLocalAddress(draft.baseURL)}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={movedHost ? '地址换了主机，请重新填写' : draft.hasApiKey ? '已保存，留空则不修改' : local ? '本地服务一般不用填' : draft.keyHint}
        />
        <span className="hint">
          {local && !draft.hasApiKey
            ? '本机或局域网里的模型服务一般不需要 API Key，可以留空。'
            : '使用系统凭据加密后保存在本机，不会写入项目文件。'}
          {planOffered && !draft.hasApiKey && !local && '没有 API Key？点"返回"，可以改用 ChatGPT 套餐登录。'}
        </span>
      </label>
      {plainHttp && keyGoesAlong ? (
        <Notice role="status">
          这个地址用的是 http://，又不是本机或局域网的 IP 地址，所以不能带着 API Key 保存：Key 会明文经过网络，按名字找到的电脑也可能被同一网络里的其他电脑冒充。请改用 https://；局域网里的服务器可以改填它的 IP 地址。
        </Notice>
      ) : movedHost ? (
        <Notice role="status">地址换到了另一个主机。之前保存的 Key 只会发往原来的主机，保存后会被清除；要继续使用，请在上面重新填写。</Notice>
      ) : null}
      <label>
        模型
        <input value={model} onChange={(e) => setModel(e.target.value)} list="provider-models" placeholder="可以留空" />
        <datalist id="provider-models">
          {models.map((m) => (
            <option key={m.id} value={m.id} label={m.name} />
          ))}
        </datalist>
        <span className="hint">可以先留空：保存之后，在输入框右下角点模型名，就能从这个服务的模型列表里选。</span>
      </label>
      {error && (
        <div className="msg-error" role="alert">
          {error}
        </div>
      )}
      <div className="dialog-actions">
        {draft.id && removable && (
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove()}>
            {confirming ? '确认删除？' : '删除'}
          </button>
        )}
        <button type="button" className="btn" onClick={onBack}>
          返回
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          保存
        </button>
      </div>
    </form>
  )
}

/** What the tab shows in place of the list: the form of a provider with a key, or the pane of a ChatGPT sign-in. */
type Editing = { type: 'key'; draft: Draft } | { type: 'chatgpt'; providerId?: string; autoStart?: boolean } | null

const editingOf = (provider: ProviderInfo): Editing =>
  provider.auth === 'chatgpt'
    ? { type: 'chatgpt', providerId: provider.id }
    : { type: 'key', draft: { ...provider, keyHint: PROVIDER_PRESETS.find((p) => p.id === provider.id)?.keyHint ?? '' } }

/** The words for what a provider still needs before it can be used; empty when it needs nothing. */
function missing(provider: ProviderInfo): string {
  if (provider.ready) return ''
  if (provider.auth !== 'chatgpt') return '未填 API Key'
  return provider.account?.signedIn ? '未启用套餐额度' : '未登录'
}

function ProvidersTab({
  settings,
  onChanged,
  onWelcome
}: {
  settings: Settings
  onChanged: (s: Settings) => void
  onWelcome: () => void
}) {
  // With no usable provider yet, the form for the first one is what the user needs to see.
  const [editing, setEditing] = useState<Editing>(() => {
    if (settings.ready) return null
    return editingOf(settings.providers.find((p) => p.id === settings.activeProviderId) ?? settings.providers[0])
  })
  const hasPlan = settings.providers.some((p) => p.auth === 'chatgpt')

  if (editing?.type === 'chatgpt') {
    return (
      <ChatGptPane
        key={editing.providerId ?? 'new'}
        settings={settings}
        providerId={editing.providerId}
        autoStart={editing.autoStart}
        onBack={() => setEditing(null)}
        onChanged={onChanged}
        onWelcome={onWelcome}
      />
    )
  }
  if (editing) {
    return (
      <ProviderForm
        // A fresh form for each provider, so nothing typed for one shows up in another.
        key={editing.draft.id ?? `new-${editing.draft.name}`}
        draft={editing.draft}
        removable={settings.providers.length > 1}
        planOffered={!hasPlan}
        onBack={() => setEditing(null)}
        onChanged={onChanged}
      />
    )
  }

  const taken = new Set(settings.providers.map((p) => p.id))
  return (
    <div className="tab-body">
      <p className="hint">
        可以添加多个模型服务，各用各的 API Key，也可以用 ChatGPT 套餐登录，或者连接自己电脑上运行的本地模型。用哪个模型，在输入框右下角点模型名切换。
      </p>
      <ul className="rows">
        {settings.providers.map((provider) => (
          <li key={provider.id} className="row">
            <div className="row-main">
              <div className="row-title">
                {provider.name}
                {provider.id === settings.activeProviderId && <span className="badge badge-active">使用中</span>}
                {missing(provider) && <span className="badge">{missing(provider)}</span>}
              </div>
              <div className="row-meta">
                {provider.model || '尚未选择模型'} ·{' '}
                {provider.auth === 'chatgpt' ? (provider.account?.email ?? 'ChatGPT 套餐') : hostOf(provider.baseURL)}
              </div>
            </div>
            <button className="btn btn-small" onClick={() => setEditing(editingOf(provider))} aria-label={`编辑 ${provider.name}`}>
              {provider.auth === 'chatgpt' ? '管理' : '编辑'}
            </button>
          </li>
        ))}
      </ul>
      <div className="toolbar toolbar-wrap">
        <span className="hint">添加：</span>
        {PROVIDER_PRESETS.filter((preset) => !taken.has(preset.id)).map((preset) => (
          <button
            key={preset.id}
            className="btn btn-small"
            onClick={() => setEditing({ type: 'key', draft: { ...preset, id: undefined, hasApiKey: false } })}
          >
            {preset.name}
          </button>
        ))}
        {/* A model server on one's own computer: the form starts at the most common one and offers the others. */}
        <button
          className="btn btn-small"
          onClick={() =>
            setEditing({ type: 'key', draft: { ...LOCAL_SERVERS[0], kind: 'openai-chat', model: '', hasApiKey: false, keyHint: '' } })
          }
        >
          本地模型
        </button>
        <button
          className="btn btn-small"
          onClick={() => setEditing({ type: 'key', draft: { name: '', kind: 'openai-chat', baseURL: '', model: '', hasApiKey: false, keyHint: '' } })}
        >
          其他服务
        </button>
      </div>
      {!hasPlan && (
        <div className="plan-card">
          <div className="plan-title">使用你的 ChatGPT 套餐</div>
          <p className="plan-text">
            用 ChatGPT 账号登录后，在这里使用 OpenAI 的模型会计入你 ChatGPT 套餐里的额度，不需要 API Key。
            <a className="plan-link" href={CHATGPT_HELP_URL} target="_blank" rel="noreferrer">
              了解更多
            </a>
          </p>
          <div className="toolbar">
            <ChatGptButton onClick={() => setEditing({ type: 'chatgpt', autoStart: true })} />
          </div>
        </div>
      )}
    </div>
  )
}

function SkillsTab() {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [error, setError] = useState('')

  const refresh = useCallback(() => {
    setError('')
    api.listSkills().then(setSkills, (err) => setError(errorText(err)))
  }, [])
  useEffect(refresh, [refresh])

  return (
    <div className="tab-body">
      <p className="hint">
        Skill 是一个文件夹加一份 SKILL.md，用来教模型按某种流程或规范做事。模型平时只看到名字和说明，用得上时才读正文；你也可以在输入框里输入
        / 手动选择。
      </p>
      <div className="toolbar">
        <button className="btn" onClick={() => api.openSkillsFolder().catch((err) => setError(errorText(err)))}>
          打开 Skills 文件夹
        </button>
        <button className="btn" onClick={refresh}>
          刷新
        </button>
      </div>
      {error && (
        <div className="msg-error" role="alert">
          {error}
        </div>
      )}
      {skills?.length === 0 && <p className="hint">还没有 Skill。把 Skill 文件夹放进去就能用，不需要重启。</p>}
      <ul className="rows">
        {skills?.map((skill) => (
          <li key={skill.name} className="row">
            <div className="row-main">
              <div className="row-title">
                {skill.name}
                {skill.source === 'builtin' ? (
                  <span className="badge" title="随应用一起安装的 Skill">
                    内置
                  </span>
                ) : (
                  <span className="row-meta">{skill.source === 'user' ? '我的 Skill' : `来自插件 ${skill.source}`}</span>
                )}
              </div>
              <div className="row-desc">{skill.description || '（没有填写说明，模型无法判断何时使用它）'}</div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

const MCP_STATE: Record<McpServerStatus['state'], string> = {
  disabled: '已停用',
  connecting: '连接中',
  connected: '已连接',
  error: '出错'
}
/** Badge colours are shared with the plugin states. */
const MCP_BADGE: Record<McpServerStatus['state'], string> = {
  disabled: 'disabled',
  connecting: 'waiting',
  connected: 'active',
  error: 'error'
}
const MCP_EXAMPLE = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/some/folder"]
    }
  }
}`

function McpTab() {
  const [config, setConfig] = useState<string | null>(null)
  const [servers, setServers] = useState<McpServerStatus[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.getMcp().then(
      (mcp) => {
        setConfig(mcp.config)
        setServers(mcp.servers)
        // A hand-edited file that no longer parses would otherwise just look like "nothing changed".
        if (mcp.error) setError(`mcp.json 无法加载，文件里的内容没有生效：${mcp.error}`)
      },
      (err) => setError(errorText(err))
    )
  }, [])

  // Connecting happens in the background; keep asking until every server has settled.
  const connecting = servers.some((s) => s.state === 'connecting')
  useEffect(() => {
    if (!connecting) return
    const timer = setInterval(() => void api.mcpStatus().then(setServers, () => {}), 1000)
    return () => clearInterval(timer)
  }, [connecting])

  const apply = async (action: () => Promise<McpServerStatus[]>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      setServers(await action())
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="tab-body">
      <p className="hint">
        MCP 服务器给模型提供现成的工具。配置使用通用的 mcpServers 格式，可以直接粘贴其他应用里的配置。每次调用 MCP
        工具前都会征求你的同意。环境变量和请求头里的值会用系统凭据加密后保存在本机的 mcp.json 里，换电脑或换 Windows 账户后需要重新填写。
      </p>
      {/* The server list comes first: it is what people check, and it must not hide below the editor. */}
      <ul className="rows">
        {servers.map((server) => (
          <li key={server.name} className="row">
            <div className="row-main">
              <div className="row-title">
                {server.name}
                <span className="row-meta">{server.transport === 'stdio' ? '本地进程' : '远程服务'}</span>
                <span className={`badge badge-${MCP_BADGE[server.state]}`}>{MCP_STATE[server.state]}</span>
              </div>
              {server.tools.length > 0 && (
                <div className="row-meta">
                  {server.tools.length} 个工具：{server.tools.map((t) => t.split('__').slice(2).join('__')).join('、')}
                </div>
              )}
              {server.error && <div className="row-error">{server.error}</div>}
            </div>
          </li>
        ))}
      </ul>
      <label>
        mcp.json
        <textarea
          className="code-input"
          value={config ?? ''}
          disabled={config === null}
          onChange={(e) => setConfig(e.target.value)}
          placeholder={MCP_EXAMPLE}
          rows={8}
          spellCheck={false}
        />
      </label>
      {error && (
        <div className="msg-error" role="alert">
          {error}
        </div>
      )}
      <div className="toolbar">
        <button className="btn btn-primary" disabled={busy || config === null} onClick={() => void apply(() => api.saveMcp(config ?? ''))}>
          保存并连接
        </button>
        <button className="btn" disabled={busy} onClick={() => void apply(() => api.reconnectMcp())}>
          重新连接
        </button>
      </div>
    </div>
  )
}

/**
 * A box for a number that is saved when the person is done with it: on Enter, and on leaving the
 * box. `read` turns what was typed into the number, or into the reason it cannot be one.
 */
function NumberBox({
  shown,
  label,
  placeholder,
  disabled,
  read,
  onSave
}: {
  /** The number as it is saved, the way it is written out. */
  shown: string
  label: string
  placeholder?: string
  disabled?: boolean
  read: (typed: string) => { value: number | null } | { problem: string }
  onSave: (value: number | null) => Promise<void>
}) {
  /** What is being typed; null while the box shows what is saved. */
  const [draft, setDraft] = useState<string | null>(null)
  const [problem, setProblem] = useState('')
  const commit = (): void => {
    if (draft === null || draft.trim() === shown) return setDraft(null)
    const typed = read(draft)
    if ('problem' in typed) return setProblem(typed.problem)
    setProblem('')
    onSave(typed.value).then(
      () => setDraft(null),
      (err) => setProblem(errorText(err))
    )
  }
  return (
    <span className="setting-box">
      <input
        value={draft ?? shown}
        aria-label={label}
        aria-invalid={problem ? true : undefined}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => {
          setProblem('')
          setDraft(e.target.value)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          // Escape gives up the typing, and not the dialog with it.
          if (e.key !== 'Escape' || draft === null) return
          e.stopPropagation()
          setProblem('')
          setDraft(null)
        }}
      />
      {problem && (
        <span className="setting-problem" role="alert">
          {problem}
        </span>
      )}
    </span>
  )
}

/** What holds for the whole app, whichever model is in use. */
function GeneralTab({ settings, onChanged }: { settings: Settings; onChanged: (s: Settings) => void }) {
  const [error, setError] = useState('')
  const count = (on: boolean): void => {
    setError('')
    api.setStats(on).then(onChanged, (err) => setError(errorText(err)))
  }
  const { compaction } = settings
  const compact = (change: CompactionChange): Promise<void> => {
    setError('')
    return api.setCompaction(change).then(onChanged)
  }
  return (
    <div className="tab-body">
      <label className="setting-row">
        <span className="setting-words">
          <span className="setting-name">统计用量和上下文</span>
          <span className="hint">
            在输入框下面显示当前对话的请求次数、用时、token 用量和上下文占用，数字随对话保存。为此每次请求都会向模型服务要一份用量统计：发给 OpenAI
            兼容服务的流式请求里会多一个 stream_options 字段，服务拒绝它时自动去掉重发。关掉后不再统计，也不再多发这个字段。
          </span>
        </span>
        <input type="checkbox" role="switch" className="switch" checked={settings.stats} onChange={(e) => count(e.target.checked)} />
      </label>
      <label className="setting-row">
        <span className="setting-words">
          <span className="setting-name">自动压缩上下文</span>
          <span className="hint">
            对话快要占满模型的上下文时，先把较早的工具结果从发给模型的内容里清掉；还不够，再让当前模型把较早的对话写成摘要，只把最近的部分原样保留。屏幕上的对话记录不会少。关掉后，只在你点上下文小工具里的"立即压缩"，或者模型服务报告对话太长时才压缩。
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={compaction.auto}
          onChange={(e) => void compact({ auto: e.target.checked }).catch((err) => setError(errorText(err)))}
        />
      </label>
      <div className="setting-row setting-sub">
        <span className="setting-words">
          <span className="setting-name">压缩时机</span>
          <span className="hint">
            占用达到模型上下文长度的百分之几时压缩，可以填 {LEAST} 到 {MOST}。
          </span>
        </span>
        <span className="setting-field">
          <NumberBox
            shown={String(Math.round(compaction.share * 100))}
            label="占用达到上下文长度的百分之几时压缩"
            disabled={!compaction.auto}
            read={(typed) => {
              const percent = Number(typed.replace(/[%％\s]/g, ''))
              return Number.isFinite(percent) && percent >= LEAST && percent <= MOST
                ? { value: Math.round(percent) / 100 }
                : { problem: `填 ${LEAST} 到 ${MOST} 之间的数字。` }
            }}
            onSave={(share) => compact({ share: share ?? undefined })}
          />
          %
        </span>
      </div>
      <div className="setting-row setting-sub">
        <span className="setting-words">
          <span className="setting-name">token 上限</span>
          <span className="hint">
            可选。占用超过这个数就压缩，不管模型的上下文有多长，比如 200K。上下文很长的模型每次请求都带着全部内容，设一个上限可以少花钱；留空表示不设。
          </span>
        </span>
        <span className="setting-field">
          <NumberBox
            shown={compaction.cap === null ? '' : formatTokens(compaction.cap)}
            label="占用超过多少 token 就压缩"
            placeholder="不设"
            disabled={!compaction.auto}
            read={(typed) => {
              if (!typed.trim()) return { value: null }
              const tokens = readWindow(typed)
              return tokens !== null && isCap(tokens) ? { value: tokens } : { problem: `写成 200K、1M 这样的数字，最少 ${formatTokens(CAP_MIN)}。` }
            }}
            onSave={(cap) => compact({ cap })}
          />
        </span>
      </div>
      {error && (
        <div className="msg-error" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}

/** What the app is, which version is running, where its code is, where to report a problem, and who makes it. */
function AboutTab() {
  const [version, setVersion] = useState('')
  useEffect(() => {
    api.appInfo().then(
      (info) => setVersion(info.version),
      () => {}
    )
  }, [])
  const link = (to: { label: string; url: string }) => (
    <a className="about-link" href={to.url} target="_blank" rel="noreferrer">
      {to.label}
    </a>
  )
  return (
    <div className="tab-body">
      <div className="about-head">
        <span className="about-name">StarBench</span>
        <span className="badge">{ABOUT.stage}</span>
      </div>
      <p className="about-summary">{ABOUT.summary}</p>
      <dl className="about-list">
        <dt>软件版本</dt>
        {/* The version with its revision, as the author names a build: "0.1.0-r9". */}
        <dd>{version ? `${version}-r${ABOUT.revision}（${ABOUT.stage}）` : '…'}</dd>
        <dt>GitHub 仓库</dt>
        <dd>{link(ABOUT.repo)}</dd>
        <dt>问题提交</dt>
        <dd>
          {link(ABOUT.issues)}
          <span className="hint">遇到问题或者有建议，可以在这里提出。</span>
        </dd>
        {ABOUT.authors.map((author) => (
          <Fragment key={author.url}>
            <dt>{author.role}</dt>
            <dd>
              {/* A name that is the same as the one in the address is said once. */}
              {!author.url.endsWith(`/${author.name}`) && author.name}
              {link({ label: author.url.replace(/^https:\/\//, ''), url: author.url })}
            </dd>
          </Fragment>
        ))}
      </dl>
    </div>
  )
}

export function SettingsDialog({
  settings,
  onClose,
  onSaved,
  onWelcome
}: {
  settings: Settings
  onClose: () => void
  onSaved: (s: Settings) => void
  /** The first ChatGPT sign-in with plan usage has just succeeded. */
  onWelcome: () => void
}) {
  const [tab, setTab] = useState<TabId>('model')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="设置">
        <div className="dialog-head">
          <h2>设置</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭设置">
            ×
          </button>
        </div>
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`tab ${tab === t.id ? 'tab-active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === 'model' && <ProvidersTab settings={settings} onChanged={onSaved} onWelcome={onWelcome} />}
        {tab === 'skills' && <SkillsTab />}
        {tab === 'mcp' && <McpTab />}
        {tab === 'general' && <GeneralTab settings={settings} onChanged={onSaved} />}
        {tab === 'about' && <AboutTab />}
      </div>
    </div>
  )
}
