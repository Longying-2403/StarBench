// 示例插件：注册一个工具。把整个文件夹复制到 StarBench 的插件目录，然后在设置里启用。

/** 这个插件需要的服务。`tools` 由 StarBench 提供。 */
export const inject = ['tools']

/**
 * 插件入口，启用时调用一次。
 * @param {any} ctx - 插件上下文
 * @param {{ timeZone?: string }} config - plugins.json 里这个插件的 config
 */
export function apply(ctx, config) {
  // 停用插件时，这里注册的工具会自动移除。
  ctx.tools.register({
    name: 'current_time',
    description: 'Get the current date and time. Use it whenever the user asks about the time or today\'s date.',
    parameters: {
      type: 'object',
      properties: {
        timeZone: { type: 'string', description: 'IANA time zone such as "Asia/Shanghai". Defaults to the system time zone.' }
      }
    },
    // 只读工具可以关掉确认；会改文件或联网的工具请保持默认（每次询问）。
    needsPermission: false,
    run(args) {
      const timeZone = typeof args.timeZone === 'string' && args.timeZone ? args.timeZone : config.timeZone
      // 时区写错时 Intl 会抛出异常，StarBench 会把错误信息原样交给模型。
      return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full', timeStyle: 'long', timeZone }).format(new Date())
    }
  })
}
