import assert from 'node:assert/strict'
import os from 'node:os'
import { test } from 'node:test'
import { OutputTail, decodeOutput } from '../src/main/decode.ts'
import { ToolRegistry, registerBuiltinTools } from '../src/main/tools.ts'

test('valid UTF-8 is decoded as UTF-8', () => {
  assert.equal(decodeOutput(Buffer.from('中文 and ASCII ✓', 'utf8')), '中文 and ASCII ✓')
  assert.equal(decodeOutput(Buffer.alloc(0)), '')
})

test('bytes that are not UTF-8 still decode to something instead of throwing', () => {
  // 0xD6 0xD0 is "中" in GBK and invalid as UTF-8; what it becomes depends on the system code page.
  const text = decodeOutput(Buffer.from([0x41, 0xd6, 0xd0, 0x42]))
  assert.ok(text.startsWith('A') && text.endsWith('B'))
})

test('OutputTail keeps only the most recent output', () => {
  const tail = new OutputTail(10)
  for (const word of ['first ', 'second ', 'third ', '最后']) tail.push(Buffer.from(word, 'utf8'))
  assert.equal(tail.text(), 'third 最后')
  assert.equal(new OutputTail(10).text(), '')
})

test('run_command returns non-ASCII output intact', async () => {
  const tools = new ToolRegistry()
  registerBuiltinTools(tools)
  // `echo` exists in both PowerShell and sh.
  const output = await tools.execute('run_command', JSON.stringify({ command: 'echo 中文测试' }), {
    workspace: os.tmpdir(),
    signal: new AbortController().signal
  })
  assert.match(output, /^中文测试\r?\n\[exit code 0\]$/)
})
