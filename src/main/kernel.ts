// The plugin kernel: a Cordis context plus the services plugins can inject.
// Core features do not run as plugins; this file only exposes them to plugins.

import { Context, Service } from 'cordis'
import type { PluginContext } from '../../types/starbench-plugin'
import { PluginChannel } from './plugin-channel.ts'
import type { PluginHandler } from './plugin-channel.ts'
import { SamplingRegistry } from './sampling.ts'
import type { SamplingSource } from './sampling.ts'
import type { ToolRegistry, ToolSpec } from './tools.ts'
import { TraceRegistry } from './trace.ts'
import type { ExchangeObserver } from './trace.ts'

declare module 'cordis' {
  interface Context {
    tools: ToolsService
    sampling: SamplingService
    ui: UiService
    config: ConfigService
    trace: TraceService
  }
}

/**
 * `ctx.tools` as plugins see it.
 *
 * Cordis hands each plugin a view of the service whose `this.ctx` is that
 * plugin's own context, which is how a registration knows who made it.
 */
export class ToolsService extends Service {
  private registry: ToolRegistry

  constructor(ctx: Context, registry: ToolRegistry) {
    super(ctx, 'tools')
    this.registry = registry
  }

  /**
   * Registers a tool for as long as the calling plugin is enabled and returns
   * the function that removes it early. Wrapping the call in `ctx.effect` is
   * allowed but not required.
   */
  register(spec: ToolSpec): () => void {
    const owner = this.ctx
    const source = owner.fiber.name || 'plugin'
    return owner.effect(() => this.registry.register(spec, source), `tool: ${String(spec?.name)}`)
  }
}

/** `ctx.sampling` as plugins see it. */
export class SamplingService extends Service {
  private registry: SamplingRegistry

  constructor(ctx: Context, registry: SamplingRegistry) {
    super(ctx, 'sampling')
    this.registry = registry
  }

  /**
   * Has `source` asked before every model request, for as long as the calling plugin is enabled,
   * and adds the fields it returns to the request: the temperature and the like. Returns the
   * function that stops it early.
   */
  provide(source: SamplingSource): () => void {
    const owner = this.ctx
    const name = owner.fiber.name || 'plugin'
    return owner.effect(() => this.registry.register(source, name), 'sampling source')
  }
}

/**
 * `ctx.ui` as plugins see it: the line to the plugin's own interface in the page, the one in its
 * `ui/` folder. A plugin without an interface has nobody at the other end, and may use it all
 * the same.
 */
export class UiService extends Service {
  private channel: PluginChannel

  constructor(ctx: Context, channel: PluginChannel) {
    super(ctx, 'ui')
    this.channel = channel
  }

  /**
   * Answers what the plugin's interface asks under `name` (`api.backend.call(name, payload)` in
   * the page), for as long as the calling plugin is enabled. Returns the function that stops it
   * early. What `handler` returns goes back to the page, so it has to be plain data.
   */
  handle(name: string, handler: PluginHandler): () => void {
    const owner = this.ctx
    const plugin = owner.fiber.name || 'plugin'
    return owner.effect(() => this.channel.handle(plugin, name, handler), `ui handler: ${String(name)}`)
  }

  /** Tells the plugin's interface that `event` happened (`api.backend.on(event, listener)` in the page). Plain data only. */
  send(event: string, payload?: unknown): void {
    this.channel.send(this.ctx.fiber.name || 'plugin', event, payload)
  }
}

/** Where the configs of plugins are kept, as the kernel reaches it: by plugin id. */
export interface PluginConfigs {
  /** A copy of what the plugin has saved; empty when it has saved nothing. */
  get(id: string): Record<string, unknown>
  /** Saves it in place of what was there. Rejects what is not an object of plain data. */
  set(id: string, value: unknown): Promise<void>
}

/**
 * `ctx.config` as plugins see it: the plugin's own settings, kept with the app's data from one
 * start to the next (the `config` of the plugin in plugins.json, which is also what `apply` is
 * handed as its second argument).
 */
export class ConfigService extends Service {
  private configs: PluginConfigs

  constructor(ctx: Context, configs: PluginConfigs) {
    super(ctx, 'config')
    this.configs = configs
  }

  /** What the plugin has saved, as it is now: a copy, read anew at every call. */
  get(): Record<string, unknown> {
    return this.configs.get(this.ctx.fiber.name || 'plugin')
  }

  /** Saves `value` in place of what was there: an object of plain data. What `get` returns changes at once. */
  set(value: Record<string, unknown>): Promise<void> {
    return this.configs.set(this.ctx.fiber.name || 'plugin', value)
  }
}

/** `ctx.trace` as plugins see it: a look at what passes between the app and the models. */
export class TraceService extends Service {
  private registry: TraceRegistry

  constructor(ctx: Context, registry: TraceRegistry) {
    super(ctx, 'trace')
    this.registry = registry
  }

  /**
   * Has `observer` told of every request and its reply, once the reply has ended or failed, for
   * as long as the calling plugin is enabled. Returns the function that stops it early. While any
   * plugin watches, the app makes a record of each request and asks the service for its cost.
   */
  observe(observer: ExchangeObserver): () => void {
    const owner = this.ctx
    const name = owner.fiber.name || 'plugin'
    return owner.effect(() => this.registry.observe(observer, name), 'trace observer')
  }
}

/** For a kernel that was given nowhere to keep configs: they last as long as the kernel does. */
function configsInMemory(): PluginConfigs {
  const kept = new Map<string, Record<string, unknown>>()
  return {
    get: (id) => structuredClone(kept.get(id) ?? {}),
    set: async (id, value) => void kept.set(id, structuredClone(value) as Record<string, unknown>)
  }
}

/**
 * What the people who write plugins are told the services are (types/starbench-plugin.d.ts) has
 * to be what they are. Nothing here runs: a change to a service that breaks the promise makes
 * `Given` stop fitting `Promised`, and the compiler says so.
 */
type Promised = Pick<PluginContext, 'tools' | 'sampling' | 'ui' | 'config' | 'trace'>
type Given = {
  tools: Pick<ToolsService, 'register'>
  sampling: Pick<SamplingService, 'provide'>
  ui: Pick<UiService, 'handle' | 'send'>
  config: Pick<ConfigService, 'get' | 'set'>
  trace: Pick<TraceService, 'observe'>
}
type Fits<A extends B, B> = A
export type PromisedServices = Fits<Given, Promised>

export interface Kernel {
  root: Context
  /** Stops every plugin and service. */
  dispose(): Promise<void>
}

/**
 * Without a `sampling` registry the service is there all the same, and what plugins give it
 * goes nowhere; the same holds for a `channel` to their interfaces, for a `trace` nobody feeds,
 * and for `configs`, which are then kept in memory only.
 */
export async function createKernel(services: {
  tools: ToolRegistry
  sampling?: SamplingRegistry
  channel?: PluginChannel
  configs?: PluginConfigs
  trace?: TraceRegistry
}): Promise<Kernel> {
  const root = new Context()
  await root.plugin(ToolsService, services.tools)
  await root.plugin(SamplingService, services.sampling ?? new SamplingRegistry())
  await root.plugin(UiService, services.channel ?? new PluginChannel())
  await root.plugin(ConfigService, services.configs ?? configsInMemory())
  await root.plugin(TraceService, services.trace ?? new TraceRegistry())
  return { root, dispose: () => root.fiber.dispose() }
}
