// A worktree of the app's: how it is named, where it lies, how what git tells of it is read, and
// what git is started with. Git itself is not run here (test/worktrees.test.ts does that).

import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { GitRefused, gitEnv, gitProgram, overridesFor, readConfigList } from '../src/main/git.ts'
import type { ConfigEntry } from '../src/main/git.ts'
import { system32 } from '../src/main/program-path.ts'
import {
  EXCLUDE_LINE,
  LEFT_COUNTED,
  branchOf,
  hasUnmerged,
  isWorktreeName,
  leftFiles,
  projectFolder,
  readNameStatus,
  readRenames,
  readStatus,
  suggestWorktreeName,
  tidyWorktreeName,
  worktreeFolder,
  worktreeOfFolder,
  worktreesFolder
} from '../src/shared/worktree.ts'

const windowsOnly = { skip: process.platform === 'win32' ? false : 'Windows only' }

test('a worktree is named with small letters, digits and hyphens', () => {
  for (const name of ['a', '1125-1', 'fix-rail', 'x9', 'a'.repeat(40)]) assert.equal(isWorktreeName(name), true, name)
  for (const name of ['', '-a', 'a-', 'A', 'fix rail', 'a/b', 'a.b', '..', '修复', 'a'.repeat(41), 'nul', 'con', 'com1', 'lpt9', 42, null, undefined]) {
    assert.equal(isWorktreeName(name), false, String(name))
  }
  // A name that only begins like one of the devices of Windows is a name like any other.
  assert.equal(isWorktreeName('console'), true)
  assert.equal(isWorktreeName('nul-1'), true)
})

test('what the person typed is made into a name where that can be done', () => {
  assert.equal(tidyWorktreeName('Fix Rail'), 'fix-rail')
  assert.equal(tidyWorktreeName('  usage_page.v2  '), 'usage-page-v2')
  assert.equal(tidyWorktreeName('a//b\\\\c'), 'a-b-c')
  assert.equal(tidyWorktreeName('--x--y--'), 'x-y')
  // Cut to what a name may hold, with no hyphen left at the end.
  assert.equal(tidyWorktreeName(`${'a'.repeat(39)}-bcd`), 'a'.repeat(39))
  // Nothing of it can stand in a name.
  for (const text of ['', '   ', '修复导轨', '---', 'NUL']) assert.equal(tidyWorktreeName(text), '', text)
})

test('a name is proposed from the day, with a number none of that day has', () => {
  const day = new Date(2026, 10, 25, 9, 30)
  assert.equal(suggestWorktreeName([], day), '1125-1')
  assert.equal(suggestWorktreeName(['1125-1', '1125-2', 'fix-rail'], day), '1125-3')
  assert.equal(suggestWorktreeName(['1125-2'], day), '1125-1')
  assert.equal(suggestWorktreeName([], new Date(2027, 0, 3)), '0103-1')
  assert.equal(isWorktreeName(suggestWorktreeName([], day)), true)
})

test('a worktree lies in a folder of the app inside its repository, and its git branch says whose it is', () => {
  assert.equal(branchOf('1125-1'), 'starbench/1125-1')
  assert.equal(worktreesFolder('D:\\Projects\\App\\', true), 'D:\\Projects\\App\\.starbench\\worktrees')
  assert.equal(worktreeFolder('D:\\Projects\\App', '1125-1', true), 'D:\\Projects\\App\\.starbench\\worktrees\\1125-1')
  assert.equal(worktreeFolder('/home/me/app/', 'fix', false), '/home/me/app/.starbench/worktrees/fix')
  // Git is told to leave the whole folder alone, from the root of the repository only.
  assert.equal(EXCLUDE_LINE, '/.starbench/')
})

test('the path of a worktree tells which repository it is of, and nothing else passes for one', () => {
  assert.deepEqual(worktreeOfFolder('D:\\Projects\\App\\.starbench\\worktrees\\1125-1', true), { repo: 'D:\\Projects\\App', name: '1125-1' })
  // Windows does not mind the case of a name, nor which way the separators lean.
  assert.deepEqual(worktreeOfFolder('D:/Projects/App/.StarBench/Worktrees/fix/', true), { repo: 'D:\\Projects\\App', name: 'fix' })
  assert.deepEqual(worktreeOfFolder('/home/me/app/.starbench/worktrees/fix', false), { repo: '/home/me/app', name: 'fix' })
  for (const folder of [
    'D:\\Projects\\App',
    'D:\\Projects\\App\\.starbench\\worktrees',
    'D:\\Projects\\App\\.starbench\\worktrees\\Not A Name',
    'D:\\Projects\\App\\.starbench\\other\\fix',
    'D:\\Projects\\App\\worktrees\\fix',
    '.starbench\\worktrees\\fix',
    ''
  ]) {
    assert.equal(worktreeOfFolder(folder, true), null, folder)
  }
  // Elsewhere a backslash is a letter of a name like any other, and case tells names apart.
  assert.equal(worktreeOfFolder('/home/me/app/.StarBench/worktrees/fix', false), null)
  for (const [repo, name, windows] of [['D:\\Projects\\App', '1125-1', true], ['/srv/app', 'fix', false]] as const) {
    assert.deepEqual(worktreeOfFolder(worktreeFolder(repo, name, windows), windows), { repo, name })
  }
})

test('a conversation in a worktree belongs to the repository in the list', () => {
  assert.equal(projectFolder({ workspace: 'D:\\App' }), 'D:\\App')
  assert.equal(projectFolder({ workspace: 'D:\\App\\.starbench\\worktrees\\fix', worktree: { repo: 'D:\\App' } }), 'D:\\App')
})

test('the state of a folder is read from what git lists of it', () => {
  // Two letters, a space and the path; the entries end with a NUL, and so does the list.
  const listed = [' M src/a.ts', '?? 新 文件.txt', 'A  added.ts', ' D gone.ts', 'D  staged-gone.ts', 'MM both.ts', 'UU clash.ts', 'AA twice.ts', 'DU theirs.ts', ''].join('\0')
  assert.deepEqual(readStatus(listed), [
    { path: 'src/a.ts', change: 'modified' },
    { path: '新 文件.txt', change: 'added' },
    { path: 'added.ts', change: 'added' },
    { path: 'gone.ts', change: 'deleted' },
    { path: 'staged-gone.ts', change: 'deleted' },
    { path: 'both.ts', change: 'modified' },
    // Of a file in conflict, how the two sides stand is kept: only where both changed or added it can it hold marks.
    { path: 'clash.ts', change: 'modified', conflict: true, sides: 'UU' },
    { path: 'twice.ts', change: 'modified', conflict: true, sides: 'AA' },
    { path: 'theirs.ts', change: 'modified', conflict: true, sides: 'DU' }
  ])
  assert.deepEqual(readStatus(''), [])
})

test('what two commits differ in is read from a list of letters and names', () => {
  assert.deepEqual(readNameStatus(['M', 'src/a.ts', 'A', '新 文件.txt', 'D', 'gone.ts', 'T', 'kind.ts', ''].join('\0')), [
    { path: 'src/a.ts', change: 'modified' },
    { path: '新 文件.txt', change: 'added' },
    { path: 'gone.ts', change: 'deleted' },
    { path: 'kind.ts', change: 'modified' }
  ])
  assert.deepEqual(readNameStatus(''), [])
})

test('the renames between two commits are read by the name before and the name after', () => {
  // As git writes them with -z: a rename is its letter with how alike the files are, then both names.
  assert.deepEqual(readRenames(['R100', 'art/pic.bin', 'img/pic.bin', 'R087', '旧 名字.txt', '新 名字.txt', ''].join('\0')), [
    { from: 'art/pic.bin', to: 'img/pic.bin' },
    { from: '旧 名字.txt', to: '新 名字.txt' }
  ])
  // Among other changes, each of which names one path; a copy names two and is none.
  assert.deepEqual(readRenames(['M', 'a.txt', 'R090', 'b.txt', 'c.txt', 'C075', 'd.txt', 'e.txt', 'D', 'R.txt', 'R100', 'f.txt', 'g.txt', ''].join('\0')), [
    { from: 'b.txt', to: 'c.txt' },
    { from: 'f.txt', to: 'g.txt' }
  ])
  assert.deepEqual(readRenames(''), [])
  // A list that breaks off in the middle of a rename tells none for it.
  assert.deepEqual(readRenames(['R100', 'only.txt'].join('\0')), [])
})

test('a worktree holds work of its own while something is changed or committed there', () => {
  assert.equal(hasUnmerged({ uncommitted: 0, ahead: 0 }), false)
  assert.equal(hasUnmerged({ uncommitted: 2, ahead: 0 }), true)
  assert.equal(hasUnmerged({ uncommitted: 0, ahead: 1 }), true)
})

test('the files left in what was a worktree are said by their number, and as at least as many where the count stopped', () => {
  assert.equal(leftFiles(1), '1 个文件')
  assert.equal(leftFiles(LEFT_COUNTED - 1), '999 个文件')
  assert.equal(leftFiles(LEFT_COUNTED), '1000 个以上的文件')
})

test("git's own list of its settings is read with where each one stands", () => {
  const listed = ['global', 'user.name\nSome One', 'local', 'core.bare\nfalse', 'local', 'filter.demo.smudge\nsed s/A/B/', 'local', 'two.lines\nfirst\nsecond', 'worktree', 'core.sparsecheckout', ''].join('\0')
  assert.deepEqual(readConfigList(listed), [
    { scope: 'global', key: 'user.name', value: 'Some One' },
    { scope: 'local', key: 'core.bare', value: 'false' },
    { scope: 'local', key: 'filter.demo.smudge', value: 'sed s/A/B/' },
    // Only the first line feed parts a name from its value.
    { scope: 'local', key: 'two.lines', value: 'first\nsecond' },
    // Written without a value, which git reads as "true".
    { scope: 'worktree', key: 'core.sparsecheckout', value: 'true' }
  ])
  assert.deepEqual(readConfigList(''), [])
})

test('a program that the settings of a repository name is not started; one the person named is', () => {
  const entries = (...list: [string, string, string][]): ConfigEntry[] => list.map(([scope, key, value]) => ({ scope, key, value }))
  // Nothing of the repository's names a program: nothing is added.
  assert.deepEqual(overridesFor(entries(['global', 'filter.lfs.smudge', 'git-lfs smudge -- %f'], ['local', 'core.bare', 'false'], ['local', 'user.name', 'x'])), [])
  // A filter of the repository's own is taken away, and with it its being required.
  assert.deepEqual(overridesFor(entries(['local', 'filter.demo.smudge', 'evil'], ['local', 'filter.demo.clean', 'evil'], ['local', 'filter.demo.required', 'true'])), [
    '-c',
    'filter.demo.smudge=',
    '-c',
    'filter.demo.required=false',
    '-c',
    'filter.demo.clean='
  ])
  // Where the person has a filter of that name, theirs is put back in place of the repository's.
  assert.deepEqual(overridesFor(entries(['global', 'filter.lfs.smudge', 'git-lfs smudge -- %f'], ['local', 'filter.lfs.smudge', 'evil'])), ['-c', 'filter.lfs.smudge=git-lfs smudge -- %f'])
  // The later of the person's own settings is the one that counts, as it does for git.
  assert.deepEqual(overridesFor(entries(['system', 'gpg.program', 'gpg-a'], ['global', 'gpg.program', 'gpg-b'], ['local', 'gpg.program', 'evil'])), ['-c', 'gpg.program=gpg-b'])
  // A merge driver is replaced by one that runs nothing and reports the file as in conflict.
  assert.deepEqual(overridesFor(entries(['local', 'merge.planted.driver', 'evil %A'])), ['-c', 'merge.planted.driver=exit 1'])
  // The programs for comparing and for signing.
  assert.deepEqual(
    overridesFor(
      entries(
        ['local', 'diff.external', 'evil'],
        ['local', 'diff.img.textconv', 'evil'],
        ['local', 'diff.img.command', 'evil'],
        ['local', 'gpg.program', 'evil'],
        ['local', 'gpg.ssh.program', 'evil'],
        ['local', 'gpg.x509.program', 'evil'],
        ['local', 'gpg.ssh.defaultkeycommand', 'evil']
      )
    ),
    ['-c', 'diff.external=', '-c', 'diff.img.textconv=', '-c', 'diff.img.command=', '-c', 'gpg.program=gpg', '-c', 'gpg.ssh.program=ssh-keygen', '-c', 'gpg.x509.program=gpgsm', '-c', 'gpg.ssh.defaultkeycommand=']
  )
  // Settings of one worktree are the repository's too, and so is anything whose place git does not name.
  assert.deepEqual(overridesFor(entries(['worktree', 'filter.a.smudge', 'evil'], ['unknown', 'filter.b.process', 'evil'])), [
    '-c',
    'filter.a.smudge=',
    '-c',
    'filter.a.required=false',
    '-c',
    'filter.b.process=',
    '-c',
    'filter.b.required=false'
  ])
  // What was given with the command itself is this app's and is left as it is.
  assert.deepEqual(overridesFor(entries(['command', 'core.hookspath', 'C:\\empty'], ['command', 'filter.x.smudge', ''])), [])
  // A setting named twice is answered once.
  assert.deepEqual(overridesFor(entries(['local', 'merge.m.driver', 'one'], ['local', 'merge.m.driver', 'two'])), ['-c', 'merge.m.driver=exit 1'])
})

test('a repository whose settings place its files in another folder is refused', () => {
  // Said to the person in the language of the app as well (`Explained`), and to a model in English.
  assert.throws(
    () => overridesFor([{ scope: 'local', key: 'core.worktree', value: 'C:\\Users\\someone\\Documents' }]),
    (err: unknown) => err instanceof GitRefused && /another folder \(core\.worktree\)/.test(err.message) && err.told.startsWith('这个仓库的配置把工作目录指到了别的文件夹（core.worktree）')
  )
  // The person's own settings are theirs to make.
  assert.deepEqual(overridesFor([{ scope: 'global', key: 'core.worktree', value: 'D:\\tree' }]), [])
})

test('git is started with nothing that was set for another git, and asks nothing of the person', () => {
  const env = gitEnv({ PATH: 'C:\\Git\\cmd', GIT_DIR: 'C:\\elsewhere\\.git', git_work_tree: 'C:\\elsewhere', GIT_CONFIG_COUNT: '1', GCM_INTERACTIVE: 'always', SSH_ASKPASS: 'ask.exe', LANG: 'zh_CN.UTF-8', HOME: 'C:\\Users\\me' })
  assert.deepEqual(env, {
    PATH: 'C:\\Git\\cmd',
    LANG: 'zh_CN.UTF-8',
    HOME: 'C:\\Users\\me',
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: ':',
    GIT_SEQUENCE_EDITOR: ':',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C'
  })
  // What a test sets on top stays, whatever its name.
  assert.equal(gitEnv({ GIT_CONFIG_GLOBAL: 'C:\\real' }, { GIT_CONFIG_GLOBAL: 'C:\\scratch' }).GIT_CONFIG_GLOBAL, 'C:\\scratch')
})

test('git is found in PATH by its full path, and nothing in the working folder passes for it', windowsOnly, async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'starbench git path '))
  const before = process.cwd()
  t.after(async () => {
    process.chdir(before)
    await rm(base, { recursive: true, force: true })
  })
  const bin = path.join(base, 'bin')
  const project = path.join(base, 'project')
  const scripts = path.join(base, 'scripts')
  for (const dir of [bin, project, scripts]) await mkdir(dir)
  // Any program will do as the git of a PATH and as one that a repository brings along.
  await copyFile(system32('whoami.exe'), path.join(bin, 'git.exe'))
  await copyFile(system32('whoami.exe'), path.join(project, 'git.exe'))
  await writeFile(path.join(scripts, 'git.cmd'), '@echo not a program')
  process.chdir(project)

  assert.equal(gitProgram({ PATH: `.;${bin}` })?.toLowerCase(), path.join(bin, 'git.exe').toLowerCase())
  // Windows may write the name of the variable as Path.
  assert.equal(gitProgram({ Path: bin })?.toLowerCase(), path.join(bin, 'git.exe').toLowerCase())
  // A PATH that has no git: the one in the working folder is not taken, nor is a script of that name.
  assert.equal(gitProgram({ PATH: `.;${scripts}` }), null)
  assert.equal(gitProgram({ PATH: '' }), null)
  assert.equal(gitProgram({}), null)
})

test('elsewhere git is started by its name, which is never looked for in the working folder there', () => {
  assert.equal(gitProgram({ PATH: '/usr/bin' }, 'linux'), 'git')
  assert.equal(gitProgram({}, 'darwin'), 'git')
})
