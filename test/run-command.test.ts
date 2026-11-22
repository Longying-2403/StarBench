// Run with: node --test test/run-command.test.ts
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { onPath, system32, windowsPowerShell } from '../src/main/program-path.ts'
import { ToolRegistry, registerBuiltinTools } from '../src/main/tools.ts'

// With this variable set, Windows does not look in the working folder for a program named without
// a folder. The Claude desktop app sets it and Windows does not, so it is taken away here: the
// tests then see what the people who use the app get.
delete process.env.NoDefaultCurrentDirectoryInExePath

const windowsOnly = { skip: process.platform === 'win32' ? false : 'Windows only' }

test('run_command starts the PowerShell of Windows, not one lying in the workspace', windowsOnly, async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'starbench planted '))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  // Any program will do as the one a repository brings along; this one writes nothing a PowerShell command would.
  await copyFile(system32('whoami.exe'), path.join(workspace, 'powershell.exe'))
  const tools = new ToolRegistry()
  registerBuiltinTools(tools)
  const output = await tools.execute('run_command', JSON.stringify({ command: 'Write-Output planted-test' }), {
    workspace,
    signal: new AbortController().signal
  })
  assert.match(output, /^planted-test\r?\n\[exit code 0\]$/)
})

test('the programs of Windows are named by their full path', () => {
  assert.equal(windowsPowerShell({ SystemRoot: 'D:\\Win' }), 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.equal(system32('taskkill.exe', { windir: 'E:\\W' }), 'E:\\W\\System32\\taskkill.exe')
  // Windows does not mind the case of the name, and there is always a folder to fall back on.
  assert.equal(system32('chcp.com', { SYSTEMROOT: 'F:\\X' }), 'F:\\X\\System32\\chcp.com')
  assert.equal(system32('chcp.com', {}), 'C:\\Windows\\System32\\chcp.com')
})

test('the command of an MCP server is looked up in PATH, not in its working folder', windowsOnly, async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'starbench path '))
  const before = process.cwd()
  // Out of the folder before it is deleted: Windows deletes no folder that a process works in.
  t.after(async () => {
    process.chdir(before)
    await rm(base, { recursive: true, force: true })
  })
  const bin = path.join(base, 'bin')
  const project = path.join(base, 'project')
  await mkdir(bin)
  await mkdir(project)
  await writeFile(path.join(bin, 'tool.cmd'), '@echo real')
  await writeFile(path.join(project, 'tool.cmd'), '@echo planted')
  process.chdir(project)

  // "." in PATH would be the working folder again, so it does not count. The ending comes as
  // PATHEXT writes it (.CMD), which is the same file to Windows.
  assert.equal(onPath('tool', `.;${bin}`, '.EXE;.CMD').toLowerCase(), path.join(bin, 'tool.cmd').toLowerCase())
  assert.equal(onPath('tool.cmd', bin, '.EXE;.CMD'), path.join(bin, 'tool.cmd'))
  // A command that names a folder, or one PATH does not have, is started as it was written.
  assert.equal(onPath('.\\tool.cmd', bin, '.CMD'), '.\\tool.cmd')
  assert.equal(onPath('C:\\tools\\tool.cmd', bin, '.CMD'), 'C:\\tools\\tool.cmd')
  assert.equal(onPath('not-there', bin, '.CMD'), 'not-there')
  assert.equal(onPath('tool', bin, '.CMD', 'linux'), 'tool')
})
