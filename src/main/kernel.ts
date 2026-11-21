// The plugin kernel: a Cordis context plus the services plugins can inject.
// Core features do not run as plugins; this file only exposes them to plugins.

import { Context, Service } from 'cordis'
import type { ToolRegistry, ToolSpec } from './tools.ts'

declare module 'cordis' {
  interface Context {
    tools: ToolsService
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

export interface Kernel {
  root: Context
  /** Stops every plugin and service. */
  dispose(): Promise<void>
}

export async function createKernel(services: { tools: ToolRegistry }): Promise<Kernel> {
  const root = new Context()
  await root.plugin(ToolsService, services.tools)
  return { root, dispose: () => root.fiber.dispose() }
}
