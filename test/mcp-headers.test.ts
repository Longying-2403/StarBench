// Run with: node --test test/mcp-headers.test.ts
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { McpManager } from '../src/main/mcp.ts'
import { ToolRegistry } from '../src/main/tools.ts'

test('headers are not sent over plain http to an address on the internet', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'starbench mcp '))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const configFile = path.join(dir, 'mcp.json')
  // An address of the range kept for documentation: nothing answers there, so only a refusal ends this at once.
  const servers = {
    remote: { url: 'http://203.0.113.7:9/mcp', headers: { Authorization: 'Bearer secret' } },
    'remote-sse': { url: 'http://203.0.113.7:9/sse', type: 'sse', headers: { 'X-Api-Key': 'secret' } }
  }
  await writeFile(configFile, JSON.stringify({ mcpServers: servers }))
  const manager = new McpManager({ configFile, tools: new ToolRegistry(), clientInfo: { name: 'starbench-test', version: '0.0.0' } })
  t.after(() => manager.dispose())
  const started = Date.now()
  await manager.init()
  await manager.settled()
  for (const status of manager.status()) {
    assert.equal(status.state, 'error', status.name)
    assert.match(status.error ?? '', /https/, status.name)
  }
  assert.ok(Date.now() - started < 5000, 'refused before any connection was tried')
})
