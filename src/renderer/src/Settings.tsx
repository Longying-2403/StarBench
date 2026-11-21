import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { CHATGPT_HELP_URL, PROVIDER_KINDS, PROVIDER_PRESETS } from '../../shared/types.ts'
import type { McpServerStatus, ModelChoice, PluginInfo, ProviderInfo, ProviderKind, Settings, SkillInfo } from '../../shared/types.ts'
import { ChatGptButton, ChatGptPane } from './ChatGptPane.tsx'
import { Notice } from './Notice.tsx'
import { errorText } from './util.ts'

const api = window.harness

const TABS = [
  { id: 'model', label: '模型' },
  { id: 'plugins', label: '插件' },
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP' }
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

  // The service's own list makes the model field a pick list. It is a convenience: typing still works.
  useEffect(() => {
    if (draft.id && draft.hasApiKey) api.listModels(draft.id).then(setModels, () => {})
  }, [draft.id, draft.hasApiKey])

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
      <label>
        API Key
        <input
          type="password"
          value={apiKey}
          autoFocus={!draft.hasApiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={draft.hasApiKey ? '已保存，留空则不修改' : draft.keyHint}
        />
        <span className="hint">
          使用系统凭据加密后保存在本机，不会写入项目文件。
          {planOffered && !draft.hasApiKey && '没有 API Key？点"返回"，可以改用 ChatGPT 套餐登录。'}
        </span>
      </label>
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
  if (provider.hasApiKey) return ''
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
    if (settings.hasApiKey) return null
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
        可以添加多个模型服务，各用各的 API Key，也可以用 ChatGPT 套餐登录。用哪个模型，在输入框右下角点模型名切换。
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

const PLUGIN_STATUS: Record<PluginInfo['status'], string> = {
  disabled: '未启用',
  active: '运行中',
  waiting: '等待中',
  error: '出错'
}

function PluginsTab() {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  const [error, setError] = useState('')
  /** Id of the plugin whose switch is mid-flight, so it cannot be toggled twice. */
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(() => {
    setError('')
    api.listPlugins().then(setPlugins, (err) => setError(errorText(err)))
  }, [])
  useEffect(refresh, [refresh])

  const toggle = async (plugin: PluginInfo): Promise<void> => {
    setBusy(plugin.id)
    setError('')
    try {
      setPlugins(await api.setPluginEnabled(plugin.id, !plugin.enabled))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="tab-body">
      <Notice>插件在应用内以完整权限运行：可以读写文件、执行命令，也能访问你的 API Key 和 ChatGPT 登录。只启用你信任的插件。</Notice>
      <div className="toolbar">
        <button className="btn" onClick={() => api.openPluginsFolder().catch((err) => setError(errorText(err)))}>
          打开插件文件夹
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
      {plugins?.length === 0 && (
        <p className="hint">还没有插件。把插件文件夹放进插件目录，然后点"刷新"。修改插件代码后需要重启应用。</p>
      )}
      <ul className="rows">
        {plugins?.map((plugin) => (
          <li key={plugin.id} className="row">
            <div className="row-main">
              <div className="row-title">
                {plugin.name}
                {plugin.version && <span className="row-meta">{plugin.version}</span>}
                <span className={`badge badge-${plugin.status}`}>{PLUGIN_STATUS[plugin.status]}</span>
              </div>
              {plugin.description && <div className="row-desc">{plugin.description}</div>}
              {plugin.tools.length > 0 && <div className="row-meta">工具：{plugin.tools.join('、')}</div>}
              {plugin.skills.length > 0 && <div className="row-meta">Skills：{plugin.skills.join('、')}</div>}
              {plugin.error && <div className="row-error">{plugin.error}</div>}
            </div>
            <input
              type="checkbox"
              role="switch"
              className="switch"
              checked={plugin.enabled}
              disabled={busy !== null}
              onChange={() => void toggle(plugin)}
              aria-label={`启用插件 ${plugin.name}`}
            />
          </li>
        ))}
      </ul>
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
                <span className="row-meta">{skill.source === 'user' ? '我的 Skill' : `来自插件 ${skill.source}`}</span>
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
        工具前都会征求你的同意。环境变量和请求头里的密钥会以明文保存在本机的 mcp.json 里。
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
        {tab === 'plugins' && <PluginsTab />}
        {tab === 'skills' && <SkillsTab />}
        {tab === 'mcp' && <McpTab />}
      </div>
    </div>
  )
}
