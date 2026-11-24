// StarBench 插件接口的类型说明。界面部分是第 1 版（`api.apiVersion === 1`）。
//
// 这个文件只给编辑器看：把它复制到你的插件文件夹里，在 JS 文件里用 JSDoc 引用，
// 就能得到补全和检查。运行时不需要它，StarBench 也不会读取它。
//
//   /** @param {import('./starbench-plugin').PluginUiApi} api */
//   export default function setup(api) { ... }
//
// 插件接口还在 0.x 阶段，之后可能调整；调整会体现在 apiVersion 上。

// ───────────────────────── 界面部分：ui/index.js ─────────────────────────

/** 插件能知道的关于当前模型的信息。不含接口地址，也不含任何密钥。 */
export interface PluginModel {
  /** 模型名，就是发给服务的那个名字。 */
  id: string
  /** 为它选的思考强度；`default` 表示没有选，由服务自己决定。 */
  effort: 'default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  provider: {
    /** 这个模型服务在设置里的 id，以及用户给它起的名字。 */
    id: string
    name: string
    /** 它用哪种接口格式。采样参数目前只对 `openai-chat` 生效。 */
    kind: 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini'
    /** 是不是用户自己运行的模型服务（地址在本机或局域网内）。 */
    local: boolean
  }
}

/**
 * 每个界面组件收到的属性：它所在的地方。都是普通的值，其中一个变了，组件就会重新绘制。
 */
export interface PluginPlaceProps {
  /** 窗口里当前的对话。 */
  conversation: {
    /** 新对话还没有发出第一条消息时是 null。 */
    id: string | null
    /** 对话的工作文件夹；还没选时是空字符串。 */
    workspace: string
    /** 模型是否正在处理这个对话。 */
    running: boolean
  }
  /** 下一条消息会发给的模型；还没有选模型时是 null。 */
  model: PluginModel | null
}

/** 每个控件都有的属性：名字，以及可选的一行说明。 */
interface Named {
  label: string
  /** 不把名字显示出来，只读给读屏软件。用在旁边已经写着名字的地方，例如紧跟在一个开关下面的滑块。 */
  labelHidden?: boolean
  hint?: string
  disabled?: boolean
}

export interface SliderProps extends Named {
  value: number
  min: number
  max: number
  /** 相邻两个取值的间隔。省略时：范围不超过 10 用 0.01，否则用 1。 */
  step?: number
  /** 拖动滑块、或在旁边的小框里输入数值并确认时调用。传入的值总在两端之间，并且落在步长上。 */
  onChange(value: number): void
}

export interface SwitchProps extends Named {
  checked: boolean
  onChange(checked: boolean): void
}

export interface FieldProps extends Named {
  value: string
  /** 每敲一个字调用一次，传入完整的文字。 */
  onChange(value: string): void
  placeholder?: string
  /** `number` 只是让输入法给出数字键盘，传回来的仍然是文字，数值由插件自己解析。 */
  type?: 'text' | 'number'
  /** 多行输入。 */
  multiline?: boolean
}

/** 一个界面组件。写法和普通的 React 函数组件一样。 */
export type PluginComponent = (props: PluginPlaceProps) => unknown

/** StarBench 交给 `setup` 的对象。 */
export interface PluginUiApi {
  /** 界面接口的版本号。用到较新的功能前可以先看一眼。 */
  apiVersion: number
  /** 这个插件的 id，也就是它的文件夹名。 */
  id: string
  /**
   * 应用自己的那份 React（19）。组件必须用它来写，不要自带一份：
   * 两份 React 混用时，组件一调用 hook 就会报错。
   * 想要完整的类型提示，在插件文件夹里 `npm i -D @types/react`。
   */
  React: typeof import('react')
  /** 应用提供的控件，外观和应用自己的一致。它们不保存值：值由你的组件保存，变化时通过 onChange 告诉你。 */
  controls: {
    Slider(props: SliderProps): unknown
    Switch(props: SwitchProps): unknown
    Field(props: FieldProps): unknown
  }
  /** 通往这个插件自己的后台部分（`index.js` 里的 `ctx.ui`）。只能和自己的后台部分通信。 */
  backend: {
    /**
     * 向后台部分提问，等它回答。后台没有注册这个名字、插件已停用、或者处理函数抛出异常时，
     * Promise 会以带有原因的 Error 拒绝。
     */
    call(name: string, payload?: unknown): Promise<unknown>
    /** 监听后台部分用 `ctx.ui.send` 发来的通知。返回取消监听的函数；插件停用时应用也会自动清掉。 */
    on(event: string, listener: (payload: unknown) => void): () => void
  }
}

/** `setup` 交回的对象。每一项都可以省略。 */
export interface PluginUiResult {
  /** 放进应用现有位置的组件。目前只有输入框上面那条栏的右端：`composer.actions`，一行高，适合一个按钮或一小段读数。 */
  slots?: {
    'composer.actions'?: PluginComponent
  }
  /**
   * 对话右侧的面板，每个插件最多一个。应用会在输入框上面那条栏的右端加一个按钮来打开它，按钮上写的是 `title`
   * （最长 16 个字）。面板收起时组件会卸载，需要保留的状态请放在组件外面，或者交给后台部分。
   */
  panel?: {
    title: string
    component: PluginComponent
  }
  /** 界面被撤掉（插件停用或重新加载）时调用。用来停掉界面自己开的东西，例如定时器、挂在 window 上的监听。 */
  dispose?(): void | Promise<void>
}

/** `ui/index.js` 要导出的函数：默认导出，或者命名为 `setup`。只调用一次。 */
export type PluginUiSetup = (api: PluginUiApi) => PluginUiResult | Promise<PluginUiResult>

// ───────────────────────── 后台部分：index.js ─────────────────────────

/** 交给模型使用的一个工具。 */
export interface ToolSpec {
  /** 模型调用时用的名字：字母、数字、`_` 和 `-`，最长 64 个字符，不能和已有工具重名。 */
  name: string
  /** 告诉模型这个工具做什么、什么时候该用。 */
  description: string
  /** 参数的 JSON Schema。省略表示没有参数。 */
  parameters?: Record<string, unknown>
  /** 调用前是否询问用户，默认 true。只读的工具才应该设为 false。 */
  needsPermission?: boolean
  /** 工具的实现。返回值会交给模型；抛出的异常会作为错误信息告诉模型。 */
  run(args: Record<string, unknown>, context: { workspace: string; signal: AbortSignal }): unknown
}

/** 一次请求要发给的模型。 */
export interface SamplingTarget {
  /** 模型服务在设置里的 id。 */
  provider: string
  kind: 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini'
  baseURL: string
  /** 这个地址是不是在本机或局域网内，也就是用户自己运行的模型服务。 */
  local: boolean
  model: string
}

/**
 * 应用和模型之间的一次往来：发出去的一个请求，和它收到的回应。
 * 一轮对话里模型每调用一次工具，就会多一次往来。记录里没有 API Key。
 */
export interface Exchange {
  /** 从应用启动起的编号。 */
  id: number
  /** 所属对话的 id，和界面组件收到的 `conversation.id` 是同一个。 */
  conversation: string
  /** 请求发出的时刻，自 1970 年起的毫秒数。 */
  at: number
  provider: {
    id: string
    name: string
    kind: 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini'
    /** 是不是用户自己运行的模型服务。 */
    local: boolean
  }
  model: string
  /**
   * 发出去的请求。`wire` 为 true 时，`body` 就是实际发给服务的请求体，一个字段都不少；
   * 为 false 时，`body` 是应用自己的表述（系统提示、消息、工具名、采样参数）：Anthropic 格式还不上报请求体，
   * 任何格式下请求还没有发出去就失败时也是这样。
   * `headers` 是应用自己加在这次请求上的请求头，没有加时没有这一项；带密钥的请求头从不在记录里。
   */
  request: { wire: boolean; body: unknown; headers?: Record<string, string> }
  /**
   * 这个请求一共发了几次。服务拒绝了请求里的某一项（流式、工具、思考摘要、Fast Mode 等），或者登录凭证过期时，
   * 应用会重发，这时大于 1，`request` 是最后一次的。Anthropic 格式不上报请求体，它的重发也还不计入。
   */
  attempts: number
  /**
   * 应用读到的回应，不是回应的原文：模型写在正文里的思考和工具调用，认出来之后分别算作思考和工具调用，
   * 工具调用之后模型又写的文字不在其中。
   */
  reply: {
    text: string
    /** 思考过程；没有时是空字符串。 */
    reasoning: string
    toolCalls: { name: string; arguments: string }[]
  }
  /** 服务说的结束原因，用它自己的词，例如 `stop`、`length`、`tool_calls`。服务没说时没有这一项。 */
  finish?: string
  /** 应用没有照这个回应行动时的原因，例如输出在工具调用中途被截断。 */
  stopped?: string
  /** 服务报告的用量，保持它自己的格式（例如 `prompt_tokens`、`completion_tokens`）。服务没有报告时没有这一项。 */
  usage?: unknown
  /** 用时，毫秒：`first` 是从发出到收到第一段回应（文字、思考或工具调用的一部分），一次取回的回应没有这一项；`total` 是到回应结束。 */
  timing: { first?: number; total: number }
  /** 文字和思考是分成多少段到达的；只有工具调用的回应是 0。很多本地服务一个 token 发一段，这时它约等于输出的 token 数。 */
  pieces: number
  /** 请求失败时的错误信息。 */
  error?: string
}

/** `apply(ctx, config)` 收到的上下文。用到哪个服务，就要在 `inject` 里写上它的名字。 */
export interface PluginContext {
  /** `inject: ['tools']`：给模型添加工具。插件停用时自动移除。 */
  tools: {
    register(spec: ToolSpec): () => void
  }
  /** `inject: ['sampling']`：对发往模型的请求有发言权的服务。两个函数都必须立刻回答，不能是异步的。 */
  sampling: {
    /** 给请求加上温度这一类参数。每次请求前都会问一次。 */
    provide(source: (target: SamplingTarget) => Record<string, unknown> | null | undefined): () => void
    /**
     * 让发给某些模型的消息以“纯对话”发出。每条消息发出时问一次，返回 `true`（必须正好是 `true`）就算。
     *
     * 纯对话里，模型拿不到任何工具（应用自带的、插件的、MCP 的、服务自己的联网搜索都没有），
     * 应用也不加自己的提示词、Skills 列表和记忆：系统提示词只有用户给这个模型服务写的那一份，没写就没有。
     * 对话里以前的工具调用改用文字转述，模型在回应里写出的工具调用不会执行，发出的消息下面会标上“纯对话”。
     * 这个函数只能把东西去掉，不能往请求里加任何东西。
     */
    plain(source: (target: SamplingTarget) => boolean): () => void
  }
  /** `inject: ['ui']`：通往这个插件自己的界面（`ui/index.js` 里的 `api.backend`）。 */
  ui: {
    /** 回答界面用 `backend.call(name, payload)` 提的问题。返回值会传回界面，所以必须是普通数据。可以是异步函数。 */
    handle(name: string, handler: (payload: unknown) => unknown): () => void
    /** 通知界面发生了一件事（界面用 `backend.on(event, listener)` 监听）。没有人在听时直接丢弃，不会排队。 */
    send(event: string, payload?: unknown): void
  }
  /**
   * `inject: ['config']`：插件自己的设置。它和应用的数据保存在一起，下次启动还在
   * （就是 plugins.json 里这个插件的 `config`，也是 `apply` 收到的第二个参数）。
   */
  config: {
    /** 现在保存着的设置。每次调用都重新读取，拿到的是一份拷贝，改它不会改到保存的内容。 */
    get(): Record<string, unknown>
    /** 用 `value` 整个替换保存的设置。必须是由普通数据组成的对象，最多 64 KB。保存后 `get()` 立刻返回新的值。 */
    set(value: Record<string, unknown>): Promise<void>
  }
  /**
   * `inject: ['trace']`：旁观应用和模型之间的每一次往来，用来查看实际发出的请求和应用读到的回应。
   * 只要有插件在旁观，应用就会为每个请求多做一份记录：请求体和回应的完整拷贝。没有插件旁观时不做这份拷贝。
   * 用量统计是应用自己也要用的：设置里的"统计用量和上下文"开着，或者有插件旁观时，应用都会向服务要
   * （流式请求里多一个 `stream_options` 字段；服务拒绝它时，应用会去掉它重发）。
   */
  trace: {
    /** 每次往来结束（或失败）后调用一次。拿到的是一份拷贝，可以随意保存和修改。返回停止旁观的函数。 */
    observe(observer: (exchange: Exchange) => void): () => void
  }
  /** 登记插件自己做的别的事情（定时器、子进程等）：传入的函数立刻执行，它返回的函数在插件停用时执行。 */
  effect(callback: () => (() => void) | void): () => void
}
