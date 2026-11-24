// 调试面板的后台部分：把面板上打开的采样参数加进请求，决定消息是不是以纯对话发出，
// 记下每次请求和回应，保存设置。
// 界面在 ui/index.js，两边共用的设置逻辑在 ui/params.js。
//
// 这是随 StarBench 一起安装的内置插件，也是一个完整的例子：它只用了公开给所有插件的接口。

import { fieldsFor, normalize, plainFor } from './ui/params.js'

export const inject = ['sampling', 'ui', 'config', 'trace']

/** 留在内存里的记录条数。每一条都带着完整的请求体，对话长了会很大，所以不多留；应用关掉就没有了。 */
const KEEP = 12

/** 设置改动之后，隔多久写进磁盘（毫秒）。 */
const SAVE_AFTER_MS = 300

/**
 * @param {import('../../types/starbench-plugin').PluginContext} ctx
 */
export function apply(ctx) {
  // 现在就把用到的服务取出来：插件停用的那一刻还要用它们保存一次。
  const { config: saved, ui, sampling, trace } = ctx

  // 保存的设置可能来自旧版本，读出来先整理一遍。
  let config = normalize(saved.get())

  // 每次向模型发请求之前都会被问一次，读的是当下的设置：面板上一改，下一个请求就用新的。
  sampling.provide((target) => fieldsFor(config, target))

  // 每条消息发出时被问一次：答 true，这条消息就以纯对话发出，不带任何工具，也不带应用自己的提示词。
  // 正在进行的那一轮不受影响，面板上改了之后从下一条消息起生效。
  sampling.plain((target) => plainFor(config, target).plain)

  /** 最近的往来，旧的在前。 */
  const exchanges = []
  /** 正在旁观时，是停止旁观的函数。 */
  let stopWatching = null
  const watch = (on) => {
    if (on && !stopWatching) {
      stopWatching = trace.observe((exchange) => {
        exchanges.push(exchange)
        if (exchanges.length > KEEP) exchanges.splice(0, exchanges.length - KEEP)
        ui.send('exchange', exchange)
      })
    } else if (!on && stopWatching) {
      // 没有插件旁观时，StarBench 不做记录，也不向服务多要东西。
      stopWatching()
      stopWatching = null
    }
  }
  watch(config.record)

  // 拖动滑块时每动一步都会来一次：新设置立刻生效，写进磁盘则等手停下来之后再做。
  let pending = null
  const write = () => {
    pending = null
    saved.set(config).catch((err) => ui.send('problem', `设置没有保存下来：${err instanceof Error ? err.message : String(err)}`))
  }
  const take = (next) => {
    config = normalize(next)
    watch(config.record)
    if (pending !== null) clearTimeout(pending)
    pending = setTimeout(write, SAVE_AFTER_MS)
    return config
  }
  // 插件停用或应用退出时，把还没来得及写的设置写下去。
  ctx.effect(() => () => {
    if (pending === null) return
    clearTimeout(pending)
    write()
  })

  // 界面加载时要一次全部状态；之后设置由界面改，新的记录由这里推过去。
  ui.handle('state', () => ({ config, exchanges }))
  ui.handle('configure', (next) => take(next))
  ui.handle('reset', () => take(undefined))
  ui.handle('clear', () => {
    exchanges.length = 0
  })
}
