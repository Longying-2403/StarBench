// The plugins, as a page in the main part of the window: which there are, switching them on
// and off, starting one again after its files were changed, opening its panel, and what went
// wrong with one. Reached from the sidebar.

import { useCallback, useEffect, useState } from 'react'
import type { PluginInfo } from '../../shared/types.ts'
import { ChevronLeftIcon } from './icons.tsx'
import { Notice } from './Notice.tsx'
import { useFailuresInSight, usePluginPanels, usePluginUis } from './PluginUi.tsx'
import { errorText } from './util.ts'

const api = window.harness

const PLUGIN_STATUS: Record<PluginInfo['status'], string> = {
  disabled: '未启用',
  active: '运行中',
  waiting: '等待中',
  error: '出错',
  held: '本次未加载'
}

export function PluginsPage({ onBack }: { onBack: () => void }) {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  const [error, setError] = useState('')
  /** Id of the plugin whose switch is mid-flight, so it cannot be toggled twice. */
  const [busy, setBusy] = useState<string | null>(null)
  const panels = usePluginPanels()
  // What is wrong with an interface is written in the list below, so it is not said in the corner too.
  useFailuresInSight()
  /** What is wrong with the interface of a plugin, by plugin: it did not load, or a component of it failed. Known to the page, where it is loaded. */
  const uiErrors = new Map<string, string>()
  /** The plugins whose interface has finished loading, well or badly. One that is not among them yet is still on its way. */
  const uiReady = new Set<string>()
  /** The plugins that have a panel beside the conversation. */
  const withPanel = new Set<string>()
  for (const ui of usePluginUis()) {
    uiReady.add(ui.id)
    if (ui.panel) withPanel.add(ui.id)
    if (ui.error) uiErrors.set(ui.id, `界面没有加载成功：${ui.error}`)
    else if (ui.failed) uiErrors.set(ui.id, `界面的一个组件出错了：${ui.failed}`)
  }

  const refresh = useCallback(() => {
    setError('')
    api.listPlugins().then(setPlugins, (err) => setError(errorText(err)))
  }, [])
  useEffect(refresh, [refresh])
  /** The app was started with every plugin left out. */
  const [held, setHeld] = useState(false)
  useEffect(() => {
    api.pluginsHeld().then(setHeld, () => {})
  }, [])

  /** Switches a plugin on or off, or starts a running one again; either way the list is read anew. */
  const change = async (plugin: PluginInfo, how: 'toggle' | 'reload'): Promise<void> => {
    setBusy(plugin.id)
    setError('')
    try {
      setPlugins(how === 'reload' ? await api.reloadPlugin(plugin.id) : await api.setPluginEnabled(plugin.id, !plugin.enabled))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <header className="page-head">
        <button className="btn btn-small page-back" onClick={onBack}>
          <ChevronLeftIcon />
          返回对话
        </button>
        <h1 id="plugins-title">插件</h1>
      </header>
      <div className="page-body">
        <Notice>插件在应用内以完整权限运行：可以读写文件、执行命令，也能访问你的 API Key 和 ChatGPT 登录。只启用你信任的插件。</Notice>
        {held && (
          <Notice>
            这次启动没有加载任何插件（应用是带着 --no-plugins 启动的）。在这里改动的开关会保存下来，下次正常启动时生效。
          </Notice>
        )}
        {/* Above the list and to the left: the right end of the top of the window is where the notices come up. */}
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
          <p className="hint">还没有插件。把插件文件夹放进插件目录，然后点"刷新"。修改插件的文件后点它的"重新加载"。</p>
        )}
        <ul className="rows">
          {plugins?.map((plugin) => (
            <li key={plugin.id} className="row">
              <div className="row-main">
                <div className="row-title">
                  {plugin.name}
                  {plugin.version && <span className="row-meta">{plugin.version}</span>}
                  {plugin.builtin && (
                    <span className="badge" title="随应用一起安装的插件">
                      内置
                    </span>
                  )}
                  <span className={`badge badge-${plugin.status}`}>{PLUGIN_STATUS[plugin.status]}</span>
                </div>
                {plugin.description && <div className="row-desc">{plugin.description}</div>}
                {plugin.tools.length > 0 && <div className="row-meta">工具：{plugin.tools.join('、')}</div>}
                {plugin.skills.length > 0 && <div className="row-meta">Skills：{plugin.skills.join('、')}</div>}
                {plugin.ui && !uiErrors.get(plugin.id) && <div className="row-meta">界面：{uiReady.has(plugin.id) ? '已加载到窗口里' : '正在加载…'}</div>}
                {plugin.error && <div className="row-error">{plugin.error}</div>}
                {plugin.ui && uiErrors.get(plugin.id) && <div className="row-error">{uiErrors.get(plugin.id)}</div>}
              </div>
              {/* The panel a plugin has beside the conversation, opened from here as from under the message box. */}
              {withPanel.has(plugin.id) && (
                <button
                  className="btn btn-small"
                  aria-pressed={panels.open === plugin.id}
                  aria-controls="plugin-panel"
                  onClick={() => panels.toggle(plugin.id)}
                  aria-label={`${panels.open === plugin.id ? '收起' : '打开'}插件 ${plugin.name} 的面板`}
                >
                  {panels.open === plugin.id ? '收起面板' : '打开面板'}
                </button>
              )}
              {/* For someone changing the plugin's files: started again, it is read anew, its interface with it. */}
              {plugin.enabled && !held && (
                <button
                  className="btn btn-small"
                  disabled={busy !== null}
                  onClick={() => void change(plugin, 'reload')}
                  title="停掉再启动这个插件，读入它文件夹里改动过的内容"
                  aria-label={`重新加载插件 ${plugin.name}`}
                >
                  重新加载
                </button>
              )}
              <input
                type="checkbox"
                role="switch"
                className="switch"
                checked={plugin.enabled}
                disabled={busy !== null}
                onChange={() => void change(plugin, 'toggle')}
                aria-label={`启用插件 ${plugin.name}`}
              />
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}
