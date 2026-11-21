import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { PluginInfo, Settings } from '../../shared/types.ts'
import { errorText } from './util.ts'

const api = window.harness

const TABS = [
  { id: 'model', label: '模型' },
  { id: 'plugins', label: '插件' }
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
      </div>
    </div>
  )
}
