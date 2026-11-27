// Git, as the app runs it. The app runs git for one thing, the worktrees of a repository
// (worktrees.ts), and this is the only place git is started from.
//
// Git does what a repository's own settings tell it: `.git/config` and the files under
// `.git/hooks` can name programs, and git starts them in the middle of a checkout, a commit or a
// merge. A folder that was downloaded or unpacked can bring such settings along. So:
//
//   - Git is run only in a repository the person said it may be run in (`GitOptions.allowed`),
//     and only in that repository's folder or in one of the app's worktrees of it. A folder where
//     a worktree was, and which holds no `.git` file any more, is none: from in there git would
//     find the main folder.
//   - No hook runs. Every call is told to look for hooks in a folder that is the app's own and
//     empty.
//   - A program that the repository's own settings name is not started: a filter, a merge driver,
//     a program that compares or signs, the watcher of files. Where the person's own settings,
//     outside the repository, name one for the same thing, theirs is used; otherwise none is
//     (`overridesFor`).
//   - A repository whose settings place its files in another folder (`core.worktree`) is refused:
//     a merge there would write into that folder.
//   - Git decides for itself whether it trusts a repository (whose folder it is, or what the
//     person named as `safe.directory`), and the app goes by that: where git turns the repository
//     down, nothing is run there, and the person is told how they say that it is theirs
//     (`GitUntrusted`). A worktree the app made is trusted as far as its repository is, and no
//     further: it is named to git with the command only after git worked in the repository itself.
//   - Git is found in PATH and started by its full path. Started by name, a `git.exe` lying in
//     the working folder would run in its place (program-path.ts).
//   - Nothing here reaches the network: the app fetches, pulls and pushes nothing.
//
// Nothing in this file depends on Electron.

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { folderKey } from '../shared/folders.ts'
import { GIT_MISSING, worktreeOfFolder } from '../shared/worktree.ts'
import { decodeOutput } from './decode.ts'
import { envValue, onPath, system32 } from './program-path.ts'

/** What git wrote, and how it ended. */
export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * An error that is said in two ways: `message` in English, for a model that asked for what
 * failed, and for the log; `told` in the language of the app, for the person. Where an error
 * goes to the person, the second is put in place of the first (`saidToPerson`).
 */
export class Explained extends Error {
  told: string

  constructor(message: string, told: string) {
    super(message)
    this.told = told
  }
}

/** An error as the person is told it: in its own words for them, where it has some. */
export const saidToPerson = (err: unknown): unknown => (err instanceof Explained ? new Error(err.told) : err)

/**
 * Git was not started: there is none, the repository was not allowed, or its settings are ones the
 * app does not run git with. Said in the language of the app as well, for the person (`Explained`).
 */
export class GitRefused extends Explained {}

/** What git says of a repository it will not work in because of whose it is. */
const NOT_TRUSTED = /dubious ownership/i

/**
 * Git would not work in the repository: it does not take it for the person's own. Its folder
 * belongs to another user of the computer, or lies on a drive that keeps no owners. Said the
 * same way whatever was asked of git, with the command that tells git the repository is theirs.
 */
export class GitUntrusted extends Explained {
  constructor(repo: string) {
    const command = `git config --global --add safe.directory "${repo.replace(/\\/g, '/')}"`
    super(
      `Git does not trust this repository: its folder belongs to another user of this computer, or lies on a drive that keeps no owners (exFAT, a network share). If the repository is the user's own, they say so to git by running this in a terminal, and then try again: ${command}`,
      `git 不信任这个仓库：它的文件夹属于这台电脑的另一个用户，或者在不记录所有者的磁盘上（exFAT、网络盘）。如果这个仓库确实是你的，在终端里运行下面这条命令，然后再试一次：\n${command}`
    )
  }
}

/** Git ran and ended with an error. The message holds what it wrote. */
export class GitFailed extends Error {
  code: number
  stderr: string

  constructor(args: readonly string[], result: GitResult) {
    const said = (result.stderr.trim() || result.stdout.trim()).slice(-2000)
    super(`git ${args[0] ?? ''} failed (exit code ${result.code})${said ? `: ${said}` : '.'}`)
    this.code = result.code
    this.stderr = result.stderr
  }
}

export interface GitOptions {
  /**
   * A folder of the app's own that stays empty. Every call is told that git's hooks are there,
   * so it finds none. Made when it is not there; a call is refused while anything lies in it.
   */
  noHooksDir: string
  /** Whether the person said git may be run in a repository, named by its folder. */
  allowed(repo: string): boolean | Promise<boolean>
  /** The variables git is started with, before this module's own: those of the app, unless a test says otherwise. */
  env?: NodeJS.ProcessEnv
  /** Set on top of everything else, for tests: where the person's own settings are read from. */
  extraEnv?: Record<string, string>
  platform?: NodeJS.Platform
}

export interface RunOptions {
  signal?: AbortSignal
  /** More for what writes many files: a checkout, a merge. */
  timeoutMs?: number
  /** Text for git to read, such as the message of a commit. */
  input?: string
}

const DEFAULT_TIMEOUT_MS = 60_000
/** What git writes is a list of names or a number. More than this is not read. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

/**
 * Git, by its full path, as found in the PATH of `env`: null where there is none. On Windows only
 * a `git.exe` counts: a `git.cmd` would be run by a shell, and a name alone would be looked for
 * in the working folder first. Elsewhere a program named without a folder is never looked for in
 * the working folder, and the name will do.
 */
export function gitProgram(env: Readonly<Record<string, string | undefined>> = process.env, platform: string = process.platform): string | null {
  if (platform !== 'win32') return 'git'
  const found = onPath('git', envValue(env, 'PATH'), '.EXE', platform)
  return path.win32.isAbsolute(found) ? found : null
}

/** The variables git is started with. */
export function gitEnv(base: NodeJS.ProcessEnv, extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    // What was set for another git does not reach this one: a hook that started the app, a
    // terminal with GIT_DIR in it. Nor does a program that would ask for a password.
    if (/^(?:GIT_|GCM_|SSH_ASKPASS)/i.test(key)) continue
    env[key] = value
  }
  return {
    ...env,
    // Nothing is asked of the person, and nothing opens an editor.
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: ':',
    GIT_SEQUENCE_EDITOR: ':',
    // A look at the state of a folder does not hold up a command the person runs there themselves.
    GIT_OPTIONAL_LOCKS: '0',
    // Git's own words in one language, whatever the system is set to.
    LC_ALL: 'C',
    ...extra
  }
}

/** One setting of git's, with where it was read from. */
export interface ConfigEntry {
  /** `system`, `global`, `local`, `worktree` or `command`, as git names where a setting stands. */
  scope: string
  /** The name, with section and variable in small letters, as git writes it in a list. */
  key: string
  value: string
}

/** Reads `git config --show-scope --list -z`: where, a NUL, the name, a line feed, the value, a NUL. */
export function readConfigList(text: string): ConfigEntry[] {
  const parts = text.split('\0')
  const entries: ConfigEntry[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i]
    const named = parts[i + 1]
    const at = named.indexOf('\n')
    // A setting written without a value stands for "true".
    entries.push(at < 0 ? { scope, key: named, value: 'true' } : { scope, key: named.slice(0, at), value: named.slice(at + 1) })
  }
  return entries
}

/**
 * The settings of git's that name a program which the app's own calls could start, each with
 * what stands in its place when the repository names one and the person does not.
 *
 *   - A filter with no command is no filter: the file is taken as it is.
 *   - A merge driver cannot be left empty: one that ends well without merging would keep one
 *     side and drop the other. `exit 1` runs nothing and makes git report the file as in conflict.
 *   - The programs for signing go back to the ones git uses when nothing is set.
 */
const PROGRAM_SETTINGS: readonly [RegExp, string][] = [
  [/^filter\..+\.(?:clean|smudge|process)$/, ''],
  [/^merge\..+\.driver$/, 'exit 1'],
  [/^diff\.external$/, ''],
  [/^diff\..+\.(?:command|textconv)$/, ''],
  [/^gpg\.program$/, 'gpg'],
  [/^gpg\.openpgp\.program$/, 'gpg'],
  [/^gpg\.x509\.program$/, 'gpgsm'],
  [/^gpg\.ssh\.program$/, 'ssh-keygen'],
  [/^gpg\.ssh\.defaultkeycommand$/, '']
]

/** A setting that is the person's own, on this computer, and not the repository's. */
const personal = (entry: ConfigEntry): boolean => entry.scope === 'system' || entry.scope === 'global'
/** A setting given with the command itself: those are this module's. */
const given = (entry: ConfigEntry): boolean => entry.scope === 'command'

/**
 * What a call is given on top of a repository's settings, as `-c name=value` pairs: for every
 * program the repository's own settings name, the person's own setting of that name where they
 * have one, and otherwise what stands for "none" (`PROGRAM_SETTINGS`). Whatever is neither the
 * person's nor given with the command counts as the repository's.
 *
 * Throws `GitRefused` for a repository whose settings place its files elsewhere.
 */
export function overridesFor(entries: readonly ConfigEntry[]): string[] {
  const flags: string[] = []
  const done = new Set<string>()
  for (const entry of entries) {
    if (personal(entry) || given(entry)) continue
    if (entry.key === 'core.worktree') {
      throw new GitRefused(
        'The settings of this repository place its files in another folder (core.worktree). StarBench does not run git in such a repository.',
        '这个仓库的配置把工作目录指到了别的文件夹（core.worktree），StarBench 不在这样的仓库里运行 git。'
      )
    }
    const standIn = PROGRAM_SETTINGS.find(([names]) => names.test(entry.key))?.[1]
    if (standIn === undefined || done.has(entry.key)) continue
    done.add(entry.key)
    const theirs = entries.filter((other) => personal(other) && other.key === entry.key).pop()
    flags.push('-c', `${entry.key}=${theirs ? theirs.value : standIn}`)
    // A filter that is not allowed to fail would fail every checkout once its program is taken away.
    const filter = /^(filter\..+)\.(?:clean|smudge|process)$/.exec(entry.key)?.[1]
    if (filter && !theirs && !done.has(`${filter}.required`)) {
      done.add(`${filter}.required`)
      flags.push('-c', `${filter}.required=false`)
    }
  }
  return flags
}

/**
 * Whether a folder is a worktree of the repository `repo`: it holds the `.git` file that git
 * writes into one, and that file names a folder under the repository's own `.git/worktrees`. A
 * folder where a worktree was is none, and neither is one whose `.git` file names a folder of
 * another repository.
 *
 * Git writes that folder as it finds it: by its real path where the repository was opened through
 * a link (a junction, a drive letter that stands for a folder), and from the worktree itself
 * where the person's settings ask for that (`worktree.useRelativePaths`). So the two are compared
 * by where they really lie.
 */
export async function isWorktreeOf(repo: string, folder: string, windows: boolean = process.platform === 'win32'): Promise<boolean> {
  // Where `.git` is a folder, the folder is a repository of its own, and there is nothing to read.
  const text = await fs.readFile(path.join(folder, '.git'), 'utf8').catch(() => null)
  const named = text === null ? undefined : /^gitdir: (.+?)\s*$/m.exec(text)?.[1]
  if (!named) return false
  const real = (dir: string): Promise<string | null> => fs.realpath(dir).catch(() => null)
  const [holder, own] = await Promise.all([real(path.dirname(path.resolve(folder, named))), real(path.join(repo, '.git', 'worktrees'))])
  return holder !== null && own !== null && folderKey(holder, windows) === folderKey(own, windows)
}

/** What every call is given, whatever the repository. */
function fixedFlags(noHooksDir: string): string[] {
  const settings = [
    // No hook is found there.
    `core.hooksPath=${noHooksDir}`,
    // The watcher of files can be a program, and git would ask it at every look at the folder.
    'core.fsmonitor=false',
    // Names of files as they are, not written out in numbers where they are not ASCII.
    'core.quotePath=false',
    // What git writes is read as UTF-8, and the messages the app gives it are UTF-8: so both are
    // said to be that, whatever the person's own settings name (`gbk` is a common advice for a
    // Chinese Windows). Otherwise the title of a commit comes out as characters that mean nothing,
    // and a commit of the app's is marked with an encoding its message is not written in.
    'i18n.logOutputEncoding=UTF-8',
    'i18n.commitEncoding=UTF-8',
    // No tidying up in the background after a commit: it would hold files open in the repository.
    'gc.auto=0',
    'maintenance.auto=false',
    // A checkout or a merge stays in this repository, and goes into none that lies in it.
    'submodule.recurse=false',
    // As they are unless a repository says otherwise: paths that Windows or macOS would read as `.git` are not written.
    'core.protectNTFS=true',
    'core.protectHFS=true',
    'advice.detachedHead=false'
  ]
  return ['--no-pager', ...settings.flatMap((setting) => ['-c', setting])]
}

/**
 * Git in one folder, for the length of one piece of work: the repository's settings are looked
 * at once, when the first command is run, and every command after it goes by what was found.
 */
export interface GitAt {
  /** Runs a command. Resolves with what it wrote and how it ended, whatever that was. */
  run(args: readonly string[], opts?: RunOptions): Promise<GitResult>
  /** Runs a command that has to end well: resolves with what it wrote, without the line end, and throws `GitFailed` otherwise. */
  read(args: readonly string[], opts?: RunOptions): Promise<string>
}

export class Git {
  private opts: GitOptions

  constructor(opts: GitOptions) {
    this.opts = opts
  }

  private get windows(): boolean {
    return (this.opts.platform ?? process.platform) === 'win32'
  }

  /** The program, by its full path; null when PATH has none. */
  program(): string | null {
    return gitProgram(this.opts.env ?? process.env, this.opts.platform ?? process.platform)
  }

  /**
   * Git in `cwd`, which is the repository `repo` itself or one of the app's worktrees of it.
   * Nothing is started yet. The first command is refused, with `GitRefused`, where the person
   * did not allow git in the repository, where the folder is neither of the two, where there is
   * no git, or where the repository's settings are ones the app does not run git with.
   */
  at(repo: string, cwd: string): GitAt {
    let ready: Promise<{ program: string; flags: string[] }> | undefined
    const prepare = (signal?: AbortSignal): Promise<{ program: string; flags: string[] }> => (ready ??= this.prepare(repo, cwd, signal))
    const run = async (args: readonly string[], opts: RunOptions = {}): Promise<GitResult> => {
      const { program, flags } = await prepare(opts.signal)
      return this.unlessUntrusted(repo, await this.start(program, cwd, [...flags, ...args], opts))
    }
    return {
      run,
      read: async (args, opts) => {
        const result = await run(args, opts)
        if (result.code !== 0) throw new GitFailed(args, result)
        return result.stdout.replace(/\r?\n$/, '')
      }
    }
  }

  /** What has to hold before git is started in a folder, and what every command there is given. */
  private async prepare(repo: string, cwd: string, signal?: AbortSignal): Promise<{ program: string; flags: string[] }> {
    const windows = this.windows
    const inRepo = folderKey(cwd, windows) === folderKey(repo, windows)
    const worktree = inRepo ? null : worktreeOfFolder(cwd, windows)
    if (!inRepo && !(worktree && folderKey(worktree.repo, windows) === folderKey(repo, windows))) {
      throw new GitRefused(
        'Git is run only in the folder of a repository or in one of its worktrees that StarBench made.',
        'git 只在仓库自己的文件夹里，或者 StarBench 在它里面建的 worktree 里运行。'
      )
    }
    if (!(await this.opts.allowed(repo))) {
      throw new GitRefused(
        'Git may not be run in this repository: it has not been allowed there.',
        '这个仓库里现在不能运行 git：你还没有允许，或者在设置里收回了允许。在输入框上面那条栏里重新允许运行 git，再试一次。'
      )
    }
    // A folder that was a worktree and is none any more lies inside the repository: started there,
    // git would find the main folder, and answer and act for that one. And one whose `.git` file
    // names a folder elsewhere is a worktree of something else.
    if (worktree && !(await isWorktreeOf(repo, cwd, windows))) {
      throw new GitRefused(
        'This folder is no worktree of this repository: it holds no .git file that names a folder under the .git/worktrees of the repository. Git is not run in it.',
        '这个文件夹不是这个仓库的 worktree：里面没有 git 写的那个 .git 文件，或者这个文件指向的不是本仓库，所以不在里面运行 git。'
      )
    }
    const program = this.program()
    if (!program) {
      throw new GitRefused('Git was not found. Install Git and make sure the folder of git.exe is in PATH, then start StarBench again.', GIT_MISSING)
    }

    const { noHooksDir } = this.opts
    await fs.mkdir(noHooksDir, { recursive: true })
    if ((await fs.readdir(noHooksDir)).length > 0) {
      throw new GitRefused(
        `The folder that stands in for git's hooks has to be empty, and is not: ${noHooksDir}`,
        `StarBench 让 git 到一个空文件夹里找钩子，这样仓库自己的钩子就不会运行；这个文件夹现在不是空的，所以没有运行 git。看一下里面是什么，清空之后再试：${noHooksDir}`
      )
    }

    const fixed = fixedFlags(noHooksDir)
    if (worktree) {
      // Git asks of every folder whose it is, and on a drive that keeps no owners it trusts only
      // what the person named to it (`safe.directory`). They name the repository; the worktree in
      // it is a folder of its own to git, and would be turned down at every command. So where git
      // works in the repository itself, the worktree the app made in it is named along with the
      // command. Only then: a repository git does not trust stays untrusted, worktree and all.
      const main = this.unlessUntrusted(repo, await this.start(program, repo, [...fixed, 'rev-parse', '--git-dir'], { signal }))
      if (main.code !== 0) throw new GitFailed(['rev-parse'], main)
      // By the path the app knows it by and by the one it really lies at: git goes by the second
      // where the repository was opened through a link, and older versions compare the two as written.
      const real = await fs.realpath(cwd).catch(() => cwd)
      for (const dir of new Set([cwd, real])) fixed.push('-c', `safe.directory=${dir.replace(/\\/g, '/')}`)
    }
    // Reading the settings starts nothing they name; it is done under the same flags all the same,
    // so that the settings read are the ones the commands will go by.
    const listed = this.unlessUntrusted(repo, await this.start(program, cwd, [...fixed, 'config', '--show-scope', '--list', '-z'], { signal }))
    if (listed.code !== 0) throw new GitFailed(['config'], listed)
    return { program, flags: [...fixed, ...overridesFor(readConfigList(listed.stdout))] }
  }

  /** What git answered, unless it would not work in the repository for whose it is: that is said as itself, whatever was asked. */
  private unlessUntrusted(repo: string, result: GitResult): GitResult {
    if (result.code !== 0 && NOT_TRUSTED.test(result.stderr)) throw new GitUntrusted(repo)
    return result
  }

  /** Starts git and waits for it. Rejects only where it could not be started, took too long, or was stopped. */
  private start(program: string, cwd: string, args: readonly string[], opts: RunOptions): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      if (opts.signal?.aborted) {
        reject(new Error('Cancelled.'))
        return
      }
      const child = spawn(program, [...args], {
        cwd,
        env: gitEnv(this.opts.env ?? process.env, this.opts.extraEnv),
        windowsHide: true,
        stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
      })
      const out: Buffer[] = []
      const err: Buffer[] = []
      let bytes = 0
      let stopped = ''
      const kill = (reason: string): void => {
        if (stopped) return
        stopped = reason
        if (this.windows && child.pid) {
          // The whole tree: git starts programs of its own, and child.kill() would stop git alone.
          spawn(system32('taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => child.kill())
        } else {
          child.kill('SIGKILL')
        }
      }
      const collect = (into: Buffer[]) => (chunk: Buffer): void => {
        bytes += chunk.length
        if (bytes > MAX_OUTPUT_BYTES) kill('Git wrote more than is read of it')
        else into.push(chunk)
      }
      child.stdout!.on('data', collect(out))
      child.stderr!.on('data', collect(err))
      if (opts.input !== undefined) {
        // Git may end before it has read everything; that is told by how it ended, not by the pipe.
        child.stdin!.on('error', () => {})
        child.stdin!.end(opts.input, 'utf8')
      }

      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const timer = setTimeout(() => kill(`Git took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped`), timeoutMs)
      const onAbort = (): void => kill('Cancelled')
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      const done = (): void => {
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
      }
      child.on('error', (cause) => {
        done()
        reject(new Error(`Git could not be started: ${cause.message}`))
      })
      child.on('close', (code) => {
        done()
        if (stopped) reject(new Error(`${stopped}.`))
        // Names of files and what was committed are UTF-8; what a program started by git complains of may be in the system's code page.
        else resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: decodeOutput(Buffer.concat(err)) })
      })
    })
  }
}
