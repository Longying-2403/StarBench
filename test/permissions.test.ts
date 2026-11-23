// What a conversation's permission mode lets a model do without asking: the rule itself, how the
// tools are told apart for it, and the agent loop going by it against a fake streaming server.
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { runTurn } from '../src/main/agent.ts'
import { isErrorResult } from '../src/main/providers/history.ts'
import type { Connection } from '../src/main/providers/index.ts'
import { ToolRegistry, registerBuiltinTools } from '../src/main/tools.ts'
import { DEFAULT_PERMISSION_MODE, PERMISSION_MODES, VIEW_ONLY_RESULT, isPermissionMode, rulingFor } from '../src/shared/permissions.ts'
import type { PermissionMode } from '../src/shared/permissions.ts'
import type { ChatMessage, PermissionDecision } from '../src/shared/types.ts'

test('a mode says of each kind of tool whether it runs, is asked about, or is not run', () => {
  // What only reads runs in every mode.
  for (const mode of PERMISSION_MODES) assert.equal(rulingFor(mode, 'read'), 'run')
  assert.deepEqual([rulingFor('view', 'edit'), rulingFor('view', 'other')], ['refuse', 'refuse'])
  assert.deepEqual([rulingFor('ask', 'edit'), rulingFor('ask', 'other')], ['ask', 'ask'])
  // Files of the workspace are changed without asking; a command is still asked about.
  assert.deepEqual([rulingFor('edit', 'edit'), rulingFor('edit', 'other')], ['run', 'ask'])
  assert.deepEqual([rulingFor('full', 'edit'), rulingFor('full', 'other')], ['run', 'run'])
  assert.equal(DEFAULT_PERMISSION_MODE, 'ask')
  assert.ok(isPermissionMode('full'))
  for (const not of ['', 'FULL', 'bypass', null, undefined, 3, {}]) assert.equal(isPermissionMode(not), false)
})

test('the registry tells the tools apart: reading, editing files of the workspace, and everything else', () => {
  const tools = new ToolRegistry()
  registerBuiltinTools(tools)
  tools.register({ name: 'plugin_asks', description: 'from a plugin', run: () => 'x' }, 'demo')
  tools.register({ name: 'plugin_reads', description: 'from a plugin', needsPermission: false, run: () => 'x' }, 'demo')
  tools.register({ name: 'mcp__files__write_file', description: 'from a server', run: () => 'x' }, 'mcp:files')
  for (const name of ['read_file', 'list_dir', 'search', 'plugin_reads']) assert.equal(tools.accessOf(name), 'read', name)
  for (const name of ['write_file', 'edit_file']) assert.equal(tools.accessOf(name), 'edit', name)
  // A command is not held to the workspace; a tool from outside the app is not taken at its word, whatever it is called.
  for (const name of ['run_command', 'plugin_asks', 'mcp__files__write_file']) assert.equal(tools.accessOf(name), 'other', name)
  // Running a tool that is not there only reports the error to the model.
  assert.equal(tools.accessOf('no_such_tool'), 'read')
})

test('a call that was not run for the mode counts as a failed one where failures are marked', () => {
  assert.ok(isErrorResult(VIEW_ONLY_RESULT))
})

const chunk = (delta: object): string => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta }] })}\n\n`
const call = (index: number, id: string, name: string, args: object): string =>
  chunk({ tool_calls: [{ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })

/** Serves one scripted stream per request and records the request bodies. */
async function fakeModel(scripts: string[][]) {
  const requests: { messages: Record<string, any>[] }[] = []
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

/** One step with a write, an edit, a read and a command; then the answer. */
const STEPS = [
  [
    call(0, 'c1', 'write_file', { path: 'a.txt', content: 'one' }),
    call(1, 'c2', 'edit_file', { path: 'a.txt', old_string: 'one', new_string: 'two' }),
    call(2, 'c3', 'read_file', { path: 'a.txt' }),
    call(3, 'c4', 'run_command', { command: 'echo hi' })
  ],
  [chunk({ content: 'done' })]
]

/** Runs that turn in a mode, with every question answered by `answer`, and tells what was asked and what came of each call. */
async function turnIn(mode: PermissionMode | (() => PermissionMode) | undefined, answer: PermissionDecision = 'allow') {
  const model = await fakeModel(STEPS)
  const tools = new ToolRegistry()
  registerBuiltinTools(tools)
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'starbench-mode-'))
  const messages: ChatMessage[] = [{ role: 'user', content: 'go' }]
  const asked: string[] = []
  const connection: Connection = { provider: 'test', kind: 'openai-chat', apiKey: 'test', baseURL: model.baseURL, model: 'fake', reasoningEffort: 'default' }
  try {
    await runTurn({
      connection,
      workspace,
      messages,
      signal: new AbortController().signal,
      tools,
      alwaysAllowed: new Set(),
      ...(mode === undefined ? {} : { permissionMode: typeof mode === 'function' ? mode : () => mode }),
      emit: () => {},
      checkpoint: () => {},
      requestPermission: async (asking) => {
        asked.push(asking.name)
        return answer
      }
    })
  } finally {
    await model.close()
  }
  const results = Object.fromEntries(messages.flatMap((m) => (m.role === 'tool' ? [[m.tool_call_id, m.content]] : [])))
  const file = await readFile(path.join(workspace, 'a.txt'), 'utf8').catch(() => null)
  return { asked, results, file }
}

test('view-only: reading runs, and nothing else is run or asked about', async () => {
  const { asked, results, file } = await turnIn('view')
  assert.deepEqual(asked, [])
  assert.equal(results.c1, VIEW_ONLY_RESULT)
  assert.equal(results.c2, VIEW_ONLY_RESULT)
  assert.equal(results.c4, VIEW_ONLY_RESULT)
  // The read ran, and found no file: none was written.
  assert.match(results.c3, /^Error:/)
  assert.equal(file, null)
})

test('asking, which is also what a turn does that is told no mode: every change and every command is asked about', async () => {
  for (const mode of ['ask', undefined] as const) {
    const { asked, results, file } = await turnIn(mode)
    assert.deepEqual(asked, ['write_file', 'edit_file', 'run_command'])
    assert.equal(file, 'two')
    assert.match(results.c4, /hi/)
  }
})

test('editing in the workspace: files are changed without asking, a command is still asked about, and a no to it stands', async () => {
  const { asked, results, file } = await turnIn('edit', 'deny')
  assert.deepEqual(asked, ['run_command'])
  assert.equal(file, 'two')
  assert.equal(results.c4, 'The user denied this tool call.')
})

test('full access: nothing is asked about', async () => {
  const { asked, results, file } = await turnIn('full')
  assert.deepEqual(asked, [])
  assert.equal(file, 'two')
  assert.match(results.c4, /hi/)
})

test('a mode changed while the turn runs counts from the next call', async () => {
  // View-only for the first two calls, then everything: as if the person had changed it in between.
  let calls = 0
  const { asked, results, file } = await turnIn(() => (++calls <= 2 ? 'view' : 'full'))
  assert.deepEqual(asked, [])
  assert.equal(results.c1, VIEW_ONLY_RESULT)
  assert.equal(results.c2, VIEW_ONLY_RESULT)
  assert.match(results.c4, /hi/)
  assert.equal(file, null)
})
