// How a conversation comes by its name: what the model is asked, what is made of its answer,
// and the request itself, against a fake OpenAI-compatible server.
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { askAside } from '../src/main/agent.ts'
import type { Connection } from '../src/main/providers/index.ts'
import { TITLE_MAX, cleanTitle, titleEffort, titlePrompt, titleRecord } from '../src/main/title.ts'
import type { StoredMessage } from '../src/shared/types.ts'

test('the model is told to name the subject, shortly, in the language of the person', () => {
  const plain = titlePrompt()
  assert.match(plain, /Name the subject, not the request/)
  assert.match(plain, /At most 6 words; in Chinese, Japanese or Korean at most 12 characters/)
  assert.match(plain, /do not call tools/)
  assert.match(plain, /in the language the user writes in\.$/)
  // The example the feature was asked for with.
  assert.match(plain, /帮我查找GitHub上的Windows-MCP插件/)
  assert.match(titlePrompt('Chinese'), /Write the title in Chinese; names stay as they are\.$/)
})

test('the model is shown the first message and the beginning of the first answer that has words', () => {
  const messages: StoredMessage[] = [
    { role: 'user', content: '  帮我查找GitHub上的Windows-MCP插件  ' },
    // A step that only called a tool says nothing to name the conversation by.
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'search', arguments: '{}' }] },
    { role: 'tool', tool_call_id: 'c1', content: 'found' },
    { role: 'assistant', content: 'Windows-MCP 是一个让模型操作 Windows 桌面的 MCP 服务器。' },
    { role: 'user', content: '再看看它的更新记录' },
    { role: 'assistant', content: '最近一次更新是……' }
  ]
  assert.equal(
    titleRecord(messages),
    '<user>\n帮我查找GitHub上的Windows-MCP插件\n</user>\n\n<assistant>\nWindows-MCP 是一个让模型操作 Windows 桌面的 MCP 服务器。\n</assistant>\n\nWrite the title of this conversation now.'
  )

  // Without an answer yet, the message alone; with files, their names; long texts are cut.
  assert.equal(titleRecord([{ role: 'user', content: '你好' }]), '<user>\n你好\n</user>\n\nWrite the title of this conversation now.')
  const withFiles = titleRecord([
    {
      role: 'user',
      content: '',
      attachments: [
        { kind: 'image', name: 'shot.png', type: 'image/png', data: 'AAAA' },
        { kind: 'text', name: 'notes.md', text: 'a secret' }
      ]
    }
  ])
  assert.equal(withFiles, '<user>\n[attached: shot.png, notes.md]\n</user>\n\nWrite the title of this conversation now.', 'the names of the files, and nothing of what is in them')
  const long = titleRecord([
    { role: 'user', content: 'q'.repeat(5000) },
    { role: 'assistant', content: 'a'.repeat(5000) }
  ])
  assert.ok(long && long.length < 2500, String(long?.length))
  assert.match(long ?? '', /q{1500} …\n<\/user>/)
  assert.match(long ?? '', /a{800} …\n<\/assistant>/)

  // Nothing said, nothing to name by.
  assert.equal(titleRecord([]), undefined)
  assert.equal(titleRecord([{ role: 'user', content: '   ' }]), undefined)
})

test('what the model wrote is taken as a title only where it is one', () => {
  assert.equal(cleanTitle('Windows-MCP 总览'), 'Windows-MCP 总览')
  // What it was told not to put around the title is taken off.
  assert.equal(cleanTitle('"Windows-MCP overview"'), 'Windows-MCP overview')
  assert.equal(cleanTitle('「Windows-MCP 总览」'), 'Windows-MCP 总览')
  assert.equal(cleanTitle('《Windows-MCP 总览》。'), 'Windows-MCP 总览')
  assert.equal(cleanTitle('**Windows-MCP 总览**'), 'Windows-MCP 总览')
  assert.equal(cleanTitle('# Windows-MCP 总览\n'), 'Windows-MCP 总览')
  assert.equal(cleanTitle('标题：Windows-MCP 总览'), 'Windows-MCP 总览')
  assert.equal(cleanTitle('Title: “Windows-MCP overview.”'), 'Windows-MCP overview')
  assert.equal(cleanTitle('  Windows-MCP   overview.  '), 'Windows-MCP overview')
  // The first line that says something, and no thinking that came with the answer.
  assert.equal(cleanTitle('\n\nWindows-MCP 总览\n\n（根据第一条消息）'), 'Windows-MCP 总览')
  assert.equal(cleanTitle('<think>The user wants a title.</think>\nWindows-MCP 总览'), 'Windows-MCP 总览')
  assert.equal(cleanTitle('The user wants a title.\n</think>\n\nWindows-MCP 总览'), 'Windows-MCP 总览', 'thinking without the tag that opens it')
  // What belongs to the title stays.
  assert.equal(cleanTitle('Node.js 版本管理'), 'Node.js 版本管理')
  assert.equal(cleanTitle('useEffect (React)'), 'useEffect (React)')
  assert.equal(cleanTitle('"npm" and "pnpm"'), '"npm" and "pnpm"', 'two things in quotation marks are not one')
  assert.equal(cleanTitle('`git rebase`'), 'git rebase')
  // No title: nothing, or an answer instead of a name.
  assert.equal(cleanTitle(''), undefined)
  assert.equal(cleanTitle('  \n '), undefined)
  assert.equal(cleanTitle('""'), undefined)
  assert.equal(cleanTitle('Windows-MCP 是一个开源项目，它让模型可以通过 MCP 协议操作 Windows 桌面，下面是它的主要功能和安装方法。'), undefined)
  assert.equal(cleanTitle('字'.repeat(TITLE_MAX)), '字'.repeat(TITLE_MAX), 'counted in characters as they are read')
  assert.equal(cleanTitle('字'.repeat(TITLE_MAX + 1)), undefined)
})

test('a title is asked for with as little thinking as the service lets a model do', () => {
  const at = (baseURL: string, reasoningEffort: Connection['reasoningEffort'], kind: Connection['kind'] = 'openai-chat') => titleEffort({ baseURL, kind, reasoningEffort })
  assert.equal(at('https://api.deepseek.com', 'high'), 'none', 'thinking can be switched off there')
  assert.equal(at('https://api.deepseek.com', 'none'), 'none')
  assert.equal(at('https://api.openai.com/v1', 'xhigh', 'openai-responses'), 'low')
  assert.equal(at('https://api.anthropic.com', 'max', 'anthropic'), 'low')
  assert.equal(at('https://api.x.ai/v1', 'xhigh'), 'low')
  assert.equal(at('http://localhost:11434/v1', 'medium'), 'none')
  // "Minimal" is not known to every model of the service that has it, so it is not reached for; whoever is on it stays.
  assert.equal(at('https://generativelanguage.googleapis.com/v1beta', 'high', 'gemini'), 'low')
  assert.equal(at('https://generativelanguage.googleapis.com/v1beta', 'minimal', 'gemini'), 'minimal')
  assert.equal(at('https://generativelanguage.googleapis.com/v1beta', 'low', 'gemini'), 'low')
  // Nothing chosen, nothing sent; and a level the service is not known by is left as the person set it.
  assert.equal(at('https://api.openai.com/v1', 'default', 'openai-responses'), 'default')
  assert.equal(at('https://api.deepseek.com', 'medium'), 'medium')
  assert.equal(at('https://api.openai.com/v1', 'none', 'openai-responses'), 'none')
})

/** Serves one scripted answer per request, and records what was asked. */
async function fakeModel(answers: (string | { status: number; message: string })[]) {
  const requests: { messages: { role: string; content: unknown }[]; tools?: unknown[]; stream?: boolean }[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      requests.push(JSON.parse(body))
      const answer = answers[requests.length - 1] ?? ''
      if (typeof answer !== 'string') {
        res.writeHead(answer.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: answer.message, type: 'invalid_request_error' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const piece of answer.match(/[\s\S]{1,5}/g) ?? []) {
        res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: piece } }] })}\n\n`)
      }
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { requests, baseURL, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('the name is asked for in a request of its own: the instructions, what was said, and no tools', async (t) => {
  // Refused with a 400: a 500 would be tried again by the adapter, and the second try answered.
  const model = await fakeModel(['「Windows-MCP 总览」。', { status: 400, message: 'the model is not loaded' }])
  t.after(() => model.close())
  const connection: Connection = { provider: 'test', kind: 'openai-chat', apiKey: 'test', baseURL: model.baseURL, model: 'fake', reasoningEffort: 'default', fast: true, webSearch: true }
  const record = titleRecord([
    { role: 'user', content: '帮我查找GitHub上的Windows-MCP插件' },
    { role: 'assistant', content: 'Windows-MCP 是……' }
  ])
  assert.ok(record)

  const written = await askAside({ connection, system: titlePrompt('Chinese'), text: record, signal: new AbortController().signal })
  assert.equal(cleanTitle(written), 'Windows-MCP 总览')
  const [asked] = model.requests
  assert.deepEqual(
    asked.messages.map((message) => message.role),
    ['system', 'user']
  )
  assert.equal(asked.messages[0].content, titlePrompt('Chinese'))
  assert.equal(asked.messages[1].content, record)
  assert.ok(asked.tools === undefined || asked.tools.length === 0, 'no tools are offered')

  // A service that refuses is an error to whoever asked, who then leaves the name as it is.
  await assert.rejects(askAside({ connection, system: titlePrompt(), text: record, signal: new AbortController().signal }), /not loaded/)
})
