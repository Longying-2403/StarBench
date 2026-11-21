# 编写插件

插件用来给模型添加工具。一个插件就是一个文件夹，里面有一份 `package.json` 和一个 JavaScript 模块。

> 插件接口还在 0.x 阶段，之后可能调整。

## 安全须知

插件和 StarBench 运行在同一个进程里，拥有完整权限：可以读写任意文件、执行命令、联网，也能访问你的 API Key。**只启用你读过代码或信任来源的插件。** 新放进来的插件默认是停用的。

## 安装

1. 打开"设置 → 插件 → 打开插件文件夹"。
2. 把插件文件夹放进去。
3. 回到设置页点"刷新"，然后打开插件右侧的开关。

仓库里的 [`examples/plugins/hello-tool`](../examples/plugins/hello-tool) 是一个可以直接复制进去的示例。

## 最小的插件

```
my-plugin/
  package.json
  index.js
```

`package.json`：

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "显示在设置页里的一句话说明",
  "type": "module",
  "main": "index.js"
}
```

`index.js`：

```js
export const inject = ['tools']

export function apply(ctx, config) {
  ctx.tools.register({
    name: 'word_count',
    description: 'Count the words in a piece of text.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The text to count' } },
      required: ['text']
    },
    needsPermission: false,
    run(args) {
      return String(args.text.trim().split(/\s+/).length)
    }
  })
}
```

- `inject` 列出插件需要的服务。目前只有 `tools`。
- `apply(ctx, config)` 在插件启用时调用一次。也可以把 `{ inject, apply }` 作为默认导出。
- 插件的 id 是它的文件夹名。

## 工具的字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 模型调用时用的名字。只能用字母、数字、`_` 和 `-`，最长 64 个字符，不能和已有工具重名。 |
| `description` | 是 | 告诉模型这个工具做什么、什么时候该用。模型只凭这段话决定是否调用，写清楚比写短重要。 |
| `parameters` | 否 | 参数的 JSON Schema。省略表示没有参数。 |
| `needsPermission` | 否 | 调用前是否询问用户，默认 `true`。只读的工具才应该设为 `false`。 |
| `run(args, context)` | 是 | 工具的实现，可以是异步函数。 |

`run` 的两个参数：

- `args`：模型传来的参数对象。模型可能不按 Schema 传，使用前请自行检查。
- `context.workspace`：当前会话的工作文件夹（绝对路径）。
- `context.signal`：用户点"停止"时会触发的 `AbortSignal`。耗时的操作应该监听它。

`run` 的返回值会交给模型：字符串原样使用，其他值转成 JSON，过长的结果会被截断。抛出的异常不会让应用崩溃，错误信息会作为工具结果告诉模型。

## 清理

插件停用时，它注册的工具会自动移除。如果插件还做了别的事情（定时器、子进程、打开的文件），把它包在 `ctx.effect` 里，返回一个撤销函数：

```js
ctx.effect(() => {
  const timer = setInterval(refresh, 60_000)
  return () => clearInterval(timer)
})
```

## 配置

`apply` 的第二个参数来自插件文件夹旁边的 `plugins.json`，目前需要手动编辑：

```json
{
  "my-plugin": { "enabled": true, "config": { "apiBase": "https://example.com" } }
}
```

没有配置时 `config` 是一个空对象。

## 依赖

插件可以有自己的依赖：在插件文件夹里运行 `npm install`，然后照常 `import`。

## 状态

| 状态 | 含义 |
|---|---|
| 未启用 | 开关是关的，插件代码没有运行。 |
| 运行中 | `apply` 已经执行完。 |
| 等待中 | `inject` 里有 StarBench 还没有提供的服务，等它出现后会自动启动。 |
| 出错 | 加载或启动时抛了异常，错误信息显示在插件下方。 |

## 目前的限制

- 修改插件代码后需要重启 StarBench。只关再开开关不会重新读取入口文件所导入的其他文件。
- 插件只能在主进程里运行，还不能给界面添加内容。
