import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { McpManager, formatMcpResult, mcpToolName, parseMcpConfig } from '../src/main/mcp.ts'
import { ToolRegistry } from '../src/main/tools.ts'

const signal = new AbortController().signal
const fixture = path.resolve('test/fixtures/mcp-server.mjs')

async function setup(config: object) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'starbench-mcp-'))
  const configFile = path.join(base, 'mcp.json')
  await writeFile(configFile, JSON.stringify(config))
  const tools = new ToolRegistry()
  const manager = new McpManager({ configFile, tools, clientInfo: { name: 'starbench-test', version: '0.0.0' } })
  return { configFile, tools, manager }
}

const byName = (manager: McpManager) => Object.fromEntries(manager.status().map((s) => [s.name, s]))
const run = (tools: ToolRegistry, name: string, args: object = {}) =>
  tools.execute(name, JSON.stringify(args), { workspace: '.', signal })

test('parseMcpConfig validates the common mcpServers format', () => {
  assert.deepEqual(parseMcpConfig('{"mcpServers":{}}'), { mcpServers: {} })
  const parsed = parseMcpConfig(
    JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['-y', 'x'], env: { A: 'b' } }, web: { url: 'https://example.com/mcp', disabled: true } } })
  )
  assert.equal(parsed.mcpServers.fs.command, 'npx')
  assert.deepEqual(parsed.mcpServers.fs.args, ['-y', 'x'])
  assert.equal(parsed.mcpServers.web.disabled, true)

  assert.throws(() => parseMcpConfig('{oops'), /Not valid JSON/)
  assert.throws(() => parseMcpConfig('{"servers":{}}'), /"mcpServers"/)
  assert.throws(() => parseMcpConfig('{"mcpServers":{"a":{}}}'), /either "command" or "url"/)
  assert.throws(() => parseMcpConfig('{"mcpServers":{"a":{"command":"x","url":"http://y"}}}'), /either "command" or "url"/)
  assert.throws(() => parseMcpConfig('{"mcpServers":{"a":{"url":"ftp://y"}}}'), /http:\/\/ or https:\/\//)
  assert.throws(() => parseMcpConfig('{"mcpServers":{"a":{"command":"x","args":"-y"}}}'), /"args" must be an array/)
  assert.throws(() => parseMcpConfig('{"mcpServers":{"a":{"command":"x","env":{"N":1}}}}'), /"env" must be an object/)
})

test('tool names and results are adapted for the model', () => {
  assert.equal(mcpToolName('my server', 'do.thing'), 'mcp__my_server__do_thing')
  assert.equal(mcpToolName('s', 'x'.repeat(100)).length, 64)
  assert.equal(formatMcpResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb')
  assert.equal(formatMcpResult({ content: [], structuredContent: { n: 1 } }), '{\n  "n": 1\n}')
  assert.equal(formatMcpResult({ content: [{ type: 'resource', resource: { uri: 'x', text: 'doc' } }] }), 'doc')
  assert.equal(formatMcpResult({}), '(no output)')
  assert.throws(() => formatMcpResult({ content: [{ type: 'text', text: 'bad' }], isError: true }), /bad/)
})

test('a stdio server is connected, its tools work, and failures stay contained', async () => {
  const { tools, manager, configFile } = await setup({
    mcpServers: {
      fixture: { command: process.execPath, args: [fixture], env: { FIXTURE_VALUE: 'from-config' } },
      missing: { command: 'starbench-no-such-command-xyz' },
      crashes: { command: process.execPath, args: ['-e', 'console.error("fatal: bad token"); process.exit(3)'] },
      off: { command: process.execPath, args: [fixture], disabled: true }
    }
  })
  await manager.init()
  assert.equal(byName(manager).fixture.state, 'connecting', 'init returns before servers are connected')
  await manager.settled()

  const status = byName(manager)
  assert.equal(status.fixture.state, 'connected')
  assert.equal(status.fixture.transport, 'stdio')
  assert.deepEqual(status.fixture.tools, [
    'mcp__fixture__add',
    'mcp__fixture__env',
    'mcp__fixture__argv',
    'mcp__fixture__fail',
    'mcp__fixture__weird_name_'
  ])
  assert.equal(status.missing.state, 'error')
  assert.equal(status.crashes.state, 'error')
  assert.match(status.crashes.error ?? '', /fatal: bad token/, 'the server\'s stderr explains the failure')
  assert.deepEqual([status.off.state, status.off.tools], ['disabled', []])

  assert.equal(await run(tools, 'mcp__fixture__add', { a: 2, b: 3 }), '5')
  assert.equal(await run(tools, 'mcp__fixture__env'), 'from-config')
  assert.equal(await run(tools, 'mcp__fixture__fail'), 'Error: it broke')
  assert.equal(await run(tools, 'mcp__fixture__weird_name_'), '[image content omitted]\nafter image')
  assert.equal(tools.needsPermission('mcp__fixture__add'), true)
  assert.equal(tools.list().find((t) => t.name === 'mcp__fixture__add')?.source, 'mcp:fixture')
  assert.equal(tools.list().find((t) => t.name === 'mcp__fixture__weird_name_')?.description, 'Tool "weird name!" of the MCP server "fixture".')

  // Saving a new configuration drops the old servers and their tools.
  await assert.rejects(manager.saveConfigText('{"mcpServers": 5}'), /"mcpServers"/)
  assert.equal(byName(manager).fixture.state, 'connected', 'an invalid config changes nothing')
  await manager.saveConfigText(JSON.stringify({ mcpServers: { renamed: { command: process.execPath, args: [fixture] } } }))
  await manager.settled()
  assert.deepEqual(Object.keys(byName(manager)), ['renamed'])
  assert.equal(tools.list().some((t) => t.name.startsWith('mcp__fixture__')), false)
  assert.equal(await run(tools, 'mcp__renamed__env'), '(unset)')
  assert.deepEqual(Object.keys(JSON.parse(await readFile(configFile, 'utf8')).mcpServers), ['renamed'])

  await manager.dispose()
  assert.deepEqual(tools.list(), [], 'tools are removed on shutdown')
})

// `npx`, `uvx` and friends are .cmd scripts on Windows, which cannot be started like an .exe.
// This starts the fixture through such a script: by full path, and by bare name found on PATH.
test('servers started through a .cmd script work on Windows', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'starbench mcp 测试-'))
  // The script itself stays ASCII: cmd.exe reads batch files in the console code page.
  await writeFile(path.join(dir, 'starbench-shim.cmd'), `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`)
  const args = ['plain', 'has space', '中文参数', 'quote"inside']
  const { tools, manager } = await setup({
    mcpServers: {
      'by-path': { command: path.join(dir, 'starbench-shim.cmd'), args },
      'by-name': { command: 'starbench-shim', args, env: { PATH: `${dir};${process.env.PATH ?? ''}` } }
    }
  })
  await manager.init()
  await manager.settled()
  for (const name of ['by-path', 'by-name']) {
    const status = byName(manager)[name]
    assert.equal(status.state, 'connected', `${name}: ${status.error ?? 'should connect'}`)
    assert.deepEqual(JSON.parse(await run(tools, `mcp__${name}__argv`)), args, `${name}: arguments arrive intact`)
  }
  await manager.dispose()
})

test('a config file that does not parse is reported and can be repaired', async () => {
  const { manager, configFile } = await setup({ mcpServers: {} })
  await writeFile(configFile, '{ "mcpServers": { oops')
  await assert.rejects(manager.init(), /Not valid JSON/)
  assert.match(manager.loadError ?? '', /Not valid JSON/)
  assert.deepEqual(manager.status(), [])
  // The settings page still shows the broken text, so the user can fix it there.
  assert.equal(await manager.readConfigText(), '{ "mcpServers": { oops')

  await manager.saveConfigText('{"mcpServers":{}}')
  assert.equal(manager.loadError, undefined)
  await manager.init()
  assert.equal(manager.loadError, undefined)
})

test('a missing config file means no servers', async () => {
  const tools = new ToolRegistry()
  const manager = new McpManager({
    configFile: path.join(os.tmpdir(), 'starbench-mcp-does-not-exist.json'),
    tools,
    clientInfo: { name: 't', version: '0' }
  })
  await manager.init()
  assert.deepEqual(manager.status(), [])
  assert.match(await manager.readConfigText(), /"mcpServers": \{\}/)
})

test('an HTTP server is reached with the configured headers', async () => {
  // Find a free port, then start the fixture on it.
  const port = await new Promise<number>((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => resolve(port))
    })
  })
  const child = spawn(process.execPath, [fixture, '--http', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] })
  try {
    await new Promise<void>((resolve, reject) => {
      child.stderr.once('data', () => resolve())
      child.once('exit', (code) => reject(new Error(`fixture exited with ${code}`)))
    })
    const url = `http://127.0.0.1:${port}/mcp`
    const { tools, manager } = await setup({
      mcpServers: { web: { url, headers: { 'x-test-auth': 'secret' } }, denied: { url } }
    })
    await manager.init()
    await manager.settled()
    const status = byName(manager)
    assert.equal(status.web.state, 'connected', status.web.error ?? 'the HTTP server should connect')
    assert.equal(status.web.transport, 'http')
    assert.equal(await run(tools, 'mcp__web__add', { a: 20, b: 22 }), '42')
    assert.equal(status.denied.state, 'error', 'a server that rejects us is reported, not retried forever')
    await manager.dispose()
  } finally {
    child.kill()
  }
})
