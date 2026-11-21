// Drives the real agent loop against a fake OpenAI-compatible streaming server.
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { runTurn } from '../src/main/agent.ts'
import { ToolRegistry, registerBuiltinTools } from '../src/main/tools.ts'
import type { AgentEvent, ChatMessage } from '../src/shared/types.ts'

const chunk = (delta: object): string =>
  `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta }] })}\n\n`

/** One streamed tool call, with the arguments split across chunks as real streams do. */
const call = (index: number, id: string, name: string, args: object): string[] => {
  const json = JSON.stringify(args)
  return [
    chunk({ tool_calls: [{ index, id, type: 'function', function: { name, arguments: '' } }] }),
    chunk({ tool_calls: [{ index, function: { arguments: json.slice(0, 5) } }] }),
    chunk({ tool_calls: [{ index, function: { arguments: json.slice(5) } }] })
  ]
}

/** Serves one scripted response per request and records the request bodies. */
async function fakeModel(scripts: string[][]) {
  const requests: { messages: Record<string, any>[]; tools?: { function: { name: string } }[] }[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      requests.push(JSON.parse(body))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const part of scripts[requests.length - 1] ?? []) res.write(part)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { requests, baseURL, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('a turn streams, runs tools with permission checks and feeds results back', async () => {
  const model = await fakeModel([
    [
      chunk({ role: 'assistant', reasoning_content: 'thinking ' }),
      chunk({ reasoning_content: 'hard' }),
      ...call(0, 'c1', 'write_file', { path: 'sub/a.txt', content: 'line1\r\nprice $1\r\n' }),
      ...call(1, 'c2', 'write_file', { path: '../escape.txt', content: 'x' }),
      ...call(2, 'c3', 'run_command', { command: 'echo hi' })
    ],
    [
      ...call(0, 'c4', 'edit_file', { path: 'sub/a.txt', old_string: 'line1\nprice $1', new_string: 'line1\ncost $& $2' }),
      ...call(1, 'c5', 'search', { pattern: 'cost' }),
      ...call(2, 'c6', 'read_file', { path: 'sub/a.txt' }),
      ...call(3, 'c7', 'plugin_tool', { word: 'hey' })
    ],
    [chunk({ content: 'All ' }), chunk({ content: 'done.' })]
  ])

  const tools = new ToolRegistry()
  registerBuiltinTools(tools)
  tools.register({ name: 'plugin_tool', description: 'from a plugin', run: (args) => `got ${String(args.word)}` }, 'demo')

  const workspace = await mkdtemp(path.join(os.tmpdir(), 'starbench-agent-'))
  const messages: ChatMessage[] = [{ role: 'user', content: 'go' }]
  const events: AgentEvent[] = []
  const asked: string[] = []
  await runTurn({
    apiKey: 'test',
    baseURL: model.baseURL,
    model: 'fake',
    workspace,
    messages,
    signal: new AbortController().signal,
    tools,
    alwaysAllowed: new Set(),
    emit: (e) => events.push(e),
    checkpoint: () => {},
    // "always" for file tools, deny commands
    requestPermission: async (c) => {
      asked.push(c.name)
      return c.name === 'run_command' ? 'deny' : 'always'
    }
  })
  await model.close()

  const results = Object.fromEntries(
    messages.flatMap((m) => (m.role === 'tool' ? [[m.tool_call_id, m.content]] : []))
  ) as Record<string, string>

  assert.equal(model.requests.length, 3)
  assert.equal(model.requests[0].messages[0].role, 'system')
  assert.ok(model.requests[0].tools?.some((t) => t.function.name === 'plugin_tool'), 'registered tools are offered to the model')
  assert.equal(model.requests[1].messages[2].reasoning_content, 'thinking hard', 'reasoning is passed back')
  assert.equal(model.requests[1].messages[2].tool_calls[0].function.name, 'write_file', 'tool calls are wrapped for the API')

  assert.match(results.c1, /^Wrote/)
  assert.match(results.c2, /outside the workspace/)
  assert.equal(results.c3, 'The user denied this tool call.')
  assert.match(results.c5, /sub\/a\.txt:2/)
  assert.equal(results.c6, '1\tline1\n2\tcost $& $2\n3\t', 'read_file numbers lines and strips CR')
  assert.equal(results.c7, 'got hey')
  // write_file was allowed "always", so its second call did not ask again.
  assert.deepEqual(asked, ['write_file', 'run_command', 'edit_file', 'plugin_tool'])
  assert.equal(await readFile(path.join(workspace, 'sub/a.txt'), 'utf8'), 'line1\r\ncost $& $2\r\n', 'edit keeps CRLF and literal $')

  assert.deepEqual(messages.at(-1), { role: 'assistant', content: 'All done.' })
  assert.equal(events.at(-1)?.type, 'turn_end')
  assert.equal(events.some((e) => e.type === 'error'), false)
})
