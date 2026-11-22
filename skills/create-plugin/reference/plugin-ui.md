# 给插件加界面

插件除了给模型添加工具，还可以在 StarBench 的窗口里显示自己的界面：输入框下面的一个按钮或一小段读数，或者对话右侧的一个面板。

先读 [编写插件](plugins.md)，这里只讲界面部分。

> 界面接口目前是第 1 版，还在 0.x 阶段，之后可能调整。

## 安全须知

- 插件的界面代码运行在应用自己的窗口里，后台部分运行在应用的主进程里，两者都拥有完整权限。**只启用你读过代码或信任来源的插件。**
- 写插件时：模型的输出、文件内容、网页内容这类外来的文字，一律当作文字显示（React 默认就是这样）。不要用 `innerHTML` 或 `dangerouslySetInnerHTML` 把它们当作 HTML 放进页面。

## 最小的例子

```
my-plugin/
  package.json
  ui/
    index.js      界面的入口
    index.css     可选：界面的样式
  index.js        可选：后台部分（工具、采样参数、回答界面的提问）
```

`package.json` 和没有界面的插件一样。只有界面、没有后台部分的插件也可以，这时不需要根目录下的 `index.js`。

`ui/index.js`：

```js
export default function setup({ React }) {
  const { useState, createElement: h } = React

  function Panel({ conversation }) {
    const [count, setCount] = useState(0)
    return h('div', null,
      h('p', { className: 'hint' }, conversation.running ? '模型正在回答…' : '模型空闲'),
      h('button', { className: 'btn', onClick: () => setCount(count + 1) }, `按了 ${count} 次`)
    )
  }

  return { panel: { title: '我的面板', component: Panel } }
}
```

- `ui/index.js` 导出一个 `setup` 函数：默认导出，或者命名为 `setup`。启用插件时 StarBench 调用它一次。
- 组件要用 `setup` 收到的那份 `React` 来写，**不要自己 `import` 一份 React**。两份 React 混用时，组件一调用 hook 就会报错。
- 这个文件不经过编译，直接在窗口里运行，所以不能写 JSX，用 `React.createElement` 描述界面。想写 JSX 见下面的"文件怎么组织"。

仓库里的 [`examples/plugins/hello-panel`](../examples/plugins/hello-panel) 是一个可以直接复制使用的完整示例：带面板、控件、样式，界面和后台互相传话。

## setup 收到什么

| 字段 | 说明 |
|---|---|
| `apiVersion` | 界面接口的版本号，目前是 `1`。 |
| `id` | 这个插件的 id，也就是它的文件夹名。 |
| `React` | 应用自己的那份 React（19）。 |
| `controls` | 应用提供的控件：`Slider`、`Switch`、`Field`，见"控件"。 |
| `backend` | 通往这个插件自己的后台部分，见"和后台部分通信"。 |

## setup 交回什么

一个对象，每一项都可以省略：

| 字段 | 说明 |
|---|---|
| `slots` | 放进应用现有位置的组件，目前只有 `'composer.actions'`。 |
| `panel` | 对话右侧的面板：`{ title, component }`。 |
| `dispose` | 界面被撤掉时调用的函数，见"开发和排错"。 |

`setup` 可以是异步函数，但要在 10 秒内完成，超时会被当作加载失败。

### 两个位置

| 位置 | 在哪里 | 适合放什么 |
|---|---|---|
| `slots['composer.actions']` | 输入框下面那一排，排在应用自己的按钮后面 | 一个按钮，或一小段读数。这一排只有一行高；放不下时插件的部分会自己换行。 |
| `panel` | 对话右侧的一栏，最宽 360 | 表单、列表、较长的内容。内容超出时面板自己滚动。 |

面板的规则：

- 每个插件最多一个面板。应用会在输入框下面加一个按钮来打开和收起它，按钮上写的是 `title`，最长 16 个字；"插件"页里这个插件的那一行也有"打开面板"。
- 标题栏和关闭按钮是应用画的，`component` 只管下面的内容。
- 一次只开一个面板，打开另一个会换掉当前的。
- 窗口窄于 1000 时，面板改为盖在对话上面。
- **面板收起时组件会卸载。** 需要保留的状态放在组件外面（`setup` 里的变量），或者交给后台部分。

## 组件收到的属性

每个组件都会收到下面这些属性。其中一个值变了，组件就会重新绘制。

| 属性 | 说明 |
|---|---|
| `conversation.id` | 当前对话的 id；新对话还没有发出第一条消息时是 `null`。 |
| `conversation.workspace` | 对话的工作文件夹；还没选时是空字符串。 |
| `conversation.running` | 模型是否正在处理这个对话。 |
| `model` | 下一条消息会发给的模型；还没有选模型时是 `null`。 |
| `model.id` | 模型名。 |
| `model.effort` | 思考强度；`default` 表示没有选，由服务自己决定。 |
| `model.provider.id` / `.name` | 模型服务在设置里的 id，以及用户给它起的名字。 |
| `model.provider.kind` | 接口格式：`openai-chat`、`openai-responses` 或 `anthropic`。 |
| `model.provider.local` | 是不是用户自己运行的模型服务（地址在本机或局域网内）。 |

接口地址和 API Key 不在其中。

## 控件

`controls` 里的三个控件外观和应用自己的一致，深色、浅色主题都适配。它们不保存值：值放在你的组件里，变化时通过 `onChange` 告诉你。

```js
const { Slider, Switch, Field } = controls

h(Slider, { label: '温度', hint: '越高越随意', value: temperature, min: 0, max: 2, step: 0.01, onChange: setTemperature })
h(Switch, { label: '采样', checked: sample, onChange: setSample })
h(Field,  { label: '停止词', placeholder: '例如 </s>', value: stop, onChange: setStop })
```

三个控件都有 `label`（必填）、`hint`（可选的一行说明）和 `disabled`。

旁边已经写着名字的地方，可以加上 `labelHidden: true`：名字不显示出来，只读给读屏软件。例如一个开关下面紧跟着调它的滑块：

```js
h(Switch, { label: '温度', hint: 'temperature', checked: on, onChange: setOn })
on && h(Slider, { label: '温度', labelHidden: true, value, min: 0, max: 2, onChange: setValue })
```

| 控件 | 其他属性 | 说明 |
|---|---|---|
| `Slider` | `value`、`min`、`max`、`step`、`onChange(number)` | 滑杆旁边有一个小框，可以直接输入数值，按回车或离开小框时生效。传给 `onChange` 的值总在两端之间，并且落在步长上。`step` 省略时：范围不超过 10 用 0.01，否则用 1。 |
| `Switch` | `checked`、`onChange(boolean)` | 开关。 |
| `Field` | `value`、`onChange(string)`、`placeholder`、`type`、`multiline` | 输入框。`multiline` 为多行。`type: 'number'` 只是提示输入数字，传回来的仍然是文字，数值由你自己解析。 |

## 和后台部分通信

界面运行在窗口里，不能直接读文件、执行命令或联网。这些事交给插件的后台部分去做，两边通过一条专用的线通信。

后台部分 `index.js`：

```js
export const inject = ['ui']

export function apply(ctx) {
  let params = { temperature: 0.7 }

  // 回答界面的提问
  ctx.ui.handle('getParams', () => params)
  ctx.ui.handle('setParams', (next) => { params = next })

  // 主动通知界面
  ctx.ui.send('changed', params)
}
```

界面 `ui/index.js`：

```js
const params = await backend.call('getParams')
await backend.call('setParams', { temperature: 0.9 })

const stop = backend.on('changed', (params) => { /* 更新界面 */ })
```

- 来回传的必须是普通数据（数字、文字、数组、对象），函数传不过去。
- `backend.call` 返回 Promise。后台的处理函数抛出异常、没有这个名字的处理函数、或者插件已经停用时，Promise 会拒绝，原因在 `err.message` 里。处理函数可以是异步的。
- `ctx.ui.send` 是通知，不排队：发出时界面没有在听，就丢掉了。
- 一个插件的界面只能和它自己的后台部分通信，听不到别的插件的通知。
- 名字用字母、数字和 `_ . : -`，最长 64 个字符。
- 插件停用时，`ctx.ui.handle` 注册的处理函数和界面这边的监听都会自动清掉。

## 样式

在 `ui/` 里放一个 `index.css`，StarBench 会在加载界面时自动启用它，停用时撤掉。

**这份样式只对你的插件自己画出来的东西生效。** 写 `button { ... }` 这样的规则只会影响你自己的按钮，不会影响应用和别的插件。想选中插件内容最外层的那个容器，用 `:scope`。

应用的样式里，下面这些名字是公开给插件用的，会保持不变：

- 颜色变量：`--bg`、`--panel`、`--raised`、`--border`、`--text`、`--muted`、`--accent`、`--accent-text`、`--danger`、`--warn`、`--ok`。它们随深色、浅色主题变化，用它们而不是写死颜色。
- 等宽字体：`--mono`。
- 类名：`btn`、`btn-primary`、`btn-small`（按钮），`hint`（说明文字），`code`（代码块）。

需要注意的地方：

- 应用内部的其他类名随时可能改，不要依赖。你自己的类名请加上前缀（例如 `hello-`），免得和应用内部的类名重名而被它的样式影响。
- 动画名（`@keyframes`）和字体名（`@font-face`）在整个窗口里是共用的，隔离不了，同样请加前缀。
- 样式表里可以用 `url(./icon.svg)` 引用 `ui/` 里的图片，路径相对于样式表。组件里要用图片时，用 `new URL('./icon.svg', import.meta.url).href` 得到它的地址。

## 文件怎么组织

- `ui/` 里的文件是 ES 模块，可以用相对路径互相 `import`（`import { x } from './parts/x.js'`）。
- **第三方依赖要自己打包进来。** 窗口里解析不了 `import 'lodash'` 这样的写法，请用打包工具把依赖并进你的文件。不要把 React 打包进去，用 `setup` 收到的那一份。
- **想写 JSX，先自己编译成普通的 JS。** 让 JSX 编译成 `React.createElement(...)`，并保证代码里的 `React` 是 `setup` 收到的那一份（例如把组件写在 `setup` 函数里面）。用 esbuild 的话：

  ```sh
  esbuild src/index.jsx --bundle --format=esm --jsx=transform --outfile=ui/index.js
  ```

- 窗口只能读到 `ui/` 文件夹里的文件，并且只限这些类型：`.js`、`.mjs`、`.css`、`.json`、`.map`、`.svg`、`.png`、`.jpg`、`.jpeg`、`.gif`、`.webp`、`.woff2`。插件根目录下的后台代码、`node_modules` 都读不到。
- 界面和后台部分都要用的代码（例如设置的默认值和检查），放在 `ui/` 里：后台部分可以 `import './ui/shared.js'`，反过来窗口读不到 `ui/` 外面的文件。
- 想要编辑器里的补全和检查，把仓库里的 [`types/starbench-plugin.d.ts`](../types/starbench-plugin.d.ts) 复制到插件文件夹，用 JSDoc 引用（示例插件里就是这样做的）：

  ```js
  /** @param {import('../starbench-plugin').PluginUiApi} api */
  export default function setup(api) { /* ... */ }
  ```

## 一个完整的例子

随应用安装的"调试面板"（[`plugins/debug`](../plugins/debug)）是用这里讲的接口写成的，没有用别的：

- [`ui/index.js`](../plugins/debug/ui/index.js)：一个面板和输入框下面的一段读数，共用一份放在组件外面的状态；改动先在界面上生效，再交给后台部分。
- [`ui/params.js`](../plugins/debug/ui/params.js)：界面和后台部分共用的设置逻辑。
- [`index.js`](../plugins/debug/index.js)：后台部分，把设置变成请求里的字段，保存设置，把每次请求的记录推给界面。

## 开发和排错

- **改了文件之后**：到侧边栏的"插件"页点这个插件的"重新加载"。界面部分会整体重新读取，包括它引用的其他文件和样式表。后台部分的入口文件也会重新读取，但入口文件所 `import` 的其他文件有改动时，仍然需要重启应用。
- **收尾**：界面里自己开的东西（定时器、挂在 `window` 上的监听）要在 `dispose` 里停掉。界面被撤掉（停用或重新加载）时会调用它；不停掉的话，旧的会和新的同时运行。组件、样式表和 `backend.on` 的监听由应用负责清理，不用自己管。

  ```js
  const timer = setInterval(refresh, 1000)
  return { panel, dispose: () => clearInterval(timer) }
  ```

- **出错了在哪里看**：界面没有加载成功或者某个组件出错时，窗口右上角会出现一条通知；"插件"页里这个插件的下面也会写明原因。
- **组件出错不会连累别处**：组件在绘制时抛出异常，只有它自己的位置显示"界面出错了"，窗口的其他部分照常工作。
- **窗口被卡住时**：带着 `--no-plugins` 启动一次，见 [编写插件](plugins.md) 里的"应用被插件卡住时"。

## 目前的限制

- 能放组件的位置只有上面两个。
- 界面只能读到上面列出的信息，只能和自己的后台部分通信。发消息、改设置这类操作还没有开放给插件。
- 窗口里有一个 `window.harness` 对象，那是应用内部自用的接口，没有任何兼容保证。不要用它。
