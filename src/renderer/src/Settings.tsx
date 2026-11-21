import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { McpServerStatus, PluginInfo, Settings, SkillInfo } from '../../shared/types.ts'
import { errorText } from './util.ts'

const api = window.harness

const TABS = [
  { id: 'model', label: '模型' },
  { id: 'plugins', label: '插件' },
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP' }
] as const
type TabId = (typeof TABS)[number]['id']

function ModelTab({
  settings,
  onClose,
  onSaved
}: {
  settings: Settings
  onClose: () => void
  onSaved: (s: Settings) => void
}) {
  const [baseURL, setBaseURL] = useState(settings.baseURL)
  const [model, setModel] = useState(settings.model)
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      // An empty key field means "keep the stored key".
      onSaved(await api.saveSettings({ baseURL, model, ...(apiKey ? { apiKey } : {}) }))
      onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="tab-body" onSubmit={submit}>
      <label>
        API Key
        <input
          type="password"
          value={apiKey}
          autoFocus
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={settings.hasApiKey ? '已保存，留空则不修改' : 'sk-…'}
        />
        <span className="hint">使用系统凭据加密后保存在本机，不会写入项目文件。</span>
      </label>
      <label>
        接口地址
        <input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
        <span className="hint">任何兼容 OpenAI 格式的服务都可以。</span>
      </label>
      <label>
        模型
        <input value={model} onChange={(e) => setModel(e.target.value)} list="models" />
        <datalist id="models">
          <option value="deepseek-flash" />
          <option value="deepseek-v4-pro" />
        </datalist>
      </label>
      {error && (
        <div className="msg-error" role="alert">
          {error}
        </div>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          取消
        </button>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          保存
        </button>
      </div>
    </form>
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
      <p className="notice">
        插件在应用内以完整权限运行：可以读写文件、执行命令，也能访问你的 API Key。只启用你信任的插件。
      </p>
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
  onSaved
}: {
  settings: Settings
  onClose: () => void
  onSaved: (s: Settings) => void
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
        {tab === 'model' && <ModelTab settings={settings} onClose={onClose} onSaved={onSaved} />}
        {tab === 'plugins' && <PluginsTab />}
        {tab === 'skills' && <SkillsTab />}
        {tab === 'mcp' && <McpTab />}
      </div>
    </div>
  )
}
