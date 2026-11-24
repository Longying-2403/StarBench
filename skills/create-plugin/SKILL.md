---
name: create-plugin
description: 为 StarBench 写插件：给模型添加工具，或者在 StarBench 的窗口里加按钮和面板。用户想用插件给 StarBench 加功能时使用；改 StarBench 自己的源代码、给别的软件写插件时不要用。
---

# 为 StarBench 写插件

StarBench 的插件是一个文件夹，里面有 `package.json` 和一个 JavaScript 模块。它能给模型添加工具、调整发给模型的采样参数、保存自己的设置、旁观每一次请求和回应，还能在窗口里加界面：输入框上面那条栏里的一个按钮或一段读数，或者对话右侧的一个面板。接口是 StarBench 自己的，不要照别的软件的插件写法去猜。

## 先看该不该写插件

- 只是想让模型按某种流程或规范做事：写 Skill 就够了，用 create-skill。
- 想接入一个现成的 MCP 服务器：在"设置 → MCP"里填配置，不用写插件。
- 要运行代码、访问本机，或者要自己的界面：写插件。

## 参考资料

三份附带文件，用 `load_skill` 的 `file` 参数读，例如 `{"name": "create-plugin", "file": "reference/plugins.md"}`。每份都有一万多字节，只读用得上的那一份：

| 文件 | 什么时候读 |
|---|---|
| `reference/plugins.md` | 除了工具，还要用设置（config）、采样参数（sampling）、旁观请求（trace）、清理（effect）或者第三方依赖时 |
| `reference/plugin-ui.md` | 插件要有界面时 |
| `reference/starbench-plugin.d.ts` | 要确认某个字段的确切名字和类型时；也可以原样写进插件文件夹，给编辑器做补全 |

它们是 StarBench 仓库里文档的副本。里面提到的仓库路径（`examples/`、`plugins/debug`、`types/`）在这里都没有，类型说明就是 `reference/starbench-plugin.d.ts`。

## 步骤

1. **问清楚**：插件做什么；要不要给模型用的工具、要不要界面、要不要保存设置；工具会不会改文件、执行命令或者联网。用户已经说了的不要再问，缺的一次问完。
2. **起 id**：插件的 id 就是文件夹名，用英文小写字母、数字和 `-`，例如 `fullwidth-punct`。
3. **写文件**：只要工具的插件，照下面"最小的插件"写；要用别的服务或者要界面，先读对应的参考资料。
4. **检查语法**：用户电脑上有 Node 时（`node --version` 有输出），对每个 `.js` 文件运行 `node --check <文件>`。执行命令要用户同意；没有 Node 就跳过。
5. **告诉用户怎么装**：侧边栏 → 插件 → 打开插件文件夹，把插件文件夹放进去，回到"插件"页点"刷新"，再打开它的开关。同时用一两句话说明它会做什么、会碰哪些东西（文件、命令、网络），由用户决定要不要启用。

## 最小的插件

```
<id>/
  package.json
  index.js
```

`package.json` 里的 `name` 是"插件"页上显示的名字，可以用中文：

```json
{
  "name": "字数统计",
  "version": "0.1.0",
  "description": "在插件页显示的一句话说明",
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
      if (typeof args.text !== 'string') throw new Error('Missing string argument "text"')
      return String(args.text.trim().split(/\s+/).filter(Boolean).length)
    }
  })
}
```

- `inject` 列出要用的服务：`tools`、`sampling`、`config`、`trace`、`ui`。用到哪个，就要写上哪个。
- `apply(ctx, config)` 在插件启用时调用一次；`config` 是这个插件保存着的设置。也可以默认导出 `{ inject, apply }`。
- 插件停用时，它注册的工具、采样参数、旁观和回答界面提问的函数都会自动撤掉。自己开的定时器、子进程，用 `ctx.effect(() => { …; return () => { /* 撤销 */ } })` 登记。
- 只有界面、没有后台代码的插件，不写 `main`，也不要 `index.js`。

## 工具

- `name`：模型调用时用的名字，只用字母、数字、`_`、`-`，最长 64 个字符，不能和已有的工具重名，包括内置的 `read_file`、`write_file`、`edit_file`、`list_dir`、`search`、`run_command`、`load_skill`。
- `description`：做什么、什么时候该用。模型只凭这段话决定要不要调用，写清楚比写短重要。
- `parameters`：参数的 JSON Schema，没有参数就省略。
- `needsPermission`：默认 `true`，每次调用前问用户。只有只读、没有副作用的工具才设为 `false`。用户在确认框里选了这个会话不再询问之后，这个工具在这个会话里之后的调用都不会再问。
- `run(args, { workspace, signal })`：可以是异步函数。`args` 是模型给的，可能不合 Schema，用之前自己检查。`workspace` 是当前对话的工作文件夹（绝对路径）；StarBench 不会替插件把文件操作限制在里面，接受路径参数的工具要自己检查路径没有跑到外面去：比较之前先用 `fs.realpath` 解析出真实路径（要新建的文件，就解析它所在的文件夹），因为工作文件夹里的符号链接和目录联接可能指向外面。耗时的操作要听 `signal`（用户点了"停止"）。返回字符串原样交给模型，别的值转成 JSON，太长会被截断；抛出的异常会作为错误信息交给模型。

## 安全

- 插件运行在 StarBench 的主进程里，拥有完整的 Node 权限：能读写任意文件、执行命令、联网。只写用户要的功能，不要顺手加联网、上报或者读取别处文件的代码。
- 会改东西的工具保持 `needsPermission: true`。
- 插件的设置是明文保存的，不要把密钥放进 `config`。
- 界面里显示模型输出、文件或网页内容时，一律当作文字，不要用 `innerHTML` 或 `dangerouslySetInnerHTML`。

## 写在哪里

- 模型的文件工具只能写工作文件夹里的文件：在工作文件夹里新建 `<id>/`，同名文件夹已经存在时先问用户。工作文件夹是一个项目时，提醒用户装好之后把它从项目里删掉。
- 工作文件夹就是插件文件夹本身时（用户这样说，或者路径以 `StarBench\plugins`、`StarBench/plugins` 结尾），直接写在里面，用户点"刷新"后就能启用。

## 改了之后

- 到"插件"页点这个插件的"重新加载"：入口文件和界面部分会重新读取。入口文件 `import` 的其他文件改了，要重启 StarBench。
- 插件出错时，"插件"页里它的下面会写明原因。应用被插件卡住、打不开时，带着 `--no-plugins` 启动一次，再到"插件"页把它关掉。
