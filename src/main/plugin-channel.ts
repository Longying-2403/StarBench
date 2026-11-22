// What passes between the two halves of a plugin: its code in the main process, and its
// interface in the page. The interface asks and the main-process half answers (`call`); the
// main-process half tells and the interface listens (`send`). Each plugin has a line of its own:
// what is asked under a plugin's name reaches that plugin and no other.
// Nothing in this file depends on Electron or the plugin kernel.

/** Answers one kind of question from the plugin's interface. May take its time. */
export type PluginHandler = (payload: unknown) => unknown

/** Takes what a plugin tells its interface to wherever the interface is. */
export type PluginCourier = (plugin: string, event: string, payload: unknown) => void

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/

/** A name for a question or for a piece of news: short, and made of letters, digits and a few signs. */
function checked(kind: string, name: unknown): string {
  if (typeof name !== 'string' || !NAME.test(name)) throw new Error(`Invalid ${kind} name: ${JSON.stringify(name)}`)
  return name
}

export class PluginChannel {
  private handlers = new Map<string, Map<string, PluginHandler>>()
  private courier: PluginCourier | null = null

  /**
   * Has `handler` answer the questions the interface of `plugin` asks under `name`. Returns the
   * function that takes it away again. A plugin answers each name once.
   */
  handle(plugin: string, name: string, handler: PluginHandler): () => void {
    checked('handler', name)
    if (typeof handler !== 'function') throw new Error(`The handler "${name}" must be a function`)
    let own = this.handlers.get(plugin)
    if (!own) this.handlers.set(plugin, (own = new Map()))
    if (own.has(name)) throw new Error(`The handler "${name}" is already registered`)
    own.set(name, handler)
    return () => {
      if (own.get(name) !== handler) return
      own.delete(name)
      if (own.size === 0 && this.handlers.get(plugin) === own) this.handlers.delete(plugin)
    }
  }

  /**
   * Asks the main-process half of `plugin` the question `name`. Rejects when nobody answers it:
   * the plugin is off, or has no such handler. What the handler throws is passed on as it is.
   */
  async call(plugin: string, name: string, payload: unknown): Promise<unknown> {
    const handler = this.handlers.get(plugin)?.get(name)
    if (!handler) throw new Error(`The plugin "${plugin}" has no handler named "${name}". Is it switched on?`)
    return handler(payload)
  }

  /** Has what plugins tell their interfaces carried by `courier`. There is one page, so one courier. */
  carryWith(courier: PluginCourier | null): void {
    this.courier = courier
  }

  /**
   * Tells the interface of `plugin` that `event` happened. Nothing is kept for an interface
   * that is not listening, or not there yet: this is news, not a queue.
   */
  send(plugin: string, event: string, payload: unknown): void {
    checked('event', event)
    this.courier?.(plugin, event, payload)
  }
}
