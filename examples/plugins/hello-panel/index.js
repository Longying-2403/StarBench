// 示例插件的后台部分：回答界面提的问题，并主动通知界面。
// 把整个文件夹复制到 StarBench 的插件目录，然后在侧边栏的"插件"页里启用。界面部分在 ui/index.js。

/** 这个插件需要的服务。`ui` 是通往它自己界面的那条线。 */
export const inject = ['ui']

/**
 * 插件入口，启用时调用一次。
 * @param {import('./starbench-plugin').PluginContext} ctx
 */
export function apply(ctx) {
  let greeted = 0

  // 界面用 backend.call('greet', {...}) 提问，这里回答。
  // 返回值会原样传回界面，所以必须是普通数据；抛出的异常也会把原因带回界面。
  ctx.ui.handle('greet', (payload) => {
    const { name, loud, times } = /** @type {{ name?: string, loud?: boolean, times?: number }} */ (payload ?? {})
    const once = `你好，${typeof name === 'string' && name.trim() ? name.trim() : '朋友'}${loud ? '！' : '。'}`
    const text = once.repeat(Math.min(5, Math.max(1, Number(times) || 1)))

    // 后台也可以主动告诉界面一件事。界面用 backend.on('greeted', ...) 监听。
    greeted++
    ctx.ui.send('greeted', { count: greeted })

    return { text }
  })

  // 停用插件时，这里注册的东西会自动撤掉，不用自己清理。
}
