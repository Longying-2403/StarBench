# StarBench

一个桌面端的 AI 编程助手外壳（agent harness）：选一个工作文件夹，用对话的方式让模型读写文件、搜索代码、执行命令。默认接入 DeepSeek，也可以换成任何兼容 OpenAI 接口格式的服务。

> 早期版本，主要为作者自用而写。欢迎试用和提 issue。

## 功能

- 流式对话，可展开查看模型的思考过程
- 新对话时从用过的文件夹里选择工作文件夹，也可以新增一个
- 点击输入框右下角的模型名，用滑杆调整思考强度：关闭 / 低 / 高 / 最高，对应接口的 `reasoning_effort` 参数。没有调整过，或者按"重设"回到推荐值时，不发送这个参数，由服务自己决定，所以不认识这个参数的服务也能用
- 模型的版本名（例如 DeepSeek-V4.1-Flash）和它支持的思考档位从服务的模型列表里读取；服务不提供时显示你填写的模型名
- 六个内置工具：读取文件、写入文件、编辑文件、列出目录、搜索、执行命令
- 写文件和执行命令前需要确认，可以选择"本次会话始终允许"
- 文件操作限制在所选的工作文件夹内
- 会话历史保存在本机，在侧栏里按工作文件夹分组，可以重命名、归档和删除
- API Key 使用系统凭据加密后保存（Windows DPAPI / macOS Keychain / Linux libsecret），不会进入项目目录

## 扩展

有三种方式给模型增加能力，都在"设置"里管理：

| 方式 | 你需要写的 | 适合 | 文档 |
|---|---|---|---|
| 插件 | 一个 JavaScript 模块，注册工具函数 | 需要跑代码、访问本机的能力 | [docs/plugins.md](docs/plugins.md) |
| Skill | 一份 `SKILL.md` 说明文档 | 教模型按某种流程或规范做事 | [docs/skills.md](docs/skills.md) |
| MCP | 不用写，填配置 | 接入别人已经做好的工具 | [docs/mcp.md](docs/mcp.md) |

[`examples/`](examples) 里各有一个可以直接复制使用的示例插件和示例 Skill。

## 从源码运行

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

同一个数据目录同时只能运行一个 StarBench，再启动一次只会把已经打开的窗口调到前面。所以如果安装版正开着，`npm run dev` 会立刻退出；像上面那样换一个数据目录，两者就能同时运行。

## 打包成独立应用

```sh
npm run dist
```

会在 `dist/` 里生成（以 Windows 为例）：

| 文件 | 说明 |
|---|---|
| `StarBench-<版本>-win-x64-setup.exe` | 安装包。只为当前用户安装，不需要管理员权限，可以选择安装位置 |
| `StarBench-<版本>-win-x64.zip` | 免安装版。解压后运行里面的 `StarBench.exe` |

打包好的应用不需要 Node.js 就能运行。第一次打包时 electron-builder 会联网下载打包工具。

几点说明：

- **安装包没有代码签名。** 从网上下载后第一次运行，Windows 会提示"Windows 已保护你的电脑"，需要点"更多信息 → 仍要运行"。
- 安装版、免安装版和从源码运行的版本共用同一个数据目录（Windows 上是 `%APPDATA%\StarBench`），会话、设置、插件和 Skill 是互通的。卸载不会删除这个目录。
- 用 `npx`、`uvx` 启动的本地 MCP 服务器仍然需要电脑上装有 Node.js 或 Python，应用不会自带。
- 目前只在 Windows 上打包并验证过。macOS 和 Linux 需要在各自的系统上运行同一条命令，尚未测试。

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
    models.ts    向模型服务查询模型的名称和思考档位
    workspaces.ts  用过的工作文件夹列表
    kernel.ts    插件内核（Cordis）以及暴露给插件的服务
    plugins.ts   插件的发现、启用与停用
    skills.ts    Skill 的发现与加载
    mcp.ts       MCP 客户端
    store.ts     设置与会话的本地存储
    index.ts     窗口与 IPC
  preload/       渲染进程与主进程之间的桥
  renderer/      React 界面
  shared/        两端共用的类型和文件夹路径的处理
test/            测试（node:test）
docs/            插件、Skill、MCP 的说明
examples/        示例插件与示例 Skill
electron-builder.yml   打包配置
```

`src/main` 里除了 `index.ts` 和 `store.ts`，其余模块都不依赖 Electron，可以单独在 Node 里运行和测试。

## 尚未实现

- 长对话的上下文压缩
- 多个会话同时运行
- 编辑前的 diff 预览
- 插件给界面添加内容（目前插件只能添加工具和 Skill）
- 插件配置的图形界面、修改代码后的热重载
- MCP 的 OAuth 登录、resources 和 prompts
- macOS 和 Linux 的安装包、代码签名、自动更新、应用图标

## 许可证

[MIT](LICENSE)
