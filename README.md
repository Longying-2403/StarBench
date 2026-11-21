# StarBench

一个桌面端的 AI 编程助手外壳（agent harness）：选一个工作文件夹，用对话的方式让模型读写文件、搜索代码、执行命令。默认接入 DeepSeek，也可以换成任何兼容 OpenAI 接口格式的服务。

> 早期版本，主要为作者自用而写。欢迎试用和提 issue。

## 功能

- 流式对话，可展开查看模型的思考过程
- 六个内置工具：读取文件、写入文件、编辑文件、列出目录、搜索、执行命令
- 写文件和执行命令前需要确认，可以选择"本次会话始终允许"
- 文件操作限制在所选的工作文件夹内
- 会话历史保存在本机
- API Key 使用系统凭据加密后保存（Windows DPAPI / macOS Keychain / Linux libsecret），不会进入项目目录

## 扩展

有三种方式给模型增加能力，都在"设置"里管理：

| 方式 | 你需要写的 | 适合 | 文档 |
|---|---|---|---|
| 插件 | 一个 JavaScript 模块，注册工具函数 | 需要跑代码、访问本机的能力 | [docs/plugins.md](docs/plugins.md) |
| Skill | 一份 `SKILL.md` 说明文档 | 教模型按某种流程或规范做事 | [docs/skills.md](docs/skills.md) |
| MCP | 不用写，填配置 | 接入别人已经做好的工具 | [docs/mcp.md](docs/mcp.md) |

[`examples/`](examples) 里各有一个可以直接复制使用的示例插件和示例 Skill。

## 运行

需要 Node.js 22.18 或更高版本（测试直接运行 TypeScript 文件，这是 Node 从 22.18 起默认支持的）。

```sh
npm install
npm run dev
```

首次启动会弹出设置窗口，填入 API Key 即可。默认接口地址是 `https://api.deepseek.com`，默认模型是 `deepseek-flash`。

其他命令：

```sh
npm test            # 运行测试
npm run typecheck   # 类型检查
npm run build       # 构建到 out/
npm start           # 运行构建后的版本
```

开发时如果不想动到自己的会话和设置，可以让应用使用另一个数据目录：

```sh
# macOS / Linux
STARBENCH_USER_DATA=/path/to/a/scratch/folder npm run dev
```

```powershell
# Windows PowerShell
$env:STARBENCH_USER_DATA = "D:\scratch\starbench"; npm run dev
```

## 安全须知

- **执行命令不受工作文件夹限制。** 路径检查只约束文件工具；一旦你允许了某条命令，它就能做你的账户能做的任何事。请在允许之前读一下命令内容。
- "始终允许"按工具类型生效：允许了"执行命令"之后，本次会话里的所有命令都不再询问。
- **插件拥有完整权限。** 插件和应用运行在同一个进程里，能读写任意文件、执行命令，也能访问你的 API Key。只启用你信任的插件；新插件默认是停用的。
- Skill 的正文是给模型的指令，MCP 服务器是在你电脑上运行的程序（或你把数据发给的远程服务）。安装来源不明的 Skill 或 MCP 服务器之前请先看清它做什么。
- 你的代码和对话内容会被发送到你配置的模型服务。

## 项目结构

```
src/
  main/          Electron 主进程
    agent.ts     agent 循环：请求模型 → 执行工具 → 回传结果
    tools.ts     工具注册表与内置工具
    kernel.ts    插件内核（Cordis）以及暴露给插件的服务
    plugins.ts   插件的发现、启用与停用
    skills.ts    Skill 的发现与加载
    mcp.ts       MCP 客户端
    store.ts     设置与会话的本地存储
    index.ts     窗口与 IPC
  preload/       渲染进程与主进程之间的桥
  renderer/      React 界面
  shared/        两端共用的类型
test/            测试（node:test）
docs/            插件、Skill、MCP 的说明
examples/        示例插件与示例 Skill
```

`src/main` 里除了 `index.ts` 和 `store.ts`，其余模块都不依赖 Electron，可以单独在 Node 里运行和测试。

## 尚未实现

- 长对话的上下文压缩
- 多个会话同时运行
- 编辑前的 diff 预览
- 插件给界面添加内容（目前插件只能添加工具和 Skill）
- 插件配置的图形界面、修改代码后的热重载
- MCP 的 OAuth 登录、resources 和 prompts
- 安装包（目前只能从源码运行）

## 许可证

[MIT](LICENSE)
