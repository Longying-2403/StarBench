# 编写插件

插件用来给模型添加工具，也可以在 StarBench 的窗口里加上自己的按钮和面板。一个插件就是一个文件夹，里面有一份 `package.json` 和一个 JavaScript 模块。

这一篇讲插件的后台部分：工具、采样参数、设置、查看请求和回应、生命周期。界面部分见 [给插件加界面](plugin-ui.md)。

> 插件接口还在 0.x 阶段，之后可能调整。

## 安全须知

插件和 StarBench 运行在同一个进程里，拥有完整权限：可以读写任意文件、执行命令、联网，也能访问你的 API Key。带界面的插件，界面代码还会运行在应用的窗口里。**只启用你读过代码或信任来源的插件。** 新放进来的插件默认是停用的。

## 安装

1. 点侧边栏里的"插件"，再点"打开插件文件夹"。
2. 把插件文件夹放进去。
3. 回到"插件"页点"刷新"，然后打开插件右侧的开关。

仓库里有两个可以直接复制进去的示例：[`examples/plugins/hello-tool`](../examples/plugins/hello-tool) 添加一个工具，[`examples/plugins/hello-panel`](../examples/plugins/hello-panel) 带一个面板。

### 随应用安装的插件

StarBench 自带一个插件"调试面板"（[`plugins/debug`](../plugins/debug)）：调整发给模型的采样参数，查看每次请求实际发出的内容和应用读到的回应。它在"插件"页的列表里带着"内置插件"标记，和别的插件一样默认是停用的，打开开关才运行。"插件"页下面另有一组"内置功能"（例如[记忆](memory.md)），那是应用自己的功能，不是插件。

内置插件用的就是这一篇和 [给插件加界面](plugin-ui.md) 里讲的接口，没有别的特权，所以它也是一个完整的例子，用到了后面讲的每一种服务。想改它的话，把它的文件夹复制到你自己的插件文件夹里再改：两边有同名的文件夹时，用的是你自己那一份。

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

- `inject` 列出插件需要的服务。目前有 `tools`（添加工具）、`sampling`（调整采样参数）、`config`（保存插件自己的设置）、`trace`（查看请求和回应），这几个下文都会讲到；还有 `ui`（和插件自己的界面通信，见 [给插件加界面](plugin-ui.md)）。
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

## 采样参数

插件可以给发往模型的请求加上温度、top_p 这一类参数。在 `inject` 里写上 `sampling`，然后：

```js
export const inject = ['sampling']

export function apply(ctx, config) {
  ctx.sampling.provide((target) => {
    // 只调整本机 Ollama 上的模型，其他请求不动
    if (!target.baseURL.startsWith('http://localhost:11434')) return
    return { temperature: 0.7, top_p: 0.9 }
  })
}
```

- 每次向模型发请求之前都会调用这个函数，所以改动从下一次请求起生效，不需要重启。它必须立刻返回结果，不能是异步函数。
- `target` 说明这次请求发给谁：`provider`（设置里那个服务的 id）、`kind`（接口类型）、`baseURL`、`local`（这个地址是不是在本机或局域网里，也就是用户自己运行的模型服务）和 `model`。
- 返回的对象原样并入请求，字段名要用服务认识的名字。`temperature`、`top_p`、`max_tokens`、`seed`、`stop`、`presence_penalty`、`frequency_penalty` 是 OpenAI 接口格式里有的；`top_k`、`repeat_penalty` 这类要看具体的服务，不认识的字段多数服务会忽略，少数会报错。
- 不想调整时返回 `undefined`。
- `model`、`messages`、`tools`、`tool_choice`、`stream`、`stream_options`、`n`、`reasoning_effort` 由 StarBench 自己决定，写了也不会生效。
- 目前只有"OpenAI 兼容"（Chat Completions）的服务会带上这些参数，本地模型都属于这一类。
- 函数抛出异常时这一次请求按原样发出，错误写在日志里，对话不会中断。
- 多个插件设置了同一个字段时，后启用的那个生效。

## 清理

插件停用时，它注册的工具、采样参数、对请求的旁观和回答界面提问的处理函数都会自动移除。如果插件还做了别的事情（定时器、子进程、打开的文件），把它包在 `ctx.effect` 里，返回一个撤销函数：

```js
ctx.effect(() => {
  const timer = setInterval(refresh, 60_000)
  return () => clearInterval(timer)
})
```

## 设置

每个插件有一份自己的设置，和应用的数据保存在一起，下次启动还在。在 `inject` 里写上 `config`，然后：

```js
export const inject = ['config']

export function apply(ctx, config) {
  // config 是启动这一刻保存着的设置；之后要看最新的，用 ctx.config.get()
  const current = ctx.config.get()
  // 整个替换掉保存的设置
  ctx.config.set({ ...current, temperature: 0.7 })
}
```

- `ctx.config.get()` 返回现在保存着的设置，每次调用都重新读取。拿到的是一份拷贝，改它不会改到保存的内容。没有保存过时是一个空对象。
- `ctx.config.set(value)` 用 `value` 整个替换保存的设置，返回一个在写入磁盘后完成的 Promise。`value` 必须是由普通数据组成的对象（能写成 JSON 的那种），最多 64 KB。保存之后 `get()` 立刻返回新的值，不用等写完。
- 设置变化得很频繁时（例如跟着滑块的拖动），不要每一步都保存：先在内存里用着，停下来之后再写；想保证停用时不丢，在 `ctx.effect` 的撤销函数里再保存一次。内置的调试面板就是这样做的。
- 不要把密钥放在这里：这份设置是明文保存的。

这份设置就是插件文件夹旁边 `plugins.json` 里的 `config`，也可以手动编辑（应用关着的时候）：

```json
{
  "my-plugin": { "enabled": true, "config": { "apiBase": "https://example.com" } }
}
```

要让用户在界面上改这些设置，给插件加一个面板，由面板把改动交给后台部分保存，见 [给插件加界面](plugin-ui.md)。

## 查看请求和回应

插件可以旁观 StarBench 和模型之间的每一次往来：实际发出去的请求、收到的回应、用量和用时。这是给调试用的。在 `inject` 里写上 `trace`，然后：

```js
export const inject = ['trace']

export function apply(ctx) {
  ctx.trace.observe((exchange) => {
    console.log(exchange.model, exchange.finish, exchange.usage, exchange.timing.total)
  })
}
```

- 每次往来结束或失败后调用一次。一轮对话里模型每调用一次工具，就会多一次往来。
- 对话被压缩时，请模型写摘要的那一次请求也是一次往来：它不带工具，系统提示是让模型写摘要的说明，消息只有一条，是要写成摘要的那段对话记录。压缩之后，对话的请求里就不再有被摘要代替的那些消息。
- `exchange.request.body` 是发出去的请求。`exchange.request.wire` 为 `true` 时，它就是实际发给服务的请求体，一个字段都不少；"OpenAI 兼容"（Chat Completions）和 Responses 两种格式是这样。`wire` 为 `false` 时，`body` 是应用自己的表述（系统提示、消息、工具名、采样参数）：Anthropic 格式还不上报请求体，任何格式下请求还没有发出去就失败时也是这样。`exchange.request.headers` 是应用自己加在这次请求上的请求头（目前只有发给 xAI 的 `x-grok-conv-id`），没有加时没有这一项；带密钥的请求头从不在记录里。
- `exchange.attempts` 是这个请求一共发了几次。服务拒绝了请求里的某一项（流式、工具、思考摘要、Fast Mode 等），或者登录凭证过期时，应用会重发，这时大于 1，`request` 是最后一次的。Anthropic 格式不上报请求体，它的重发也还不计入。
- `exchange.reply` 是应用读到的回应：`text`、`reasoning`（思考过程）和 `toolCalls`。它不是回应的原文：模型写在正文里的思考和工具调用，应用认出来之后分别算作思考和工具调用，工具调用之后模型又写的文字不在其中。请求失败时有 `exchange.error`。
- `exchange.finish` 是服务说的结束原因（`stop`、`length`、`tool_calls` 等），`exchange.usage` 是服务报告的用量，都保持服务自己的格式；服务没说就没有这一项。
- `exchange.timing` 是用时（毫秒）：`first` 是到收到第一段回应（文字、思考或者工具调用的一部分），只有流式的回应才有这一项，一次取回的回应没有；`total` 是到回应结束。`exchange.pieces` 是文字和思考分成多少段交到页面上的，只有工具调用的回应是 0。
- `exchange.conversation` 是所属对话的 id，`exchange.provider` 和 `exchange.model` 说明发给了谁。全部字段见 [`types/starbench-plugin.d.ts`](../types/starbench-plugin.d.ts) 里的 `Exchange`。
- 拿到的是一份拷贝，可以随意保存和修改，改不到对话本身。记录里没有 API Key。
- `observe` 返回停止旁观的函数。**只要有插件在旁观，StarBench 就会为每个请求多做一份记录**：请求体和回应的完整拷贝，对话长了会很大。所以不需要的时候就停掉。
- 用量统计是应用自己也要用的（输入框下面那一排数字）：设置里的"统计用量和上下文"开着，或者有插件旁观时，StarBench 都会向服务要，流式请求里因此多一个 `stream_options` 字段。服务明确拒绝这个字段时，StarBench 会去掉它重发一次，之后不再向这个服务发它；这样的往来 `attempts` 是 2，没有 `usage`。三种接口格式的往来现在都带 `usage`。
- 请求和回应里有用户的对话内容、读过的文件和网页。旁观到的东西怎么保存、发不发到别处，由插件负责。

## 依赖

插件可以有自己的依赖：在插件文件夹里运行 `npm install`，然后照常 `import`。

## 状态

| 状态 | 含义 |
|---|---|
| 未启用 | 开关是关的，插件代码没有运行。 |
| 运行中 | `apply` 已经执行完。 |
| 等待中 | `inject` 里有 StarBench 还没有提供的服务，等它出现后会自动启动。 |
| 出错 | 加载或启动时抛了异常，错误信息显示在插件下方。 |
| 本次未加载 | 开关是开的，但应用这次是带着 `--no-plugins` 启动的，所有插件都没有运行。 |

## 应用被插件卡住时

插件出问题时，通常只需要到侧边栏的"插件"页里把它关掉。如果应用因此打不开，或者窗口卡住什么都点不了，有两个办法：

- 带着 `--no-plugins` 启动一次，例如在"运行"（Win+R）里输入 `"StarBench.exe 的完整路径" --no-plugins`。这次启动不加载任何插件，你可以照常进入"插件"页把出问题的那个关掉，改动下次正常启动时生效。
- 或者直接把那个插件的文件夹从插件目录里移走。

## 修改插件之后

改了插件的文件后，到"插件"页点这个插件的"重新加载"：它会停掉再启动，入口文件和界面部分都重新读取。

入口文件所 `import` 的其他文件有改动时，仍然需要重启 StarBench：Node 会一直记着已经读过的模块，重新加载只换得掉入口文件本身。

## 目前的限制

- 没有统一的设置页：插件的设置要么由它自己的面板来改，要么手动编辑 `plugins.json`。
- 界面部分能放的位置和能做的事情还不多，见 [给插件加界面](plugin-ui.md) 里的"目前的限制"。
