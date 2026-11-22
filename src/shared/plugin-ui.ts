// How the page reaches the files of a plugin's interface. A plugin keeps them in a `ui/` folder
// of its own, and the page asks for them under an address of the app's own making:
//
//   starbench-plugin://ui/<plugin id>/<file in the plugin's ui folder>
//
// The main process answers such an address with the file, for plugins that are switched on and
// for nothing outside their `ui/` folders. The page is let to load scripts from this scheme and
// from no other place besides the app itself.

import type { PluginModel, PluginPlaceProps } from '../../types/starbench-plugin'
import { isLocalAddress } from './types.ts'
import type { Settings } from './types.ts'

export const PLUGIN_UI_SCHEME = 'starbench-plugin'
const HOST = 'ui'

/** The file a plugin's interface starts from. */
export const PLUGIN_UI_ENTRY = 'index.js'

/**
 * The style sheet of a plugin's interface, if it has one, beside the entry. The page puts it in
 * force for the plugin's own components and for nothing else in the window.
 */
export const PLUGIN_UI_STYLE = 'index.css'

/**
 * What of the app's own look a plugin may lean on: the custom properties that carry the colours
 * (they change with the light and the dark setting) and a few class names. These are a promise
 * to the people who write plugins, and a test holds the style sheet to it. Every other class
 * name in the app is its own business and may change at any time.
 */
export const PLUGIN_STYLE = {
  variables: ['--bg', '--panel', '--raised', '--border', '--text', '--muted', '--accent', '--accent-text', '--danger', '--warn', '--ok', '--mono'],
  classes: ['btn', 'btn-primary', 'btn-small', 'hint', 'code']
} as const

/**
 * The address of a file of a plugin's interface. Each part of the path is encoded by itself, so
 * a name may hold any character.
 *
 * `load` says which load of the interface the file is asked for, as a part of the path
 * (`/debug/@7/index.js`). The browser keeps every module it has read under its address, for as
 * long as the window lives. With the number in the path, the files that the entry imports from
 * beside it get new addresses too, so that an interface loaded anew is read anew as a whole.
 */
export function pluginUiUrl(id: string, file: string = PLUGIN_UI_ENTRY, load?: number): string {
  const parts = [id, ...(load === undefined ? [] : [`@${load}`]), ...file.split('/')].map(encodeURIComponent)
  return `${PLUGIN_UI_SCHEME}://${HOST}/${parts.join('/')}`
}

/**
 * What an address asks for: the plugin, and the file within its `ui/` folder with `/` between
 * the folders. Null for anything that is not such an address, and for one that tries to name
 * something by a way round: a part that is `..`, or that hides a slash or a backslash in itself.
 */
export function parsePluginUiUrl(address: string): { id: string; file: string } | null {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return null
  }
  if (url.protocol !== `${PLUGIN_UI_SCHEME}:` || url.hostname !== HOST) return null
  const parts: string[] = []
  for (const raw of url.pathname.split('/').slice(1)) {
    let part: string
    try {
      part = decodeURIComponent(raw)
    } catch {
      return null
    }
    if (!part || part === '.' || part === '..' || /[/\\\0]/.test(part)) return null
    parts.push(part)
  }
  // The number of the load, where there is one, names no folder: the file is the same under every number.
  if (parts.length > 1 && /^@\d+$/.test(parts[1])) parts.splice(1, 1)
  if (parts.length < 2) return null
  return { id: parts[0], file: parts.slice(1).join('/') }
}

/**
 * What the app hands to a plugin's interface, by number. A plugin can look at it before relying
 * on something newer; it is raised when something a plugin may rely on changes.
 */
export const PLUGIN_UI_API = 1

/**
 * The places in the app's own interface where a plugin can put a component of its own:
 *
 *   composer.actions   in the row of buttons under the message box, after the app's own. Meant for
 *                      a button or a short readout: the row is one line high.
 *
 * Besides these a plugin can have one panel (`panelOf`): a column of its own to the right of the
 * conversation, which the app opens and closes with a button it adds to that same row.
 */
export const PLUGIN_SLOTS = ['composer.actions'] as const
export type PluginSlotName = (typeof PLUGIN_SLOTS)[number]

// What a plugin is handed is written down once, in the types for the people who write plugins
// (types/starbench-plugin.d.ts), and the app uses those very types. So what is promised there
// and what is done here cannot drift apart without the compiler saying so: a new kind of
// service, say, that the app knows and the promise does not.
//
//   PluginModel       what a plugin's interface may know of the model that messages go to.
//                     Nothing that opens the service: no key, and not its address, only whether
//                     that address is on this computer or the network around it.
//   PluginPlaceProps  what every component of a plugin is told about where it is, as its props.
//                     Plain values: the component is drawn again when one of them changes.
export type { PluginModel, PluginPlaceProps }

/** What a plugin is told of the model in use, out of the settings. Null when none is chosen, or the settings are not read yet. */
export function pluginModel(settings: Pick<Settings, 'providers' | 'activeProviderId' | 'model' | 'reasoningEffort'> | null): PluginModel | null {
  const provider = settings?.providers.find((p) => p.id === settings.activeProviderId)
  if (!settings || !provider || !settings.model) return null
  return {
    id: settings.model,
    effort: settings.reasoningEffort,
    provider: { id: provider.id, name: provider.name, kind: provider.kind, local: isLocalAddress(provider.baseURL) }
  }
}

/**
 * The number a slider stands on for a value that was dragged or typed: within its two ends, on
 * one of its steps counted from the lower end, and without the crumbs that sums of fractions
 * leave (0.1 + 0.2). A value that is no number stands at the lower end.
 */
export function onSliderStep(value: number, min: number, max: number, step: number): number {
  if (!Number.isFinite(value)) return min
  const held = Math.min(max, Math.max(min, value))
  const stepped = min + Math.round((held - min) / step) * step
  return Number(Math.min(max, stepped).toFixed(decimalsOf(step, min)))
}

/** How many places after the point the values of a slider have: as many as its step or its lower end is written with. */
export function decimalsOf(...numbers: number[]): number {
  const places = (n: number): number => {
    const text = String(n)
    if (text.includes('e-')) return Number(text.split('e-')[1]) + (text.split('e-')[0].split('.')[1]?.length ?? 0)
    return text.split('.')[1]?.length ?? 0
  }
  return Math.min(10, Math.max(0, ...numbers.map(places)))
}

/** How long the title of a panel may be. It is the label of a button in a row with others; a longer one is cut. */
export const PANEL_TITLE_LIMIT = 16

/**
 * What a plugin wants done when its interface is taken off the page, out of what its `setup`
 * returned: `{ dispose() { ... } }`. The place to stop what the interface started by itself, a
 * timer or a listener on the window: the app takes away the components, the style sheet and the
 * listeners on the plugin's own line, and knows of nothing else. Null when there is none.
 */
export function disposeOf(result: unknown): (() => unknown) | null {
  const given = typeof result === 'object' && result !== null ? (result as { dispose?: unknown }).dispose : undefined
  return typeof given === 'function' ? (given as () => unknown) : null
}

/**
 * The panel a plugin gave, out of what its `setup` returned: `{ panel: { title, component } }`.
 * Null when there is none, or when it lacks what the app needs to show one: a title to put on
 * the button that opens it, and a component to draw.
 */
export function panelOf(result: unknown): { title: string; component: (props: never) => unknown } | null {
  const given = typeof result === 'object' && result !== null ? (result as { panel?: unknown }).panel : undefined
  if (typeof given !== 'object' || given === null) return null
  const { title, component } = given as { title?: unknown; component?: unknown }
  if (typeof title !== 'string' || typeof component !== 'function') return null
  const clean = [...title.replace(/\s+/g, ' ').trim()].slice(0, PANEL_TITLE_LIMIT).join('').trim()
  return clean ? { title: clean, component: component as (props: never) => unknown } : null
}

/**
 * The function a plugin's `ui/index.js` has to export, by default or under the name `setup`. The
 * app calls it once with what it has for the plugin, the app's own React among it, and takes
 * what it gives back (`slotsOf`). Null when the module has no such function.
 */
export function setupOf(module: unknown): ((api: unknown) => unknown) | null {
  if (typeof module !== 'object' || module === null) return null
  const { default: byDefault, setup } = module as { default?: unknown; setup?: unknown }
  for (const candidate of [setup, byDefault]) {
    if (typeof candidate === 'function') return candidate as (api: unknown) => unknown
  }
  return null
}

/**
 * The components a plugin gave for the places the app has, out of what its `setup` returned:
 * `{ slots: { 'composer.actions': Component } }`. Anything else in it is left out, a place the
 * app does not have and a component that is not a function alike, so that a plugin written for a
 * newer app still shows what this one can show.
 */
export function slotsOf(result: unknown): Partial<Record<PluginSlotName, (props: never) => unknown>> {
  const given = typeof result === 'object' && result !== null ? (result as { slots?: unknown }).slots : undefined
  const out: Partial<Record<PluginSlotName, (props: never) => unknown>> = {}
  if (typeof given !== 'object' || given === null) return out
  for (const name of PLUGIN_SLOTS) {
    const part = (given as Record<string, unknown>)[name]
    if (typeof part === 'function') out[name] = part as (props: never) => unknown
  }
  return out
}

/** The kinds of file an interface is made of, with the type each is served as. Anything else is not served. */
const TYPES: Record<string, string> = {
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
  map: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  woff2: 'font/woff2'
}

/** The type a file of an interface is served as, by its ending. Null for a kind that is not served, a page of HTML among them. */
export function pluginUiType(file: string): string | null {
  const ending = /\.([A-Za-z0-9]+)$/.exec(file)?.[1].toLowerCase()
  return (ending && TYPES[ending]) || null
}
