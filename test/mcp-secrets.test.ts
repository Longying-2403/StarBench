// Run with: node --test test/mcp-secrets.test.ts
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { McpManager } from '../src/main/mcp.ts'
import type { SecretBox } from '../src/main/mcp.ts'
import { ToolRegistry } from '../src/main/tools.ts'

const fixture = path.resolve('test/fixtures/mcp-server.mjs')

/** Stands in for the operating system's credential store: what it seals is unreadable as it is, and only it opens it again. */
const box: SecretBox = {
  seal: async (value) => Buffer.from(`sealed:${value}`).toString('base64'),
  open: async (sealed) => {
    const text = Buffer.from(sealed, 'base64').toString()
    if (!text.startsWith('sealed:')) throw new Error('not sealed here')
    return text.slice('sealed:'.length)
  }
}

async function managerWith(t: TestContext, fileContent?: unknown): Promise<{ configFile: string; tools: ToolRegistry; manager: McpManager }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'starbench mcp secrets '))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const configFile = path.join(dir, 'mcp.json')
  if (fileContent !== undefined) await writeFile(configFile, JSON.stringify(fileContent))
  const tools = new ToolRegistry()
  const manager = new McpManager({ configFile, tools, clientInfo: { name: 'starbench-test', version: '0.0.0' }, secrets: box })
  t.after(() => manager.dispose())
  return { configFile, tools, manager }
}

const envOf = (tools: ToolRegistry): Promise<string> => tools.execute('mcp__fixture__env', '{}', { workspace: process.cwd(), signal: new AbortController().signal })

test('secrets are sealed on disk, opened for editing, and used opened', async (t) => {
  const { configFile, tools, manager } = await managerWith(t)
  await manager.saveConfigText(JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [fixture], env: { FIXTURE_VALUE: 'secret-token' } } } }))
  const onDisk = await readFile(configFile, 'utf8')
  assert.ok(!onDisk.includes('secret-token'), 'the token is not on disk as it was written')
  assert.match(onDisk, /"FIXTURE_VALUE": "starbench-sealed:/)
  assert.match(await manager.readConfigText(), /"FIXTURE_VALUE": "secret-token"/)
  await manager.settled()
  assert.equal(await envOf(tools), 'secret-token')
  // Saved again as the settings page shows it, it is sealed again and not sealed twice.
  await manager.saveConfigText(await manager.readConfigText())
  await manager.settled()
  assert.equal(await envOf(tools), 'secret-token')
})

test('a token written into mcp.json by hand is sealed when the app starts', async (t) => {
  const { configFile, tools, manager } = await managerWith(t, { mcpServers: { fixture: { command: process.execPath, args: [fixture], env: { FIXTURE_VALUE: 'by-hand' } } } })
  await manager.init()
  await manager.settled()
  const onDisk = await readFile(configFile, 'utf8')
  assert.ok(!onDisk.includes('by-hand'), 'sealed on disk')
  assert.equal(await envOf(tools), 'by-hand')
})

test('a secret sealed on another computer stops only its own server, and says what to do', async (t) => {
  const foreign = 'starbench-sealed:' + Buffer.from('not-ours').toString('base64')
  const { manager } = await managerWith(t, {
    mcpServers: {
      foreign: { command: process.execPath, args: [fixture], env: { FIXTURE_VALUE: foreign } },
      fine: { command: process.execPath, args: [fixture], env: { FIXTURE_VALUE: 'plain' } }
    }
  })
  await manager.init()
  await manager.settled()
  const status = Object.fromEntries(manager.status().map((s) => [s.name, s]))
  assert.equal(status.foreign.state, 'error')
  assert.match(status.foreign.error ?? '', /Enter it again/)
  assert.equal(status.fine.state, 'connected')
  // The settings page shows that value as it is, so that it can be replaced.
  assert.ok((await manager.readConfigText()).includes(foreign))
})
