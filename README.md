# StarBench

一个桌面端的 AI 编程助手外壳（agent harness）：选一个工作文件夹，用对话的方式让模型读写文件、搜索代码、执行命令。可以同时配置多个模型服务：DeepSeek、OpenAI、Anthropic、xAI，以及任何兼容 OpenAI 接口格式的服务；OpenAI 的模型也可以用 ChatGPT 账号登录，使用 ChatGPT 套餐的额度。

> 早期版本，主要为作者自用而写。欢迎试用和提 issue。

## 功能

- 流式对话，可展开查看模型的思考过程
- 新对话时从用过的文件夹里选择工作文件夹，也可以新增一个
- 多个模型服务，各用各的 API Key；点击输入框右下角的模型名就能在它们的模型之间切换，同一个会话里也可以中途换模型
- 用 ChatGPT 账号登录后，可以不填 API Key，直接使用 ChatGPT 套餐里的额度（见下文"用 ChatGPT 套餐登录"）
- 可以连接自己电脑上运行的本地模型（Ollama、LM Studio、llama.cpp、vLLM 等），不需要 API Key（见下文"使用本地模型"）
- 用滑杆调整思考强度，档位随服务和模型而定：OpenAI 和 Anthropic 是低 / 中 / 高 / 超高 / 最高，xAI 到超高为止，DeepSeek 是关闭 / 低 / 高 / 最高。没有调整过，或者按"重设"回到推荐值时，不发送这个参数，由服务自己决定。每个模型各自记住自己的档位
- 滑杆左边的闪电按钮是 Fast Mode：同一个模型更快地输出，价格（或套餐用量）约为 2 倍。只有服务提供这个选项的模型才能开启，同样按模型记住
- 模型的版本名（例如 DeepSeek-V4.1-Flash）和它支持的思考档位从服务的模型列表里读取；服务不提供时显示你填写的模型名
- 六个内置工具：读取文件、写入文件、编辑文件、列出目录、搜索、执行命令
- 写文件和执行命令前需要确认，可以选择"本次会话始终允许"
- 文件操作限制在所选的工作文件夹内
- 会话历史保存在本机，在侧栏里按工作文件夹分组，可以重命名、归档和删除，也可以从会话的"⋯"菜单里给它选一个图标，方便一眼找到
- 侧栏的宽度可以拖动右边缘调整，双击恢复默认
- API Key 和 ChatGPT 登录信息使用系统凭据加密后保存（Windows DPAPI / macOS Keychain / Linux libsecret），不会进入项目目录

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

首次启动会弹出设置窗口，填入 DeepSeek 的 API Key 即可；想用别的服务，在"设置 → 模型"里添加。

### 模型服务

| 服务 | 接口类型 | 说明 |
|---|---|---|
| DeepSeek | OpenAI 兼容（Chat Completions） | 默认。用真实接口测试过 |
| xAI | OpenAI 兼容（Chat Completions） | 用真实接口测试过（grok-4.7） |
| OpenAI | Responses API | 没有用 API Key 测试过；同一个接口经 ChatGPT 套餐登录实际用过 |
| Anthropic | Messages API | 用真实接口测试过（Claude Opus 5.5、Haiku 5.5） |
| ChatGPT 套餐 | Responses API，用 ChatGPT 账号登录 | 不需要 API Key。用真实账户走通过登录和对话 |
| 本地模型 | OpenAI 兼容（Chat Completions） | Ollama、LM Studio、llama.cpp、vLLM 等，不需要 API Key。没有用真实的本地服务测试过 |
| 其他服务 | 三种类型任选 | 填接口地址即可，多数第三方服务选"OpenAI 兼容" |

"用真实接口测试过"指的是：取模型列表、带工具调用的一轮对话、各档思考强度，以及在同一个会话里换到别家再换回来。用 API Key 访问 OpenAI 这一种，只对照文档、用本地模拟的服务验证过请求和响应的处理。

### 使用本地模型

在自己电脑上运行模型的程序（Ollama、LM Studio、llama.cpp、vLLM 等）都提供 OpenAI 兼容的接口，可以直接接进来。

- 在"设置 → 模型"里点 **本地模型**，选一个常用地址（默认是 Ollama 的 `http://localhost:11434/v1`），保存即可，然后在输入框右下角选模型。地址在本机或局域网里的服务不需要填 API Key；模型跑在另一台电脑上时，把 `localhost` 换成那台电脑的地址。
- 模型要支持工具调用（function calling），例如 Ollama 里的 `qwen3.5:9b`。不支持的模型也能用，但只能聊天：服务拒绝工具时，应用会不带工具重发这条消息，在对话里说明，这个对话之后也不再向它提供工具。
- **把上下文长度调大。** 系统提示加上工具说明就要占几千 token，而 Ollama 在显存小于 24 GB 时默认只给 4K 上下文，读不了几个文件就会忘记前面的内容。在 Ollama 应用的设置里拖动上下文长度的滑杆，或者设置环境变量 `OLLAMA_CONTEXT_LENGTH`（例如 `32000`）后重启 Ollama。Ollama 对这类用途的建议是至少 64000；显存不够时，尽量给到 16K 以上。
- 思考强度的滑杆对本地服务是 关闭 / 低 / 中 / 高。Qwen 这类只能开关思考的模型，"关闭"就是不思考，其余几档都是思考；觉得慢可以关掉。
- 思考内容不管服务用 `reasoning_content` 或 `reasoning` 字段返回，还是用 `<think>` 标签写在回答开头，都会单独显示在"思考过程"里。
- 本地服务没有启动时，模型列表和对话里的报错会直接说明连不上。
- LLaMA-Factory 的接口（`llamafactory-cli api`，默认地址 `http://localhost:8000/v1`）在带工具时不能流式输出，消息还必须严格一问一答。应用发现流式请求一开始就断掉时，会改为一次取回整段回答，在对话里说明，并且每次只执行一个工具调用。这样的对话里，回答是生成完之后一次出现的。
- 服务用自己的格式返回的错误（例如 FastAPI 的 `{"detail": "..."}`）会按原话显示。
- 这部分没有在本机用真实的本地服务测试过：对照 Ollama 和 LLaMA-Factory 的文档、源码，以及一份真实的 LLaMA-Factory 报错日志实现，用本地模拟的服务（"思考"字段、不支持工具的模型、`<think>` 标签、带工具不能流式、服务没启动）验证过请求和响应的处理。

### 用 ChatGPT 套餐登录

API Key 是按量计费的，和聊天产品的订阅分开。OpenAI 为开源应用提供了一种官方的登录方式（[Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source)），登录后请求计入你 ChatGPT 套餐的额度。StarBench 用的就是这种方式，没有模拟官方客户端，也不读取网页版的登录状态。

- 在"设置 → 模型"里点 **Continue with ChatGPT**。登录和授权在你自己的浏览器里完成，应用看不到你的密码；完成后浏览器跳回本机的 `http://127.0.0.1:1455/auth/callback`（这个端口被占用时换一个），应用在那里接收结果。
- 登录得到的令牌加密保存在本机，一小时过期一次，由应用自动续期。退出登录时会通知 OpenAI 撤销；通知不到时应用会告诉你，你可以到 ChatGPT 的设置里断开 StarBench。
- 能用哪些模型由账号的套餐决定，应用从 OpenAI 返回的列表里取。
- 达到用量上限时应用会停下来，给出去 ChatGPT 用量页面的入口，不会自己改用别的付费方式。
- OpenAI 把这项功能标为预览，能不能用取决于你的账号和 OpenAI 开放的范围。应用按它的要求发请求：不保存会话（`store: false`）、流式返回、工具放在一个命名空间里。
- ChatGPT Business 的工作空间需要管理员先放行：在 [admin.openai.com](https://admin.openai.com/external-access) 的"外部访问（External access）"里，把"所有开源软件 (OSS)"的"使用 ChatGPT 套餐"设为允许。没有放行时，登录页面会显示"你所在组织限制对此开源应用的访问"（`3p_delegated_access_policy_denied`）。
- 登录、选模型和对话已经用真实的 ChatGPT 账户走通过。不常遇到的分支（令牌到期续期、达到用量上限、撤销授权等）只对照文档实现，用本地模拟的登录服务（[`test/fake-chatgpt.ts`](test/fake-chatgpt.ts)）验证过。
- 登录按钮按 OpenAI 的要求使用原文 "Continue with ChatGPT"；它还要求按钮带 ChatGPT 的图标，目前没有加。

其他家的订阅不能这样用：Anthropic 不允许第三方应用提供 Claude.ai 登录或使用订阅额度，xAI 没有公开面向第三方应用的登录方式，所以这两家只能用 API Key。

几点行为说明：

- 对话中途换模型时，之前的文字、工具调用和结果都会带过去；各家模型不公开的思考内容（加密的或带签名的）只交还给写下它的那个服务。
- Anthropic 的部分模型出于安全原因可能拒绝某个请求。对支持的模型，应用会让服务自动改由另一个模型回答（`fallbacks`，测试版功能），不成功时显示拒绝的提示。
- 模型给出的工具参数不完整时（例如输出被截断），工具不会执行，错误会交还给模型让它重来。
- Fast Mode 用的是各家自己的开关，只在官方接口上发送：OpenAI 是 `service_tier: "priority"`（API Key 和 ChatGPT 套餐登录都可以开；ChatGPT 这条通道不认 `"fast"` 这个新名字，所以统一用旧名字），Anthropic 是 `speed: "fast"`（目前是 Claude Fable 5.2、Mythos 5.2 和 Opus 5.5）。DeepSeek 和 xAI 没有这个选项。
- 不是每个模型和账户都有 Fast Mode。服务拒绝时，应用会自动按普通速度重发这条消息，把这个模型的开关关掉，并在对话里说明。Anthropic 的 Fast Mode 另有单独的限流，用完时这一次请求同样会改按普通速度发送。
- 思考档位在服务不说明模型支持哪些时按上面的默认表给出。模型不认识的档位（例如旧模型不认识"最高"）会在发消息时由服务报错。

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

调试 ChatGPT 登录时，可以让应用去找一个本地的替身服务，而不是 OpenAI：

```powershell
$env:STARBENCH_SIGNIN_TEST_SERVER = "http://127.0.0.1:9555"; npm run dev
```

这时应用不会自己打开浏览器，登录链接显示在设置窗口里，在 OpenAI 那边登录过的账号也不会被用到。[`test/fake-chatgpt.ts`](test/fake-chatgpt.ts) 里的 `startFakeChatGpt(9555)` 就是这样一个替身，测试用的也是它。

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
- **插件拥有完整权限。** 插件和应用运行在同一个进程里，能读写任意文件、执行命令，也能访问你的 API Key 和 ChatGPT 登录。只启用你信任的插件；新插件默认是停用的。
- Skill 的正文是给模型的指令，MCP 服务器是在你电脑上运行的程序（或你把数据发给的远程服务）。安装来源不明的 Skill 或 MCP 服务器之前请先看清它做什么。
- 你的代码和对话内容会被发送到你配置的模型服务。

## 项目结构

```
src/
  main/          Electron 主进程
    agent.ts     agent 循环：请求模型 → 执行工具 → 回传结果
    tools.ts     工具注册表与内置工具
    providers/   各种接口格式的适配：chat.ts、responses.ts、anthropic.ts
    chatgpt/     用 ChatGPT 登录：oauth.ts 是协议本身，login.ts 是一次登录的全过程
    models.ts    向 OpenAI 兼容的服务查询模型列表、名称和思考档位
    settings-model.ts  设置文件的结构，以及旧版设置的转换
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
- 同时登录多个 ChatGPT 账号（现在是一个，可以换）；登录按钮上的 ChatGPT 图标
- 多个会话同时运行
- 编辑前的 diff 预览
- 插件给界面添加内容（目前插件只能添加工具和 Skill）
- 插件配置的图形界面、修改代码后的热重载
- MCP 的 OAuth 登录、resources 和 prompts
- macOS 和 Linux 的安装包、代码签名、自动更新、应用图标

## 许可证

[MIT](LICENSE)
