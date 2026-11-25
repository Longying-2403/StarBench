# 参与 StarBench

StarBench 还在 Beta 阶段，主要由作者自己使用和维护。欢迎提 issue 和建议。想改代码的话，请先开一个 issue 说明想改什么、为什么改，谈好了再提 PR，免得白做。

## 提 issue

- 新建 issue 时可以选两个表单：问题报告和功能建议。
- 提之前先看一眼 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)，问题可能已经在里面了。
- 安全问题请不要开公开的 issue，按 [SECURITY.md](SECURITY.md) 用私密漏洞报告。
- 贴日志和截图之前，先去掉 API Key、登录令牌，以及不想公开的路径和内容。

## 准备环境

需要 Node.js 22.18 或更高版本（测试直接运行 TypeScript 文件）。

```
npm install
npm run dev
```

开发时不想动到自己的会话和设置，可以让应用换一个数据目录（`STARBENCH_USER_DATA`），见 README 的[开发](README.md#开发)一节。

## 提交 PR 之前

- `npm run typecheck` 和 `npm test` 都要通过。CI 会在 Windows 上跑类型检查、测试和构建。
- 测试如果读仓库里的文件，要同时接受 `\n` 和 `\r\n` 两种换行：CI 检出的文件是 CRLF。
- 测试里起的替身服务器，要在 `after` 或 `t.after` 里关掉。写在测试末尾的话，断言一失败它就关不掉，`node --test` 会一直挂着，不报告失败。
- 测试里需要像密钥的字符串时，拆成两段，运行时再拼起来。GitHub 的推送保护会拦下完整格式的密钥，假的也一样。
- 用户看得到的变化，写进 README 里对应的一节。`CHANGELOG.md` 和修订号（`0.1.0-r.N`）由作者在定下修订号时写，PR 里不用改。
- 说明你是怎么验证的：改了界面的附一张截图；改了和模型服务打交道的部分，写明实际用哪家服务、哪个模型试过，只在模拟服务上试过的也写明。

## 写代码

- 界面文字和文档用简体中文。
- `src/main` 里除了 `index.ts` 和 `store.ts`，其他模块都不依赖 Electron，可以单独在 Node 里运行和测试；新写的模块也尽量这样。
- 插件接口的类型在 `types/`，说明在 `docs/plugins.md` 和 `docs/plugin-ui.md`。改接口时一起改，`examples/` 里的示例也要还能用。

## 许可证

提交的代码按本项目的 [MIT 许可证](LICENSE)发布。
