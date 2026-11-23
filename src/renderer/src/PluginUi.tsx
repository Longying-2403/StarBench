// The interfaces of plugins, in the page. A plugin that is switched on and has a `ui/index.js`
// is loaded here: the module is fetched from the plugin's own address (shared/plugin-ui.ts), its
// `setup` is called once with what the app has for it, and the components it gives back are
// drawn in the places the app has for them: in the row under the message box (`PluginSlot`), and
// in a panel beside the conversation (`PluginPanel`).
//
// A plugin's components are drawn by the app's React, the one copy there is in the page. A
// component drawn by one copy of React that calls the hooks of another does not work, so a
// plugin does not bring React along: it is handed the app's.

import * as React from 'react'
import { Component, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { PLUGIN_UI_API, PLUGIN_UI_ENTRY, PLUGIN_UI_STYLE, disposeOf, panelOf, pluginModel, pluginUiUrl, setupOf, slotsOf } from '../../shared/plugin-ui.ts'
import type { PluginUiApi } from '../../../types/starbench-plugin'
import type { PluginPlaceProps, PluginSlotName } from '../../shared/plugin-ui.ts'
import type { Settings } from '../../shared/types.ts'
import { PLUGIN_CONTROLS } from './PluginControls.tsx'
import { notify, toasts } from './Toasts.tsx'
import { BugIcon, PluginIcon } from './icons.tsx'
import { errorText } from './util.ts'

const api = window.harness

type Part = ComponentType<PluginPlaceProps>

/** The interface of one plugin, as far as it could be loaded. */
export interface PluginUi {
  id: string
  /** The plugin's name, for telling the person whose component it is that failed. */
  name: string
  slots: Partial<Record<PluginSlotName, Part>>
  /** Its panel, with the title that goes on the button opening it. */
  panel?: { title: string; component: Part }
  /** Why there is no interface: the module could not be loaded, or its `setup` threw or never finished. */
  error?: string
  /** Which load this is, counted over all plugins. A plugin loaded anew is another one: what was said of the old does not hold for it. */
  load: number
  /** What a component of it threw while it was drawn, if one did. Its place on the page says so too. */
  failed?: string
}

/** Counts the loads, so that each has an address of its own. */
let loads = 0

/**
 * How long a plugin's interface may take to load and to finish its `setup`. One that never
 * finishes must not keep the others from showing: they are put on the page together.
 */
const LOAD_LIMIT_MS = 10_000

interface Listener {
  event: string
  hear(payload: unknown): void
}

/**
 * Who listens to what the main-process half of a plugin tells its interface, by plugin: the
 * listeners of the interface as it was loaded last. Kept here and not by the plugin, so that a
 * plugin switched off, or loaded anew, leaves no listener behind, whether or not it took them
 * away itself.
 */
const listeners = new Map<string, Set<Listener>>()

/** Hands what a plugin's main-process half told to those of its interface who listen for it. One failing does not keep the rest from hearing. */
function deliver(told: { plugin: string; event: string; payload: unknown }): void {
  for (const listener of [...(listeners.get(told.plugin) ?? [])]) {
    if (listener.event !== told.event) continue
    try {
      listener.hear(told.payload)
    } catch (err) {
      console.error(`[plugins] a listener of "${told.plugin}" for "${told.event}" failed:`, err)
    }
  }
}

/**
 * The line from a plugin's interface to its own code in the main process (`ctx.ui` there):
 * `call` asks and waits for the answer, `on` listens for what that code tells. A plugin reaches
 * its own main-process half and no other.
 */
function backendOf(id: string, own: Set<Listener>) {
  return Object.freeze({
    /** Resolves with what the handler of that name returned. Rejects with what it threw, or when there is no such handler, or the plugin is off. */
    call: (name: string, payload?: unknown): Promise<unknown> =>
      api.callPlugin(id, String(name), payload).catch((err: unknown) => {
        throw new Error(errorText(err))
      }),
    /** Returns the function that stops the listening. */
    on: (event: string, hear: (payload: unknown) => void): (() => void) => {
      if (typeof hear !== 'function') throw new Error('A listener must be a function')
      const entry = { event: String(event), hear }
      own.add(entry)
      return () => void own.delete(entry)
    }
  })
}

/** The style sheets of plugins that are in force, by plugin, with the load each belongs to. */
const styles = new Map<string, { load: number; sheet: CSSStyleSheet }>()

/** Takes the style sheet of a plugin out of force. */
function dropStyles(id: string): void {
  const held = styles.get(id)
  if (!held) return
  styles.delete(id)
  document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== held.sheet)
}

/**
 * A plugin's style sheet, made to hold for the plugin's own components and for nothing else:
 * its rules are put inside a scope that starts at the elements marked with the plugin's name
 * (`data-plugin`), which is what the app puts around everything a plugin draws. A rule for
 * `button` then finds the plugin's buttons and leaves the app's alone.
 *
 * The rules are taken as the browser read them, one by one, and not as text: a brace too many in
 * the file cannot end the scope early. What cannot live inside a scope and is known by name
 * throughout the window all the same (animations, fonts) is put beside it.
 *
 * The sheet is rearranged where it is and not copied into a new one: an address written in it,
 * such as a picture beside it, is relative to where the sheet came from, and a new sheet would
 * read it against the page.
 */
function scopedTo(id: string, sheet: CSSStyleSheet): CSSStyleSheet {
  const inside: string[] = []
  const beside: string[] = []
  for (const rule of sheet.cssRules) {
    const global = rule instanceof CSSKeyframesRule || rule instanceof CSSFontFaceRule || rule instanceof CSSPropertyRule || rule instanceof CSSCounterStyleRule
    ;(global ? beside : inside).push(rule.cssText)
  }
  while (sheet.cssRules.length > 0) sheet.deleteRule(0)
  for (const rule of beside) sheet.insertRule(rule, sheet.cssRules.length)
  const marked = `[data-plugin="${id.replace(/["\\]/g, '\\$&')}"]`
  const scope = sheet.cssRules[sheet.insertRule(`@scope (${marked}) {}`, sheet.cssRules.length)] as CSSGroupingRule
  for (const rule of inside) scope.insertRule(rule, scope.cssRules.length)
  return sheet
}

/**
 * What each plugin asked to have done when its interface is taken off the page (`dispose` in what
 * its `setup` returned), by plugin.
 */
const cleanups = new Map<string, () => unknown>()

/** Runs what a plugin left to be done at the end. Its failing is its own affair, and is only written down. */
function finish(id: string, cleanup: () => unknown): void {
  try {
    void Promise.resolve(cleanup()).catch((err: unknown) => console.error(`[plugins] the interface of "${id}" failed while it was taken off the page:`, err))
  } catch (err) {
    console.error(`[plugins] the interface of "${id}" failed while it was taken off the page:`, err)
  }
}

/**
 * Takes what the page holds of a plugin's interface away: the listeners on its line, its style
 * sheet, and whatever it asked to have stopped. Its components go when it leaves the list.
 */
function drop(id: string): void {
  listeners.delete(id)
  dropStyles(id)
  // What was said of an interface that is no longer there no longer holds.
  toasts.dismissKey(failureNotice(id))
  const cleanup = cleanups.get(id)
  cleanups.delete(id)
  if (cleanup) finish(id, cleanup)
}

async function load(id: string, name: string, withStyle: boolean): Promise<PluginUi> {
  // What an earlier load of this plugin left goes first; then the listeners of this one take the place of the old.
  drop(id)
  const own = new Set<Listener>()
  listeners.set(id, own)
  // The browser keeps every module it has read under its address. Each load asks under a number
  // of its own, in the path, so that the entry and all it imports from beside it are read anew.
  const mine = ++loads
  /** Whether this load is still the one that counts: the plugin was not switched off, or loaded once more, in the meantime. */
  const counts = (): boolean => listeners.get(id) === own
  const read = async (): Promise<PluginUi> => {
    if (withStyle) {
      // In force before the first component is drawn, so that nothing is seen without its styles.
      const sheet = scopedTo(id, ((await import(/* @vite-ignore */ pluginUiUrl(id, PLUGIN_UI_STYLE, mine), { with: { type: 'css' } })) as { default: CSSStyleSheet }).default)
      if (counts()) {
        dropStyles(id)
        styles.set(id, { load: mine, sheet })
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
      }
    }
    const module: unknown = await import(/* @vite-ignore */ pluginUiUrl(id, PLUGIN_UI_ENTRY, mine))
    const setup = setupOf(module)
    if (!setup) throw new Error('ui/index.js has to export a setup(api) function, by default or under that name')
    // What a plugin is handed, held by the compiler to what the people who write plugins were told it is.
    const handed: PluginUiApi = Object.freeze({ apiVersion: PLUGIN_UI_API, id, React, controls: PLUGIN_CONTROLS, backend: backendOf(id, own) })
    const given = await setup(handed)
    const cleanup = disposeOf(given)
    // Kept for when the plugin goes. One that was overtaken while it loaded is not shown, and ends here.
    if (cleanup && counts()) cleanups.set(id, cleanup)
    else if (cleanup) finish(id, cleanup)
    const panel = panelOf(given) as PluginUi['panel'] | null
    return { id, name, load: mine, slots: slotsOf(given) as PluginUi['slots'], ...(panel ? { panel } : {}) }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const tooLong = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`It did not finish loading within ${LOAD_LIMIT_MS / 1000} seconds`)), LOAD_LIMIT_MS)
  })
  try {
    return await Promise.race([read(), tooLong])
  } catch (err) {
    console.error(`[plugins] the interface of "${id}" could not be loaded:`, err)
    // Whatever it had begun to listen for before it failed is not heard, and its styles are of no use.
    own.clear()
    if (styles.get(id)?.load === mine) dropStyles(id)
    return { id, name, load: mine, slots: {}, error: errorText(err) }
  } finally {
    clearTimeout(timer)
  }
}

const Loaded = createContext<PluginUi[]>([])

/** Which plugin's panel is open beside the conversation, and the way to change that. One at a time. */
const Panels = createContext<{ open: string | null; toggle(id: string): void; close(): void }>({ open: null, toggle() {}, close() {} })

const NO_PLACE: PluginPlaceProps = { conversation: { id: null, workspace: '', running: false }, model: null }
const Place = createContext<PluginPlaceProps>(NO_PLACE)
/** The way for the app to say which conversation is on the page (`useAnnouncePlace`). */
const Announce = createContext<(place: PluginPlaceProps) => void>(() => {})
/** The way for a component's guard to say that the component failed, so that the settings page can say it too. */
const Report = createContext<(load: number, message: string) => void>(() => {})

/** The interfaces of the plugins that are switched on, those that failed to load or to draw among them. */
export const usePluginUis = (): PluginUi[] => useContext(Loaded)

/** Which plugin's panel is open beside the conversation, and the way to open and close one. */
export const usePluginPanels = (): { open: string | null; toggle(id: string): void; close(): void } => useContext(Panels)

/** What the notice about a plugin's interface is known by: one for each plugin at most, and gone when the plugin is. */
const FAILURE_NOTICE = 'plugin-ui:'
const failureNotice = (id: string): string => `${FAILURE_NOTICE}${id}`

/** How many places on show already say what is wrong with the interfaces of plugins. */
let inSight = 0

/**
 * For a place that lists what is wrong with the interfaces of plugins, as the page of the
 * plugins does: while it is on show, the notices about them stay away. They would say the same
 * thing a second time, and lie over the very list they are about.
 */
export function useFailuresInSight(): void {
  useEffect(() => {
    inSight++
    for (const toast of toasts.snapshot()) if (toast.key?.startsWith(FAILURE_NOTICE)) toasts.dismiss(toast.id)
    return () => void inSight--
  }, [])
}

/**
 * Loads the interfaces of the plugins that are switched on and keeps them in step with the
 * switches: one switched on is loaded, one switched off is dropped, and with it every component
 * of its that was on the page.
 */
export function PluginUiProvider({ children }: { children: ReactNode }) {
  const [loaded, setUis] = useState<PluginUi[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [place, setPlace] = useState(NO_PLACE)
  /** What components threw while they were drawn, by the load they belong to. */
  const [failures, setFailures] = useState<ReadonlyMap<number, string>>(new Map())
  const report = useCallback((load: number, message: string) => setFailures((now) => new Map(now).set(load, message)), [])
  const uis = useMemo(() => loaded.map((ui) => (failures.has(ui.load) ? { ...ui, failed: failures.get(ui.load) } : ui)), [loaded, failures])
  // An interface that failed is said in the corner of the window too: the page of the plugins,
  // where it is written down, is not where the person is when it happens. Said once for each
  // failure, so that a notice that was closed stays closed.
  const told = useRef(new Set<string>())
  useEffect(() => {
    for (const ui of uis) {
      const failure = ui.error ? { how: 'load', title: '的界面没有加载成功', text: ui.error } : ui.failed ? { how: 'draw', title: '的界面出错了', text: ui.failed } : null
      if (!failure || told.current.has(`${ui.load}:${failure.how}`)) continue
      told.current.add(`${ui.load}:${failure.how}`)
      // Not while the list that says it is on show: there it has been said.
      if (inSight === 0) notify({ kind: 'error', key: failureNotice(ui.id), title: `插件“${ui.name}”${failure.title}`, text: failure.text })
    }
  }, [uis])
  useEffect(() => {
    let current = true
    /**
     * By plugin: the load under way or done, and the start of the plugin it was made for. Nothing
     * is loaded a second time while the plugin keeps running; one that was started again
     * (switched off and on, or reloaded) is.
     */
    const kept = new Map<string, { run: number; loading: Promise<PluginUi> }>()
    /** By plugin: what a load that has finished came to. */
    const done = new Map<string, PluginUi>()
    /** The plugins that are to have their interface on the page, in the order of the plugin list. */
    let wanted: string[] = []
    let latest = 0
    // Each interface is put on the page when it is ready, and does not wait for a slower one.
    const show = (): void => {
      if (current) setUis(wanted.flatMap((id) => (done.has(id) ? [done.get(id)!] : [])))
    }
    const sync = async (): Promise<void> => {
      const mine = ++latest
      const listed = (await api.listPlugins().catch(() => [])).filter((p) => p.ui)
      // Two switches in quick succession: the later one has the newer list.
      if (!current || mine !== latest) return
      wanted = listed.map((p) => p.id)
      for (const [id, { run }] of [...kept]) {
        if (listed.some((p) => p.id === id && p.run === run)) continue
        // Switched off, or started again: what the page held of it goes.
        kept.delete(id)
        done.delete(id)
        drop(id)
      }
      for (const p of listed) {
        if (kept.has(p.id)) continue
        const loading = load(p.id, p.name, p.uiStyle)
        kept.set(p.id, { run: p.run, loading })
        void loading.then((ui) => {
          // Switched off, or started again, while it loaded: this load is no longer the one that counts.
          if (kept.get(p.id)?.loading !== loading) return
          done.set(p.id, ui)
          show()
        })
      }
      show()
    }
    void sync()
    const off = api.onPluginsChanged(() => void sync())
    const offEvents = api.onPluginEvent(deliver)
    return () => {
      current = false
      off()
      offEvents()
    }
  }, [])

  // A panel whose plugin was switched off is gone, and does not come back open by itself when the plugin does.
  const shown = open !== null && uis.some((ui) => ui.id === open && ui.panel) ? open : null
  useEffect(() => {
    if (open !== shown) setOpen(shown)
  }, [open, shown])
  // The sidebar gives up room for an open panel, so that the conversation between them keeps its width (styles.css).
  useEffect(() => {
    if (shown === null) return
    document.documentElement.dataset.pluginPanel = ''
    return () => {
      delete document.documentElement.dataset.pluginPanel
    }
  }, [shown])

  const toggle = useCallback((id: string) => setOpen((now) => (now === id ? null : id)), [])
  const close = useCallback(() => setOpen(null), [])
  const panels = useMemo(() => ({ open: shown, toggle, close }), [shown, toggle, close])
  return (
    <Loaded.Provider value={uis}>
      <Panels.Provider value={panels}>
        <Report.Provider value={report}>
          <Announce.Provider value={setPlace}>
            <Place.Provider value={place}>{children}</Place.Provider>
          </Announce.Provider>
        </Report.Provider>
      </Panels.Provider>
    </Loaded.Provider>
  )
}

/**
 * Tells the components of plugins which conversation is on the page and which model it talks
 * to. Called by the app, where both are known. The components are drawn again when one of these
 * values changes, and not every time the app draws: of the settings only what a plugin is told
 * counts, written out as text so that the same values are the same thing.
 */
export function useAnnouncePlace(id: string | null, workspace: string, running: boolean, settings: Settings | null): void {
  const announce = useContext(Announce)
  const model = JSON.stringify(pluginModel(settings))
  useEffect(
    () => announce({ conversation: { id, workspace, running }, model: JSON.parse(model) as PluginPlaceProps['model'] }),
    [announce, id, workspace, running, model]
  )
}

/**
 * Stands around each component of a plugin. What the component throws while it is drawn stops
 * here: its own place says that it failed, and the rest of the window goes on.
 */
class Guard extends Component<{ plugin: string; onFail(message: string): void; children: ReactNode }, { failed: string | null }> {
  state: { failed: string | null } = { failed: null }

  static getDerivedStateFromError(err: unknown): { failed: string } {
    return { failed: errorText(err) }
  }

  componentDidCatch(err: unknown): void {
    console.error(`[plugins] a component of "${this.props.plugin}" failed:`, err)
    this.props.onFail(errorText(err))
  }

  render(): ReactNode {
    if (this.state.failed === null) return this.props.children
    return (
      <span className="plugin-failed" role="status" title={this.state.failed}>
        插件“{this.props.plugin}”的界面出错了
      </span>
    )
  }
}

/** One of the app's places for plugins: draws the component each loaded plugin has for it, in the order of the plugin list. */
function PluginSlot({ name }: { name: PluginSlotName }) {
  const uis = usePluginUis()
  const place = useContext(Place)
  const report = useContext(Report)
  return (
    <>
      {uis.map((ui) => {
        const Part = ui.slots[name]
        // A plugin loaded anew has a guard of its own: what its components did before is not held against it.
        // The mark around it is where the plugin's own style sheet begins to hold (`scopedTo`).
        return Part ? (
          <span key={ui.load} className="plugin-part" data-plugin={ui.id}>
            <Guard plugin={ui.name} onFail={(message) => report(ui.load, message)}>
              <Part {...place} />
            </Guard>
          </span>
        ) : null
      })}
    </>
  )
}

/** The plugin that comes with the app for looking into what passes between it and a model (plugins/debug). */
const DEBUG_PLUGIN = 'debug'

/** The buttons that open and close the panels of plugins: one for each plugin that has a panel, labelled with the panel's title. */
function PluginPanelButtons() {
  const uis = usePluginUis()
  const { open, toggle } = useContext(Panels)
  return (
    <>
      {uis.map((ui) =>
        ui.panel ? (
          <button
            key={ui.id}
            type="button"
            className="btn btn-small plugin-panel-button"
            aria-pressed={open === ui.id}
            aria-controls="plugin-panel"
            data-set={open === ui.id ? '' : undefined}
            title={`${open === ui.id ? '收起' : '打开'}插件“${ui.name}”的面板：${ui.panel.title}`}
            onClick={() => toggle(ui.id)}
          >
            {/* The panel that comes with the app for looking into a model's behaviour has a drawing of its own; any other goes by the mark of plugins. */}
            {ui.id === DEBUG_PLUGIN ? <BugIcon /> : <PluginIcon />}
            <span className="plugin-panel-title">{ui.panel.title}</span>
          </button>
        ) : null
      )}
    </>
  )
}

/**
 * What plugins have in the row under the message box, beside the app's own button there: their
 * components for `composer.actions`, then the buttons of their panels. Nothing at all while no
 * plugin has either. When the row is full these go onto further lines of their own.
 */
export function PluginRow() {
  const uis = usePluginUis()
  if (!uis.some((ui) => ui.slots['composer.actions'] || ui.panel)) return null
  return (
    <div className="plugin-row">
      <PluginSlot name="composer.actions" />
      <PluginPanelButtons />
    </div>
  )
}

/**
 * The panel of a plugin, when one is open: a column to the right of the conversation. The head,
 * with the title and the way to close it, is the app's; what is under it is the plugin's.
 */
export function PluginPanel() {
  const uis = usePluginUis()
  const { open, close } = useContext(Panels)
  const place = useContext(Place)
  const report = useContext(Report)
  const ui = uis.find((candidate) => candidate.id === open)
  if (!ui?.panel) return null
  const Body = ui.panel.component
  return (
    <aside className="plugin-panel" id="plugin-panel" aria-label={`插件面板：${ui.panel.title}`}>
      <div className="plugin-panel-head">
        <h2 title={`来自插件“${ui.name}”`}>{ui.panel.title}</h2>
        <button type="button" className="icon-btn" onClick={close} aria-label="收起面板">
          ×
        </button>
      </div>
      <div className="plugin-panel-body" data-plugin={ui.id}>
        {/* A plugin switched off and on has another component under the same name: it starts anew. */}
        <Guard key={ui.load} plugin={ui.name} onFail={(message) => report(ui.load, message)}>
          <Body {...place} />
        </Guard>
      </div>
    </aside>
  )
}
