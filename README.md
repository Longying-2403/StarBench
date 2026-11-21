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

## 运行

需要 Node.js 22 或更高版本。

```sh
npm install
npm run dev
```

首次启动会弹出设置窗口，填入 API Key 即可。默认接口地址是 `https://api.deepseek.com`，默认模型是 `deepseek-flash`。

其他命令：

```sh
npm run typecheck   # 类型检查
npm run build       # 构建到 out/
npm start           # 运行构建后的版本
```

## 安全须知

- **执行命令不受工作文件夹限制。** 路径检查只约束文件工具；一旦你允许了某条命令，它就能做你的账户能做的任何事。请在允许之前读一下命令内容。
- "始终允许"按工具类型生效：允许了"执行命令"之后，本次会话里的所有命令都不再询问。
- 你的代码和对话内容会被发送到你配置的模型服务。

## 项目结构

```
src/
  main/        Electron 主进程
    agent.ts   agent 循环：请求模型 → 执行工具 → 回传结果
    tools.ts   工具的定义与实现
    store.ts   设置与会话的本地存储
    index.ts   窗口与 IPC
  preload/     渲染进程与主进程之间的桥
  renderer/    React 界面
  shared/      两端共用的类型
```

`agent.ts` 和 `tools.ts` 不依赖 Electron，可以单独在 Node 里运行和测试。

## 尚未实现

- 长对话的上下文压缩
- MCP 支持
- 多个会话同时运行
- 编辑前的 diff 预览
- 安装包（目前只能从源码运行）

## 许可证

[MIT](LICENSE)
