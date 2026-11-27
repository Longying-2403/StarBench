// The worktrees of a repository, as the app makes them, merges them and takes them away
// (shared/worktree.ts says what one is). Everything here runs git through main/git.ts and is
// held to what stands there: only where the person allowed it, with no hooks, and with none of
// the programs a repository's own settings name.
//
// Two things hold throughout:
//
//   - The main folder, the one the person works in, is only ever moved forward to a commit of a
//     worktree's (`merge --ff-only`). Where both have new commits, the main folder's are merged
//     into the worktree first, so a clash shows up there and is solved there. The main folder is
//     never left in the middle of a merge.
//   - Before anything is written into the main folder, it is looked at: a file there that is
//     changed and not committed, and that the merge would write, stops the merge with the names
//     of such files, and nothing is changed. So does anything that lies where the merge would put
//     a new file, a file git ignores among it: git writes over those without a word unless it is
//     told not to, and it is told (`--no-overwrite-ignore`).
//
// A worktree is one as long as its folder holds the `.git` file that names its repository. A
// folder without it is what was left of one (git takes a worktree away and leaves a link to
// another folder standing, a junction to `node_modules` for one): git is never run in it, where
// it would find the main folder instead and answer for that.
//
// Nothing in this file depends on Electron.

import fs from 'node:fs/promises'
import path from 'node:path'
import { folderKey } from '../shared/folders.ts'
import { cutAt } from '../shared/well-formed.ts'
import { EXCLUDE_LINE, HISTORY_COMMITS, HISTORY_FILES, LEFT_COUNTED, branchOf, hasUnmerged, isWorktreeName, readNameStatus, readRenames, readStatus, worktreeFolder, worktreesFolder } from '../shared/worktree.ts'
import type { ChangedFile, ClashHistory, GoneFolder, Kept, MergeOutcome, MergeSide, RemoveOutcome, Renamed, ResolveOutcome, UndoOutcome, UpdateOutcome, WorktreeInfo, WorktreeState } from '../shared/worktree.ts'
import { Explained, GitFailed, isWorktreeOf } from './git.ts'
import type { Git, GitAt, GitResult } from './git.ts'

/** For what writes a whole checkout or goes through many files. */
const LONG_MS = 10 * 60_000
/** As much of the first line of a commit as is told of it. */
const HISTORY_LINE = 120
/** As many files of an open merge as git is asked about at the same time. */
const HISTORY_AT_ONCE = 6

/**
 * A commit's short name and first line, as they are told: on one line, and with a blank for
 * everything that does not show or that moves the text about where it is shown (control
 * characters, the marks that turn the direction of writing or join and part characters unseen,
 * the separators of lines and of paragraphs). Whoever wrote the commit wrote the line, and it is
 * read by a model and shown to a person. Cut between characters, never inside one.
 */
function titleTold(line: string): string {
  return cutAt(line.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim(), HISTORY_LINE)
}

/**
 * What a model is told of a worktree that is one no more, wherever it is told: by the tools
 * (main/worktree-tools.ts), and here where a commit is asked for. It is said which of the two it
 * is (`GoneFolder`), and what that means for the work: told only that the folder was gone or no
 * worktree, a model said that the files it had written were lost, while they were all there.
 */
export function goneText(folder: GoneFolder): string {
  return folder === 'missing'
    ? 'The folder of this worktree is no longer there: it was deleted, or moved away, and what was changed in it and not committed went with it.'
    : 'The folder of this worktree is still there, and so are the files in it (the file tools still reach them), but it is no worktree any more: the .git file that git wrote into it is gone, or names no worktree of this repository. Git is not run in such a folder, so nothing in it can be committed, brought in or merged.'
}

/** What lists of changed files are asked for with, so that nothing but git itself works on them. */
const PLAIN = ['--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all']
const STATUS = ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--ignore-submodules=all']

const notThere = (err: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')
const exists = (target: string): Promise<boolean> => fs.stat(target).then(() => true, () => false)
/** Whether anything is at a path, a link that leads nowhere among it. */
const lies = (target: string): Promise<boolean> => fs.lstat(target).then(() => true, () => false)

/** Where a path really lies, links followed, as far as anything is there: the rest of it is kept as it is written. */
async function reallyAt(target: string): Promise<string> {
  const real = await fs.realpath(target).catch(() => null)
  if (real !== null) return real
  const parent = path.dirname(target)
  return parent === target ? target : path.join(await reallyAt(parent), path.basename(target))
}

/**
 * How many files a folder holds, itself and the folders in it, as far as `LEFT_COUNTED`. A link
 * to another folder is not gone into and is no file: what lies behind it is not the folder's.
 */
async function filesIn(folder: string, counted = 0): Promise<number> {
  const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => [])
  let files = counted
  for (const entry of entries) {
    if (files >= LEFT_COUNTED) break
    const full = path.join(folder, entry.name)
    // Windows lists more than links as links (a file kept in the cloud, for one): the file itself says which it is.
    const kind = entry.isSymbolicLink() ? await fs.lstat(full).catch(() => null) : entry
    if (!kind || kind.isSymbolicLink()) continue
    if (kind.isDirectory()) files = await filesIn(full, files)
    else files++
  }
  return files
}

/**
 * Why a repository has no commit that a worktree could start from, told from how git ended when
 * it was asked for one. Asked quietly, it says nothing and ends with 1 where there is none yet;
 * anything else is a failure of its own. (A repository git does not trust never gets this far:
 * main/git.ts says that of every command.)
 */
function noCommit(asked: GitResult): Error {
  if (asked.code !== 1 || asked.stderr.trim()) return new GitFailed(['rev-parse'], asked)
  return new Explained('This repository has no commit yet, and a worktree starts from one. Commit something first.', '这个仓库还没有任何提交，而 worktree 要从一个提交出发。先在仓库里提交一次，再试。')
}

/** A lock of the person's on a worktree (`git worktree lock`): what they wrote, empty where they wrote nothing, and the path git knows it by. */
interface Lock {
  reason: string
  path: string
}

/** What git said when it ended badly, the end of it where it said much. */
const saidBy = (result: GitResult): string => (result.stderr.trim() || result.stdout.trim()).slice(-1000)

/**
 * Git could not list the worktrees of a repository, so whether one is locked cannot be told: it
 * reads the lock of each, and one that another program holds open is enough. Nothing is deleted
 * then, which would leave half of a worktree.
 */
function lockUnknown(listed: GitResult): Explained {
  const said = saidBy(listed)
  return new Explained(
    `${new GitFailed(['worktree', 'list'], listed).message} Whether the worktree is locked could not be told, so nothing of it was deleted.`,
    `没能确认这个 worktree 有没有被锁住，所以还什么都没删。可能有别的程序正占用着仓库 .git 文件夹里的文件，稍后再试一次。${said ? `\ngit 的原话：${said}` : ''}`
  )
}

/** Git would not take a lock away from the worktree it was named by. Nothing is deleted then. */
function notUnlocked(result: GitResult, named: string): Explained {
  const said = saidBy(result)
  return new Explained(
    `${new GitFailed(['worktree', 'unlock'], result).message} The worktree stays locked, and nothing of it was deleted.`,
    `没能解开这个 worktree 的锁，所以还什么都没删。稍后再试一次；如果还是不行，在仓库的文件夹里打开终端，运行下面这条命令解锁，再删除这个会话：\ngit worktree unlock "${named}"${said ? `\ngit 的原话：${said}` : ''}`
  )
}

/**
 * The files, or folders, git names when it stops a merge rather than write over them or lose what
 * lies in them: the lines it sets in after saying so. None where it stopped for another reason.
 */
function keptFromMerge(said: string): string[] {
  const at = said.search(/would be overwritten by merge|would lose untracked files in them/)
  if (at < 0) return []
  return said
    .slice(at)
    .split(/\r?\n/)
    .filter((line) => line.startsWith('\t'))
    .map((line) => line.trim())
    .filter(Boolean)
}

/** A folder that could not be deleted because something in it is in use, said so that the way out is plain. Null for any other failure. */
function inUse(err: unknown, folder: string): Error | null {
  const { code, path: at } = err as NodeJS.ErrnoException
  if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(code ?? '')) return null
  return new Explained(
    `The folder of the worktree could not be deleted: something in it is open in another program, or a program is running there (${at ?? folder}). Close it, or stop what runs there, and delete again.`,
    `worktree 的文件夹删不掉：里面有文件被别的程序开着，或者有程序正在里面运行（${at ?? folder}）。把它关掉或停掉，再删除一次。`
  )
}

/** A checkout that failed over a path longer than Windows takes, said so that the ways out are plain. Null for any other failure. */
function pathTooLong(err: unknown, name: string): Error | null {
  if (!(err instanceof GitFailed) || !/Filename too long/i.test(err.message)) return null
  return new Explained(
    `The worktree could not be made: a file in it would have a path longer than Windows takes (260 characters), because the worktree lies inside the repository, under .starbench\\worktrees\\${name}. Give the worktree a shorter name, move the repository to a shorter path, or let git use long paths (git config --global core.longpaths true). What was made of the worktree was taken away again.`,
    `建不了这个 worktree：它在仓库里面的 .starbench\\worktrees\\${name} 下，里面有文件的路径会超过 Windows 的上限（260 个字符）。可以给 worktree 起一个短一点的名字，把仓库移到短一点的路径下，或者让 git 使用长路径（git config --global core.longpaths true）。已经建出来的部分清理掉了。`
  )
}

/**
 * A path as git writes one from the root of a worktree, made of what a model gave: with forward
 * slashes, and nothing in front of the first name. Null for what is no path inside the worktree:
 * nothing at all, a path from the root of a drive, one with `..` in it.
 */
function pathInTree(given: string): string | null {
  // A slash at the end is how a folder is often written: it is the same name without it.
  const parts = given.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '').split('/')
  if (/^[A-Za-z]:/.test(parts[0] ?? '') || parts.some((part) => part === '' || part === '..' || part === '.')) return null
  return parts.join('/')
}

/** The length that is looked through at a time for the marks of a merge, and how much of one piece is looked at again with the next. */
const MARKS_PIECE = 1024 * 1024
const MARKS_OVERLAP = 16
/** A line that begins with seven of one of the two signs, and goes on with a space or ends there. */
const MARK = /\n(?:<{7}|>{7})[ \r\n]/

/**
 * What a folder is to git, read from the folder itself, without running git: the `main` folder
 * of a repository, a folder `linked` to one (a worktree someone made, or a module of another
 * repository), or `none` of it. The app makes worktrees from a main folder only.
 */
export async function repoKind(folder: string): Promise<'main' | 'linked' | 'none'> {
  try {
    const stat = await fs.stat(path.join(folder, '.git'))
    if (stat.isFile()) return 'linked'
    if (!stat.isDirectory()) return 'none'
    await fs.stat(path.join(folder, '.git', 'HEAD'))
    return 'main'
  } catch {
    return 'none'
  }
}

/**
 * The names that worktrees of the app's have in a repository, read from its folders: the ones
 * under `.starbench/worktrees`, and the git branches `starbench/…` left of earlier ones. Git is
 * not run, so this can be asked of a repository before the person allowed git there.
 */
export async function takenNames(repo: string, windows: boolean = process.platform === 'win32'): Promise<string[]> {
  const names = new Set<string>()
  const add = (name: string): void => {
    if (isWorktreeName(name)) names.add(name)
  }
  const entries = await fs.readdir(worktreesFolder(repo, windows), { withFileTypes: true }).catch(() => [])
  for (const entry of entries) if (entry.isDirectory()) add(entry.name)
  for (const name of await fs.readdir(path.join(repo, '.git', 'refs', 'heads', 'starbench')).catch(() => [])) add(name)
  // Branches that git has put together into one file.
  const packed = await fs.readFile(path.join(repo, '.git', 'packed-refs'), 'utf8').catch(() => '')
  for (const [, name] of packed.matchAll(/^[0-9a-f]+ refs\/heads\/starbench\/(\S+)$/gm)) add(name)
  return [...names].sort()
}

/**
 * Whether a file still holds the marks git writes where two sides of a merge clash. Null where
 * that cannot be told: it is no file, or cannot be read.
 *
 * The file is gone through piece by piece, whatever its size: a file too large to look through
 * would have to be taken either for solved, and be committed with the marks in it, or for one
 * without marks, which is what the model would then be told of it.
 */
async function marksIn(file: string): Promise<boolean | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    if (!(await fs.stat(file)).isFile()) return null
    handle = await fs.open(file, 'r')
    const piece = Buffer.alloc(MARKS_PIECE)
    // A line end in front of the first piece and behind the last: a mark is the whole of a line's beginning, wherever the line stands.
    let kept = '\n'
    for (;;) {
      const { bytesRead } = await handle.read(piece, 0, piece.length, null)
      const text = kept + (bytesRead > 0 ? piece.toString('latin1', 0, bytesRead) : '\n')
      if (MARK.test(text)) return true
      if (bytesRead === 0) return false
      // A mark that the edge of a piece cut in two is found with the next piece.
      kept = text.slice(-MARKS_OVERLAP)
    }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

export interface WorktreesOptions {
  git: Git
  /** Folders are told apart as Windows does. The system's way, unless a test says otherwise. */
  windows?: boolean
}

export class Worktrees {
  private git: Git
  private windows: boolean
  /** One piece of work at a time in a repository: what one changes, the next one reads. */
  private chains = new Map<string, Promise<unknown>>()

  constructor(opts: WorktreesOptions) {
    this.git = opts.git
    this.windows = opts.windows ?? process.platform === 'win32'
  }

  private queued<T>(repo: string, job: () => Promise<T>): Promise<T> {
    const key = folderKey(repo, this.windows)
    const result = (this.chains.get(key) ?? Promise.resolve()).then(job, job)
    const tail = result.then(
      () => {},
      () => {}
    )
    this.chains.set(key, tail)
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key)
    })
    return result
  }

  /** The folder of a worktree. */
  folderOf(info: Pick<WorktreeInfo, 'repo' | 'name'>): string {
    return worktreeFolder(info.repo, info.name, this.windows)
  }

  /** Whether a worktree's folder still holds one, and one of its repository (`isWorktreeOf`). Anything else that lies there is what was left of it. */
  private stands(info: Pick<WorktreeInfo, 'repo' | 'name'>): Promise<boolean> {
    return isWorktreeOf(info.repo, this.folderOf(info), this.windows)
  }

  /** How a worktree is one no more (`GoneFolder`), or null while it is one. A folder still at its place is what was left of it. */
  private async howGone(info: Pick<WorktreeInfo, 'repo' | 'name'>): Promise<GoneFolder | null> {
    if (await this.stands(info)) return null
    const there = await fs.stat(this.folderOf(info)).catch(() => null)
    return there?.isDirectory() ? 'left' : 'missing'
  }

  /**
   * Makes a worktree of `repo` under `name`, on a new git branch `starbench/<name>`, from the
   * commit the main folder is at. What is changed there and not committed is not in it.
   */
  create(repo: string, name: string, signal?: AbortSignal): Promise<WorktreeInfo> {
    return this.queued(repo, async () => {
      // What stops a worktree from being made is said to the person alone: a model is never the one that asks for one.
      if (!isWorktreeName(name)) {
        throw new Explained(
          'A worktree is named with small letters, digits and hyphens, at most 40 of them, beginning and ending with a letter or a digit.',
          'worktree 的名字只能用小写字母、数字和连字符，最多 40 个字符，开头和结尾要是字母或数字。'
        )
      }
      const kind = await repoKind(repo)
      if (kind === 'linked') {
        throw new Explained(
          "This folder is itself a worktree, or a module of another repository. A worktree is made from a repository's own folder.",
          '这个文件夹本身就是一个 worktree，或者是别的仓库里的子模块。worktree 要从仓库自己的文件夹建。'
        )
      }
      if (kind === 'none') throw new Explained('This folder is not a git repository.', '这个文件夹不是 git 仓库。')
      const folder = this.folderOf({ repo, name })
      if (await exists(folder)) throw new Explained(`A worktree named "${name}" is there already.`, `已经有一个叫 ${name} 的 worktree 了，换一个名字。`)

      const git = this.git.at(repo, repo)
      const head = await git.run(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { signal })
      if (head.code !== 0) throw noCommit(head)
      const base = head.stdout.trim()
      const branch = branchOf(name)
      if ((await git.run(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { signal })).code === 0) {
        throw new Explained(
          `The git branch ${branch} is there already, left of an earlier worktree. Choose another name.`,
          `git 分支 ${branch} 已经在了，是以前的一个 worktree 留下的。换一个名字。`
        )
      }

      await this.keepOutOfSight(repo)
      await fs.mkdir(worktreesFolder(repo, this.windows), { recursive: true })
      try {
        await git.read(['worktree', 'add', '-b', branch, folder, base], { signal, timeoutMs: LONG_MS })
      } catch (err) {
        // Half a worktree is none: what was made of it is taken away again, as far as that goes.
        await git.run(['worktree', 'remove', '--force', folder]).catch(() => {})
        await fs.rm(folder, { recursive: true, force: true }).catch(() => {})
        await git.run(['worktree', 'prune']).catch(() => {})
        await git.run(['branch', '-D', branch]).catch(() => {})
        await this.dropEmptyHolders(repo)
        throw pathTooLong(err, name) ?? err
      }
      return { repo, name, base }
    })
  }

  /** Has git leave the app's folder alone in this repository (`EXCLUDE_LINE`). The file is the repository's own and is not committed. */
  private async keepOutOfSight(repo: string): Promise<void> {
    const file = path.join(repo, '.git', 'info', 'exclude')
    let text = ''
    try {
      text = await fs.readFile(file, 'utf8')
    } catch (err) {
      if (!notThere(err)) throw err
    }
    if (text.split(/\r?\n/).some((line) => line.trim() === EXCLUDE_LINE)) return
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    const gap = text && !text.endsWith('\n') ? eol : ''
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, `${text}${gap}# Added by StarBench: the worktrees it makes lie in this folder.${eol}${EXCLUDE_LINE}${eol}`, 'utf8')
  }

  /** The git branch the main folder is on; null while it is on none. */
  private async targetOf(main: GitAt, signal?: AbortSignal): Promise<string | null> {
    const named = await main.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], { signal })
    return named.code === 0 ? named.stdout.trim() || null : null
  }

  /** What is changed in a folder and not committed. */
  private async changes(git: GitAt, signal?: AbortSignal): Promise<ChangedFile[]> {
    const listed = await git.run(STATUS, { signal })
    if (listed.code !== 0) throw new GitFailed(STATUS, listed)
    return readStatus(listed.stdout)
  }

  /** Whether a merge is open in a folder. */
  private async merging(git: GitAt, signal?: AbortSignal): Promise<boolean> {
    return (await git.run(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { signal })).code === 0
  }

  /** How a worktree stands against the main folder. */
  async state(info: WorktreeInfo, signal?: AbortSignal): Promise<WorktreeState> {
    const main = this.git.at(info.repo, info.repo)
    const branch = `refs/heads/${branchOf(info.name)}`
    const target = await this.targetOf(main, signal)
    const folder = this.folderOf(info)
    // A folder that is left of a worktree counts as none: asked there, git would answer for the main folder.
    const gone = await this.howGone(info)

    // Asked of the main folder, by the name of the branch, so that it is known for a worktree whose folder is gone as well.
    let ahead = 0
    let behind = 0
    let committed: ChangedFile[] = []
    if ((await main.run(['show-ref', '--verify', '--quiet', branch], { signal })).code === 0) {
      const counted = await main.read(['rev-list', '--left-right', '--count', `HEAD...${branch}`], { signal })
      const [left, right] = counted.split(/\s+/).map(Number)
      behind = left || 0
      ahead = right || 0
      // Three dots: what the branch changed since the two parted, whatever the main folder did meanwhile.
      const listed = await main.run(['diff', '--name-status', '-z', ...PLAIN, `HEAD...${branch}`], { signal })
      if (listed.code !== 0) throw new GitFailed(['diff'], listed)
      committed = readNameStatus(listed.stdout)
    }
    if (gone) return { gone, uncommitted: 0, ahead, behind, files: committed, target, conflicts: [] }

    const loose = await this.changes(this.git.at(info.repo, folder), signal)
    const files = new Map(committed.map((file) => [file.path, file]))
    for (const file of loose) files.set(file.path, file)
    return {
      gone: false,
      uncommitted: loose.length,
      ahead,
      behind,
      files: [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      target,
      conflicts: loose.filter((file) => file.conflict).map((file) => file.path)
    }
  }

  /**
   * The files of a merge that is open in a worktree and not solved yet, of those that are changed
   * there (`loose`). A file that holds the marks of the merge is `marked`. One that holds none
   * counts as solved, as whoever edited the marks out of it meant it to, unless it is still as
   * the merge left it; that one is `undecided`:
   *
   *   - A side deleted the file, or moved it. Git wrote no marks, and its list of what is to be
   *     committed still waits for the answer.
   *   - Both changed it and it is, to the byte, the worktree's own side: a file git took for
   *     binary and wrote no marks into. Committed like that, the main folder's change to it would
   *     be dropped without a word.
   *   - It is too large to be searched for marks.
   *
   * Such a file is settled with git itself, by choosing a side and staging it: then git's list
   * holds the answer, and the file is not in conflict any more.
   */
  private async unsolved(git: GitAt, folder: string, loose: readonly ChangedFile[], signal?: AbortSignal): Promise<{ marked: string[]; undecided: string[] }> {
    const marked: string[] = []
    const undecided: string[] = []
    for (const file of loose) {
      if (!file.conflict) continue
      const full = path.join(folder, file.path)
      const marks = await marksIn(full)
      if (marks === true) marked.push(file.path)
      else if (await this.asLeft(git, file, full, marks !== null, signal)) undecided.push(file.path)
    }
    return { marked, undecided }
  }

  /** Whether a file in conflict that shows no marks is as the merge left it (`unsolved`). `searched`: it was looked through for marks. */
  private async asLeft(git: GitAt, file: ChangedFile, full: string, searched: boolean, signal?: AbortSignal): Promise<boolean> {
    if (file.sides !== 'UU' && file.sides !== 'AA') return true
    // Taken away since: that is an answer.
    if (!(await lies(full))) return false
    if (!searched) return true
    const ours = await git.run(['rev-parse', '--verify', '--quiet', `:2:${file.path}`], { signal })
    const now = await git.run(['hash-object', '--', file.path], { signal })
    return ours.code !== 0 || now.code !== 0 || ours.stdout.trim() === now.stdout.trim()
  }

  /**
   * Commits everything that is changed in a worktree, with `message`. Resolves with the commit,
   * or with none where nothing was changed. A merge that is open in the worktree is finished by
   * it, unless files of it are not solved (`unsolved`): those are named and nothing is committed.
   */
  commit(info: WorktreeInfo, message: string, signal?: AbortSignal): Promise<{ commit: string | null; files: number; unfinished: string[]; undecided: string[] }> {
    return this.queued(info.repo, () => this.commitNow(info, message, signal))
  }

  private async commitNow(info: WorktreeInfo, message: string, signal?: AbortSignal): Promise<{ commit: string | null; files: number; unfinished: string[]; undecided: string[] }> {
    const folder = this.folderOf(info)
    const gone = await this.howGone(info)
    if (gone) throw new Error(`Not committed. ${goneText(gone)}`)
    const git = this.git.at(info.repo, folder)
    const loose = await this.changes(git, signal)
    const { marked, undecided } = await this.unsolved(git, folder, loose, signal)
    if (marked.length > 0 || undecided.length > 0) return { commit: null, files: 0, unfinished: marked, undecided }
    if (loose.length === 0 && !(await this.merging(git, signal))) return { commit: null, files: 0, unfinished: [], undecided: [] }

    const text = message.trim()
    if (!text) throw new Error('A commit needs a message.')
    await git.read(['add', '-A'], { signal, timeoutMs: LONG_MS })
    await git.read(['commit', '-F', '-'], { signal, timeoutMs: LONG_MS, input: `${text}\n` })
    return { commit: await git.read(['rev-parse', 'HEAD'], { signal }), files: loose.length, unfinished: [], undecided: [] }
  }

  /**
   * Brings the commits of the main folder into a worktree, by a merge there. Where both changed
   * the same lines, the merge is left open in the worktree with its marks in the files, for
   * whoever works there to solve and commit; with `giveUp` it is taken back instead, and the
   * worktree is as it was.
   */
  update(info: WorktreeInfo, opts: { giveUp?: boolean } = {}, signal?: AbortSignal): Promise<UpdateOutcome> {
    return this.queued(info.repo, () => this.updateNow(info, opts, signal))
  }

  private async updateNow(info: WorktreeInfo, opts: { giveUp?: boolean }, signal?: AbortSignal): Promise<UpdateOutcome> {
    const folder = this.folderOf(info)
    const gone = await this.howGone(info)
    if (gone) return { kind: 'gone', folder: gone }
    const git = this.git.at(info.repo, folder)
    const main = this.git.at(info.repo, info.repo)
    /** The files of the open merge that both sides have something to say of, and those of them that wait for a side to be chosen. */
    const clash = async (): Promise<{ files: string[]; undecided: string[] }> => {
      const listed = await git.run(['diff', '--name-only', '--diff-filter=U', '-z', ...PLAIN], { signal })
      const { undecided } = await this.unsolved(git, folder, await this.changes(git, signal), signal)
      return { files: listed.stdout.split('\0').filter(Boolean), undecided }
    }
    // A merge that was left open before is the one to finish.
    if (await this.merging(git, signal)) return { kind: 'conflict', ...(await clash()), open: true }
    const loose = await this.changes(git, signal)
    if (loose.length > 0) return { kind: 'dirty', files: loose.length }

    const head = await main.read(['rev-parse', '--verify', 'HEAD^{commit}'], { signal })
    if ((await git.run(['merge-base', '--is-ancestor', head, 'HEAD'], { signal })).code === 0) return { kind: 'current' }
    const from = (await this.targetOf(main, signal)) ?? head.slice(0, 10)
    const merged = await git.run(['merge', '--no-edit', '-m', `Merge ${from} into ${branchOf(info.name)}`, head], { signal, timeoutMs: LONG_MS })
    if (merged.code === 0) return { kind: 'updated', commit: await git.read(['rev-parse', 'HEAD'], { signal }) }
    if (!(await this.merging(git, signal))) throw new GitFailed(['merge'], merged)
    const found = await clash()
    if (opts.giveUp) await git.read(['merge', '--abort'], { signal, timeoutMs: LONG_MS })
    return { kind: 'conflict', ...found, open: !opts.giveUp }
  }

  /**
   * Brings a worktree's work into the main folder. What is not committed in the worktree is
   * committed first, with `message`. See the top of this file for what is looked at before the
   * main folder is touched.
   */
  merge(info: WorktreeInfo, message: string, signal?: AbortSignal): Promise<MergeOutcome> {
    return this.queued(info.repo, async () => {
      const folder = this.folderOf(info)
      const gone = await this.howGone(info)
      if (gone) return { kind: 'gone', folder: gone }
      const pending = await this.commitNow(info, message, signal)
      if (pending.unfinished.length > 0 || pending.undecided.length > 0) return { kind: 'unfinished', files: pending.unfinished, undecided: pending.undecided }

      const main = this.git.at(info.repo, info.repo)
      const git = this.git.at(info.repo, folder)
      const target = await this.targetOf(main, signal)
      if (!target) return { kind: 'detached' }
      if (await this.busy(info.repo)) return { kind: 'busy' }
      const head = await main.read(['rev-parse', '--verify', 'HEAD^{commit}'], { signal })
      let tip = await git.read(['rev-parse', '--verify', 'HEAD^{commit}'], { signal })
      const within = async (older: string, newer: string): Promise<boolean> => (await main.run(['merge-base', '--is-ancestor', older, newer], { signal })).code === 0
      if (await within(tip, head)) return { kind: 'nothing' }

      if (!(await within(head, tip))) {
        // Both have moved on: the main folder's commits go into the worktree first, and a clash is found there.
        const updated = await this.updateNow(info, { giveUp: true }, signal)
        if (updated.kind === 'conflict') return { kind: 'conflict', files: updated.files }
        if (updated.kind !== 'updated') throw new Error(`The worktree could not take the commits of the main folder (${updated.kind}).`)
        tip = updated.commit
      }

      const incoming = await main.run(['diff', '--name-status', '-z', ...PLAIN, head, tip], { signal })
      if (incoming.code !== 0) throw new GitFailed(['diff'], incoming)
      const files = readNameStatus(incoming.stdout)
      // Names are one to Windows whatever their case.
      const key = (name: string): string => (this.windows ? name.toLowerCase() : name)
      const loose = new Set((await this.changes(main, signal)).map((file) => key(file.path)))
      const inTheWay = new Set(files.filter((file) => loose.has(key(file.path))).map((file) => file.path))
      // A file git ignores is in no list of changes: looked for where the merge would put a new file.
      for (const file of files) {
        const lying = file.change === 'added' ? await this.lyingAt(main, info.repo, file.path, signal) : null
        if (lying) inTheWay.add(lying)
      }
      if (inTheWay.size > 0) return { kind: 'blocked', files: [...inTheWay].sort() }

      // Git is told as well not to write over what it ignores, which it does unasked: what the look above missed stops the merge here.
      const moved = await main.run(['merge', '--ff-only', '--no-overwrite-ignore', tip], { signal, timeoutMs: LONG_MS })
      if (moved.code !== 0) {
        const kept = keptFromMerge(moved.stderr)
        if (kept.length > 0) return { kind: 'blocked', files: kept }
        throw new GitFailed(['merge'], moved)
      }
      const commits = Number(await main.read(['rev-list', '--count', `${head}..${tip}`], { signal })) || 0
      return { kind: 'merged', before: head, after: tip, target, files, commits }
    })
  }

  /**
   * What lies in the main folder where a merge would put the new file `file` and is none of
   * git's: a file, or a link, at the path itself or where a folder above it would have to be.
   * Null where the way is free; where git keeps what lies there (a file that is moved, or renamed
   * in nothing but the case of its letters); and where a folder lies at the path, which is left
   * for git to judge.
   */
  private async lyingAt(main: GitAt, repo: string, file: string, signal?: AbortSignal): Promise<string | null> {
    const parts = file.split('/')
    for (let depth = 1; depth <= parts.length; depth++) {
      const stat = await fs.lstat(path.join(repo, ...parts.slice(0, depth))).catch(() => null)
      if (!stat) return null
      if (stat.isDirectory()) continue
      const found = parts.slice(0, depth).join('/')
      const kept = await main.run(['ls-files', '-z', '--', `:(literal${this.windows ? ',icase' : ''})${found}`], { signal })
      return kept.code === 0 && kept.stdout === '' ? found : null
    }
    return null
  }

  /** Whether the main folder is in the middle of something of its own that a merge must not walk into. */
  private async busy(repo: string): Promise<boolean> {
    const marks = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply']
    for (const mark of marks) if (await exists(path.join(repo, '.git', mark))) return true
    return false
  }

  /**
   * Takes a merge back: the main folder goes back to the commit it was at before. Only while it
   * is still where the merge left it: at that commit, and on the git branch that took the merge.
   * On another branch that stands at the same commit, the step back would move that branch and
   * leave the merge where it is. What is changed in the main folder and not committed stays, and
   * stops the step where it is in the way. The worktree keeps its commits.
   */
  undo(repo: string, merged: { before: string; after: string; target: string }, signal?: AbortSignal): Promise<UndoOutcome> {
    return this.queued(repo, async () => {
      const main = this.git.at(repo, repo)
      if ((await this.targetOf(main, signal)) !== merged.target) return { kind: 'moved' }
      if ((await main.read(['rev-parse', '--verify', 'HEAD^{commit}'], { signal })) !== merged.after) return { kind: 'moved' }
      const back = await main.run(['reset', '--keep', merged.before], { signal, timeoutMs: LONG_MS })
      return back.code === 0 ? { kind: 'undone' } : { kind: 'blocked', detail: (back.stderr.trim() || back.stdout.trim()).slice(-1000) }
    })
  }

  /**
   * Takes a worktree away: its folder, and its git branch. One that holds work the main folder
   * does not have is left alone and told of, unless `discard` says to throw that work away.
   *
   * Git takes the worktree away and leaves standing what it will not delete: a link to another
   * folder, for one, such as a junction to `node_modules`. What is left of the folder is the
   * app's own to take away, and a link in it goes as a link: nothing behind it is touched. A
   * folder that was left of a worktree earlier goes the same way, unless it holds files, which
   * are then nobody's that git knows of: those go only on a yes as well, and are told as files
   * left in it (`left`), not as changes. On the person's yes a lock of theirs goes first, from a
   * worktree that stands or one that is one no more alike (`unlockFirst`).
   */
  remove(info: WorktreeInfo, opts: { discard?: boolean } = {}, signal?: AbortSignal): Promise<RemoveOutcome> {
    return this.queued(info.repo, async () => {
      const state = await this.state(info, signal)
      const stops = opts.discard ? null : await this.keeps(info, state, signal)
      if (stops) return stops

      const main = this.git.at(info.repo, info.repo)
      const folder = this.folderOf(info)
      // Their yes to throwing the work away is their word for a worktree they locked as well.
      if (opts.discard) await this.unlockFirst(main, folder, signal)
      if (!state.gone) {
        const removed = await main.run(['worktree', 'remove', ...(opts.discard ? ['--force'] : []), folder], { signal, timeoutMs: LONG_MS })
        // Where git gave up on throwing work away, on a file it could not delete for one, the folder is taken away below all the same.
        if (removed.code !== 0 && !opts.discard) throw new GitFailed(['worktree', 'remove'], removed)
      }
      await fs.rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch((err: unknown) => {
        throw inUse(err, folder) ?? err
      })
      await main.run(['worktree', 'prune'], { signal })
      const branch = branchOf(info.name)
      if ((await main.run(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { signal })).code === 0) {
        await main.read(['branch', '-D', branch], { signal })
      }
      await this.dropEmptyHolders(info.repo)
      return { kind: 'removed' }
    })
  }

  /**
   * What keeps a worktree from being taken away as it is, unless the person says that it may go:
   * work the main folder does not have, files in what was left of it that git knows nothing of,
   * or their own lock on it (`git worktree lock`, which is their word that it is to stay). Null
   * where nothing does.
   */
  private async keeps(info: WorktreeInfo, state: WorktreeState, signal?: AbortSignal): Promise<Kept | null> {
    const folder = this.folderOf(info)
    if (state.gone) {
      // Told for what they are, files that git cannot tell from changes any more, with what its git branch has beside them.
      const files = await filesIn(folder)
      if (files > 0) return { kind: 'left', files, commits: state.ahead }
    }
    if (hasUnmerged(state)) return { kind: 'unmerged', files: state.files.length, commits: state.ahead }
    // Asked of a worktree that is one no more as well: git keeps a locked one, and its git branch, until it is unlocked.
    const lock = await this.lockOf(this.git.at(info.repo, info.repo), folder, signal)
    return lock === null || lock === 'unknown' ? null : { kind: 'locked', reason: lock.reason }
  }

  /**
   * On the person's yes to throwing a worktree away: a lock of theirs on it goes before anything
   * is deleted. Git keeps what it knows of a locked worktree whose folder is gone (`prune` leaves
   * it), and its git branch could then not be deleted; where git will not say whether there is a
   * lock, or will not take it away, nothing has been touched yet, and that is said. The lock is
   * taken away by the path git knows the worktree by, which git finds it by where its folder, and
   * the folders above that, are gone as well.
   */
  private async unlockFirst(main: GitAt, folder: string, signal?: AbortSignal): Promise<void> {
    const lock = await this.lockOf(main, folder, signal)
    if (lock === null) return
    // A git too old to list its worktrees that way is asked by the folder, and says so where there is no lock to take away.
    const named = lock === 'unknown' ? folder : lock.path
    const unlocked = await main.run(['worktree', 'unlock', named], { signal })
    if (unlocked.code === 0) return
    if (lock === 'unknown' && /is not locked|is not a working tree/.test(unlocked.stderr)) return
    throw notUnlocked(unlocked, named)
  }

  /**
   * What `remove` would answer where nothing is to be thrown away, without anything being done:
   * asked before several conversations are deleted at once, so that all of them go or none.
   */
  removable(info: WorktreeInfo, signal?: AbortSignal): Promise<RemoveOutcome> {
    return this.queued(info.repo, async () => (await this.keeps(info, await this.state(info, signal), signal)) ?? { kind: 'removed' })
  }

  /**
   * Whether a worktree is locked (`Lock`); null where it is not, and `unknown` where git is too old
   * to list its worktrees so (before 2.36), which it says by ending with 129. One whose folder is
   * gone is found as well. Where git cannot list them for another reason, a lock it cannot read,
   * that is thrown (`lockUnknown`).
   */
  private async lockOf(main: GitAt, folder: string, signal?: AbortSignal): Promise<Lock | null | 'unknown'> {
    const listed = await main.run(['worktree', 'list', '--porcelain', '-z'], { signal })
    if (listed.code === 129) return 'unknown'
    if (listed.code !== 0) throw lockUnknown(listed)
    // Git names a worktree by where it really lies, which is another path where the repository was opened through a link.
    const ours = new Set([folderKey(folder, this.windows), folderKey(await reallyAt(folder), this.windows)])
    let here: string | null = null
    for (const line of listed.stdout.split('\0')) {
      if (line.startsWith('worktree ')) {
        const named = line.slice('worktree '.length)
        here = ours.has(folderKey(named, this.windows)) ? named : null
      } else if (here !== null && (line === 'locked' || line.startsWith('locked '))) return { reason: line.slice('locked'.length).trim(), path: here }
    }
    return null
  }

  /**
   * For files of the merge that is open in a worktree: which commits of each side changed them
   * since the two parted (`ClashHistory`), under whatever name a side knows them by. A model that
   * has to ask the person which side a file keeps would otherwise go and ask git, by a command,
   * what each side did. None where no merge is open; the first few files where there are many.
   */
  history(info: WorktreeInfo, files: readonly string[], signal?: AbortSignal): Promise<ClashHistory[]> {
    return this.queued(info.repo, async () => {
      if (!(await this.stands(info))) return []
      const git = this.git.at(info.repo, this.folderOf(info))
      if (!(await this.merging(git, signal))) return []
      // A file that one side renamed is in conflict under its new name, while the other side changed
      // it under the old one: asked by the one name alone, that side would seem to have left the
      // file as it was. So the renames of each side since the two parted are read (three dots: from
      // where they parted), and a file is asked for by every name it goes by. Where git cannot say,
      // files are asked for by the name they are in conflict under.
      const renamedOn = async (since: string): Promise<Renamed[]> => {
        const listed = await git.run(['diff', '-M', '--name-status', '-z', '--diff-filter=R', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', since, '--'], { signal })
        return listed.code === 0 ? readRenames(listed.stdout) : []
      }
      const renames = (await Promise.all([renamedOn('MERGE_HEAD...HEAD'), renamedOn('HEAD...MERGE_HEAD')])).flat()
      const alsoNamed = (file: string): string[] => {
        const names = new Set<string>()
        for (const { from, to } of renames) {
          if (to === file) names.add(from)
          if (from === file) names.add(to)
        }
        names.delete(file)
        return [...names].sort()
      }
      // The worktree's commits are those the main folder's side lacks, and the other way round.
      // Merges are left out: one that brought the main folder's commits in did nothing to the file
      // of its own, and would take the place of a commit that did. A signature is not looked at:
      // that would start the program the settings name for it. Each name is taken as it stands, and
      // not as a pattern.
      const changedBy = async (range: string, names: readonly string[]): Promise<string[]> => {
        const listed = await git.run(
          ['log', '--no-merges', '--no-show-signature', '--format=%h %s', `-n${HISTORY_COMMITS}`, range, '--', ...names.map((name) => `:(literal)${name}`)],
          { signal }
        )
        if (listed.code !== 0) return []
        return listed.stdout.split(/\r?\n/).map(titleTold).filter(Boolean)
      }
      const of = async (file: string): Promise<ClashHistory> => {
        const also = alsoNamed(file)
        const names = [file, ...also]
        const [worktree, main] = await Promise.all([changedBy('MERGE_HEAD..HEAD', names), changedBy('HEAD..MERGE_HEAD', names)])
        return { file, worktree, main, ...(also.length > 0 ? { also } : {}) }
      }
      // These only read, so a few files are asked for at once: one after the other, a merge with a
      // dozen files in conflict took seconds to tell.
      const asked = files.slice(0, HISTORY_FILES)
      const told: ClashHistory[] = []
      for (let from = 0; from < asked.length; from += HISTORY_AT_ONCE) told.push(...(await Promise.all(asked.slice(from, from + HISTORY_AT_ONCE).map(of))))
      return told
    })
  }

  /**
   * Settles a file of the merge that is open in a worktree by what one side has of it: the
   * worktree's own commits, or the main folder's. A side that has no such file, because it
   * deleted it, is kept by deleting the file. Git is given the answer, so the file is in conflict
   * no more; nothing is committed. This is how a file is settled that holds no marks to edit
   * away, and it is done here, by the app's own git, so that no program the repository's
   * settings name is started on the way (a filter runs when a file is checked out or added).
   */
  resolve(info: WorktreeInfo, file: string, keep: MergeSide, signal?: AbortSignal): Promise<ResolveOutcome> {
    return this.queued(info.repo, async () => {
      const folder = this.folderOf(info)
      const gone = await this.howGone(info)
      if (gone) return { kind: 'gone', folder: gone }
      const git = this.git.at(info.repo, folder)
      if (!(await this.merging(git, signal))) return { kind: 'no-merge' }
      const named = pathInTree(file)
      if (!named) throw new Error('Name the file by its path from the root of the worktree, without ".." in it.')
      // The name as it stands, and not as a pattern: a file can be called `*.png`.
      const spec = `:(literal)${named}`
      // Each line: the mode, the object, which of the three versions it is (1 before both, 2 the worktree's, 3 the main folder's), a tab, the path.
      const listed = await git.read(['ls-files', '-u', '-z', '--', spec], { signal })
      const entries = listed
        .split('\0')
        .filter(Boolean)
        .map((entry) => ({ version: entry.slice(0, entry.indexOf('\t')).split(' ')[2], path: entry.slice(entry.indexOf('\t') + 1) }))
      if (entries.length === 0) return { kind: 'not-in-conflict', file: named }
      // Taken as it stands, the name of a folder still fits every file under it, and the two commands
      // below would go through all of them: a text already edited into its result would be put back
      // to one side's version. So one file is settled at a time, and it has to be named itself.
      const files = [...new Set(entries.map((entry) => entry.path))].sort()
      if (files.some((path) => path !== named)) return { kind: 'folder', file: named, files }
      const versions = new Set(entries.map((entry) => entry.version))

      const has = versions.has(keep === 'worktree' ? '2' : '3')
      if (has) {
        await git.read(['checkout', keep === 'worktree' ? '--ours' : '--theirs', '--', spec], { signal, timeoutMs: LONG_MS })
        await git.read(['add', '--', spec], { signal, timeoutMs: LONG_MS })
      } else {
        await git.read(['rm', '-q', '-f', '--', spec], { signal, timeoutMs: LONG_MS })
      }
      return { kind: 'settled', file: named, keep, deleted: !has }
    })
  }

  /** Takes the folders that hold the worktrees away, once they hold nothing: a repository with no worktree of the app's has nothing of the app's in it. */
  private async dropEmptyHolders(repo: string): Promise<void> {
    const holder = worktreesFolder(repo, this.windows)
    await fs.rmdir(holder).catch(() => {})
    await fs.rmdir(path.dirname(holder)).catch(() => {})
  }
}
