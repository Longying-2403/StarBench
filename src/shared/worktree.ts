// A worktree of the app's making: a second checkout of a repository, in a folder of its own
// inside the repository, on a git branch of its own. A conversation that works in one changes
// that copy and not the folder the person works in, until its work is merged back.
//
// Here is what the page and the main process both go by: how a worktree is named, where it lies,
// and how what git tells of it is read. Git itself is run in the main process only (main/git.ts,
// main/worktrees.ts).

/** The folder of the app's own in a repository. Git is told to leave it alone (`EXCLUDE_LINE`). */
export const APP_FOLDER = '.starbench'
/** The folder in it that holds the worktrees, one folder each. */
export const WORKTREES_FOLDER = 'worktrees'
/** What the name of a worktree's git branch begins with: `starbench/<name>`. */
export const BRANCH_PREFIX = 'starbench/'
/**
 * The line in `.git/info/exclude` that keeps the app's folder out of `git status` and out of
 * `git add`. Without it a `git add -A` in the repository would take every worktree in as a
 * repository of its own.
 */
export const EXCLUDE_LINE = `/${APP_FOLDER}/`

/** What a conversation keeps of the worktree it works in. The worktree's folder is the conversation's `workspace`. */
export interface WorktreeInfo {
  /** The repository it is a worktree of: the folder the person chose for the conversation. */
  repo: string
  /** Its name: the folder under `.starbench/worktrees`, and what follows `starbench/` in the name of its git branch. */
  name: string
  /** The commit it was started from. */
  base: string
}

/** Whether a path names a folder in full, as Windows or any other system writes one. */
const inFull = (folder: string): boolean => /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(folder)
/** The name git gives a commit, whole or shortened. */
const COMMIT = /^[0-9a-f]{7,64}$/

/**
 * The worktree a conversation's file says it works in, where what the file says reads like one.
 * A file can be changed by hand, and the app runs git in the folder that is named here: so the
 * repository has to be named in full, the name has to be one a worktree can have, and nothing
 * else of what the file says is taken along.
 */
export function readWorktree(value: unknown): WorktreeInfo | undefined {
  const told = typeof value === 'object' && value !== null ? (value as Partial<WorktreeInfo>) : null
  if (!told || typeof told.repo !== 'string' || !inFull(told.repo) || !isWorktreeName(told.name) || typeof told.base !== 'string' || !COMMIT.test(told.base)) return undefined
  return { repo: told.repo, name: told.name, base: told.base }
}

/** How long the name of a worktree may be. */
export const WORKTREE_NAME_LIMIT = 40

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
/** The names Windows keeps for its devices: no folder can have one. */
const DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/

/**
 * Whether a text can name a worktree: small letters, digits and hyphens, beginning and ending
 * with a letter or a digit. The same text names a folder and a git branch, and is typed into
 * commands, so it is kept to what all of them take as it is written.
 */
export function isWorktreeName(value: unknown): value is string {
  return typeof value === 'string' && NAME.test(value) && !DEVICE.test(value)
}

/** What the person typed, made into a name as far as that can be done: empty when nothing of it can stand in one. */
export function tidyWorktreeName(text: string): string {
  const tidy = text
    .toLowerCase()
    .replace(/[\s_./\\]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, WORKTREE_NAME_LIMIT)
    .replace(/-+$/, '')
  return isWorktreeName(tidy) ? tidy : ''
}

/**
 * A name for a new worktree where the person gave none: the day, and a number that no worktree
 * of that day has yet (`1125-1`, `1125-2`). `taken` holds the names in use.
 */
export function suggestWorktreeName(taken: readonly string[], now: Date = new Date()): string {
  const two = (n: number): string => String(n).padStart(2, '0')
  const day = `${two(now.getMonth() + 1)}${two(now.getDate())}`
  const used = new Set(taken)
  for (let n = 1; ; n++) {
    const name = `${day}-${n}`
    if (!used.has(name)) return name
  }
}

/** The name of the git branch a worktree is on. */
export const branchOf = (name: string): string => `${BRANCH_PREFIX}${name}`

/** A folder path without separators at its end, and the separator its system writes. */
function rooted(folder: string, windows: boolean): { root: string; sep: string } {
  return { root: folder.replace(/[\\/]+$/, ''), sep: windows ? '\\' : '/' }
}

/** Where the worktrees of a repository lie. */
export function worktreesFolder(repo: string, windows: boolean): string {
  const { root, sep } = rooted(repo, windows)
  return [root, APP_FOLDER, WORKTREES_FOLDER].join(sep)
}

/** The folder of one worktree. */
export function worktreeFolder(repo: string, name: string, windows: boolean): string {
  return `${worktreesFolder(repo, windows)}${windows ? '\\' : '/'}${name}`
}

/**
 * Which repository a folder is a worktree of, and under what name, as far as its path tells:
 * the reverse of `worktreeFolder`. Null for any other folder.
 */
export function worktreeOfFolder(folder: string, windows: boolean): { repo: string; name: string } | null {
  const parts = folder.replace(/[\\/]+$/, '').split(windows ? /[\\/]/ : /\//)
  if (parts.length < 4) return null
  const [app, holder, name] = parts.slice(-3)
  const same = (a: string, b: string): boolean => (windows ? a.toLowerCase() === b.toLowerCase() : a === b)
  if (!same(app, APP_FOLDER) || !same(holder, WORKTREES_FOLDER) || !isWorktreeName(name)) return null
  const repo = parts.slice(0, -3).join(windows ? '\\' : '/')
  return repo ? { repo, name } : null
}

/**
 * The folder a conversation belongs to in the list: the repository, for one that works in a
 * worktree, and its own folder otherwise. Trust, the notes of the workspace and its place in the
 * sidebar go by this folder, so that a worktree is not a workspace of its own.
 */
export function projectFolder(session: { workspace: string; worktree?: Pick<WorktreeInfo, 'repo'> }): string {
  return session.worktree?.repo || session.workspace
}

/** A file that is not as it was, and how it differs. */
export interface ChangedFile {
  /** From the root of the repository, with forward slashes, as git writes it. */
  path: string
  change: 'added' | 'modified' | 'deleted'
  /** Both sides of a merge changed it, and the merge is not finished. */
  conflict?: true
  /**
   * For such a file, how the two sides stand, in git's two letters: `UU` where both changed it,
   * `AA` where both added it, and others (`UD`, `DU`, …) where a side deleted or moved it. Only
   * in the first two can git have written the marks of a conflict into the file.
   */
  sides?: string
}

/**
 * Reads `git status --porcelain=v1 -z --no-renames`: one entry for each path that is not as the
 * last commit has it. An entry is two letters, a space and the path, and ends with a NUL.
 */
export function readStatus(text: string): ChangedFile[] {
  const files: ChangedFile[] = []
  for (const entry of text.split('\0')) {
    if (entry.length < 4) continue
    const [x, y] = entry
    const path = entry.slice(3)
    // Both sides of a merge have something to say of the path: U on either side, or added or deleted by both.
    const conflict = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')
    const change = x === '?' || x === 'A' ? 'added' : x === 'D' || y === 'D' ? 'deleted' : 'modified'
    files.push(conflict ? { path, change: 'modified', conflict: true, sides: `${x}${y}` } : { path, change })
  }
  return files
}

/**
 * Reads `git diff --name-status -z --no-renames`: a letter, a NUL, the path, a NUL, and so on.
 */
export function readNameStatus(text: string): ChangedFile[] {
  const parts = text.split('\0')
  const files: ChangedFile[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const letter = parts[i][0]
    const path = parts[i + 1]
    if (!letter || !path) continue
    files.push({ path, change: letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified' })
  }
  return files
}

/**
 * How a worktree is one no more. Its folder is `missing`: deleted by hand, or moved away, and
 * what was changed in it and not committed went with it. Or the folder is `left`: it is still
 * there, and so are the files in it, but the `.git` file that git wrote into it is gone, or names
 * no worktree of this repository, so git takes it for no worktree and is not run in it. Which of
 * the two it is matters to whoever is told: in the second, nothing written in it was lost.
 */
export type GoneFolder = 'missing' | 'left'

/** How a worktree stands against the folder its work is merged into. */
export interface WorktreeState {
  /** The worktree is one no more (`GoneFolder`); false while it is. What it had committed is still told, by its git branch. */
  gone: false | GoneFolder
  /** Paths changed in the worktree and not committed. */
  uncommitted: number
  /** Commits the worktree has that the main folder does not. */
  ahead: number
  /** Commits the main folder has that the worktree does not. */
  behind: number
  /** Every file the worktree has changed since the two parted, committed or not. */
  files: ChangedFile[]
  /** The git branch the main folder is on, which a merge goes into. Null while it is on none. */
  target: string | null
  /** A merge begun in the worktree is not finished: the files both sides changed. */
  conflicts: string[]
}

/** Whether a worktree holds work that the main folder does not have: deleting it would lose that. */
export const hasUnmerged = (state: Pick<WorktreeState, 'uncommitted' | 'ahead'>): boolean => state.uncommitted > 0 || state.ahead > 0

/** What a merge that went through left: enough to show it, and to take it back. */
export interface Merged {
  /** The commit the main folder was at before, and the one it is at now. */
  before: string
  after: string
  /** The git branch of the main folder that took the work. */
  target: string
  files: ChangedFile[]
  /** How many commits came with it. */
  commits: number
}

/**
 * How bringing a worktree's work into the main folder ended. The main folder is only ever moved
 * forward to a commit of the worktree's: where the two have both moved on, the main folder's
 * commits are merged into the worktree first, so a clash is found and solved there.
 */
export type MergeOutcome =
  | ({ kind: 'merged' } & Merged)
  /** The worktree has nothing the main folder lacks. */
  | { kind: 'nothing' }
  /** The main folder has moved on, and what it changed clashes with the worktree's changes in these files. Nothing was changed. */
  | { kind: 'conflict'; files: string[] }
  /**
   * These files of the main folder are changed and not committed, or lie where the merge would
   * put a new file (also ones git ignores, which it would write over without a word), and the
   * merge would write over them. Nothing was changed.
   */
  | { kind: 'blocked'; files: string[] }
  /**
   * A merge begun in the worktree is not finished: `files` still hold its marks, and `undecided`
   * are in conflict without marks to go by (a binary file, a file one side deleted) and are as the
   * merge left them, so that nobody has said which side they keep.
   */
  | { kind: 'unfinished'; files: string[]; undecided: string[] }
  /** The main folder is on no git branch. */
  | { kind: 'detached' }
  /** The main folder is in the middle of a merge or the like of its own. */
  | { kind: 'busy' }
  /** The worktree is one no more (`GoneFolder`). */
  | { kind: 'gone'; folder: GoneFolder }

/** How bringing the main folder's commits into a worktree ended. */
export type UpdateOutcome =
  /** The worktree had them all. */
  | { kind: 'current' }
  | { kind: 'updated'; commit: string }
  /**
   * Both changed these files. Unless it was asked to be given up, the merge is left open in the
   * worktree, with its marks in the files. `undecided` are those of them that took no marks: a
   * binary file, or a file one side deleted. For those a side has to be chosen with git.
   */
  | { kind: 'conflict'; files: string[]; undecided: string[]; open: boolean }
  /** The worktree has changes that are not committed: they are committed first. */
  | { kind: 'dirty'; files: number }
  /** The worktree is one no more (`GoneFolder`). */
  | { kind: 'gone'; folder: GoneFolder }

/** At most this many files are kept with the record of a merge; `fileCount` says how many there were. */
export const MERGE_FILES_KEPT = 200

/** A merge as a conversation keeps it: enough to show it where it was made, and to take it back. */
export interface MergeRecord extends Merged {
  /** Tells it from the other merges of the conversation. */
  id: string
  /** When it was made, in milliseconds since 1970. */
  at: number
  /** How many messages of the person the conversation held by then: the record is shown at the end of that turn. */
  turn: number
  /** How many files it changed. `files` holds the first of them (`MERGE_FILES_KEPT`). */
  fileCount: number
  /** When it was taken back, where it was. */
  undone?: number
}

/** A merge as it is written down with its conversation. */
export function mergeRecord(merged: Merged, id: string, at: number, turn: number): MergeRecord {
  const { before, after, target, files, commits } = merged
  return { id, at, turn, before, after, target, commits, fileCount: files.length, files: files.slice(0, MERGE_FILES_KEPT) }
}

/** How many merges a conversation keeps of its worktree: the oldest give way. */
export const MERGES_KEPT = 100

/**
 * The merges a conversation's file holds, each as the app writes it; what does not read like one
 * is left out. Taking a merge back moves the main folder to the commit named in it, so the two
 * commits have to read like commits.
 */
export function readMerges(value: unknown): MergeRecord[] {
  const text = (part: unknown): part is string => typeof part === 'string' && part !== ''
  const count = (part: unknown): number => (typeof part === 'number' && Number.isFinite(part) && part >= 0 ? Math.floor(part) : 0)
  const merges: MergeRecord[] = []
  for (const entry of Array.isArray(value) ? value : []) {
    const told = typeof entry === 'object' && entry !== null ? (entry as Partial<MergeRecord>) : null
    if (!told || !text(told.id) || !text(told.target) || !COMMIT.test(String(told.before)) || !COMMIT.test(String(told.after)) || typeof told.at !== 'number') continue
    const files = (Array.isArray(told.files) ? told.files : []).filter(
      (file): file is ChangedFile => typeof file === 'object' && file !== null && text(file.path) && (file.change === 'added' || file.change === 'modified' || file.change === 'deleted')
    )
    merges.push({
      id: told.id,
      at: told.at,
      turn: count(told.turn),
      before: String(told.before),
      after: String(told.after),
      target: told.target,
      commits: count(told.commits),
      fileCount: Math.max(count(told.fileCount), files.length),
      files: files.slice(0, MERGE_FILES_KEPT).map((file) => ({ path: file.path, change: file.change })),
      ...(typeof told.undone === 'number' ? { undone: told.undone } : {})
    })
  }
  return merges.slice(-MERGES_KEPT)
}

/** How taking a merge back ended. */
export type UndoOutcome =
  | { kind: 'undone' }
  /**
   * The main folder is no longer where the merge left it: something was committed since, or it
   * is on another git branch now (or on none), and that one is not the merge's to move.
   */
  | { kind: 'moved' }
  /** Changes of the main folder that are not committed are in the way; `detail` is what git said. */
  | { kind: 'blocked'; detail: string }

/** How removing a worktree ended. */
export type RemoveOutcome =
  | { kind: 'removed' }
  /** It holds work the main folder does not have, and was not told to throw that away. */
  | { kind: 'unmerged'; files: number; commits: number }
  /**
   * Its folder is what was left of it (`GoneFolder`), and still holds files: git knows nothing of
   * them, so which of them are changes nobody can tell, and they go only on the person's yes.
   * `files` is how many there are, as far as `LEFT_COUNTED`; `commits`, what its git branch has
   * that the main folder does not. Nothing was changed.
   */
  | { kind: 'left'; files: number; commits: number }
  /**
   * Git may not be run in its repository: the person took their yes back. A worktree is not taken
   * away without git, so nothing was changed. Told by the page's way in (main/worktree-ipc.ts).
   */
  | { kind: 'not-allowed' }
  /**
   * The person locked it themselves (`git worktree lock`), which is their word that it is to
   * stay: it goes only once they say so. `reason` is what they wrote when they locked it, empty
   * where they wrote nothing. Nothing was changed.
   */
  | { kind: 'locked'; reason: string }

/** What keeps a worktree from going with its conversation unasked: the person is asked first. */
export type Kept = Extract<RemoveOutcome, { kind: 'unmerged' | 'left' | 'locked' }>

/** As many files as are counted in what was left of a worktree: enough to say that there are some. */
export const LEFT_COUNTED = 1000

/** How many files are left in such a folder, in words: where the count stopped (`LEFT_COUNTED`), at least that many. */
export const leftFiles = (files: number): string => (files >= LEFT_COUNTED ? `${LEFT_COUNTED} 个以上的文件` : `${files} 个文件`)

/**
 * What the person is told where a conversation is not deleted because its worktree is still there
 * and git may not be run in its repository (`not-allowed`), in the language of the app: git itself
 * would refuse in English, without saying where the yes is given again. That is the bar above the
 * message box of the conversation. `title`: the conversation is named, as it is where a whole
 * workspace was to be deleted, which is then what is deleted after.
 */
export function notAllowedText(name: string, title?: string): string {
  const who = title === undefined ? '这个会话' : `会话“${title}”`
  const then = title === undefined ? '再删除' : '再删除这个工作区'
  return `${who}在 worktree「${name}」里进行，删掉它要运行 git，而你在设置里收回了对这个仓库的允许。打开这个会话，在输入框上面那条栏里点“允许运行 git…”，${then}。`
}

/**
 * What the person is told where git was not found on this computer, in the language of the app:
 * the same wherever it is said, when git is refused (main/git.ts) and on the Worktree switch.
 */
export const GIT_MISSING = '没有找到 git。安装 Git，并确认 git.exe 所在的文件夹在 PATH 里，然后重新启动 StarBench。'

/** Which side of a merge a file keeps: the worktree's own commits, or the main folder's. */
export type MergeSide = 'worktree' | 'main'

/**
 * For a file of the merge that is open in a worktree: the commits of each side that changed it
 * since the two parted, the newest first, each as its short name and its first line. A few of
 * them, so that whoever has to say which side the file keeps can be told what each side did.
 * Commits that are themselves merges are not among them: one that brought the main folder's
 * commits into the worktree changed the file by what the main folder did, not by work of its own.
 */
export interface ClashHistory {
  file: string
  worktree: string[]
  main: string[]
  /**
   * The other names the file goes by, where a side renamed or moved it since the two parted. It
   * is in conflict under one name, and the side that did not move it changed it under the other:
   * the commits are those that changed it under any of them.
   */
  also?: string[]
}

/** As many files as that is told of at once, and as many commits of each side for a file. */
export const HISTORY_FILES = 12
export const HISTORY_COMMITS = 2

/** A file that was renamed or moved: its name before, and its name after. */
export interface Renamed {
  from: string
  to: string
}

/**
 * Reads `git diff --name-status -z` where renames are looked for: a rename is its letter with how
 * alike the two files are (`R087`), a NUL, the name before, a NUL, the name after, a NUL. Every
 * other change is a letter, a NUL and one path, and is passed over.
 */
export function readRenames(text: string): Renamed[] {
  const parts = text.split('\0')
  const renames: Renamed[] = []
  for (let i = 0; i < parts.length; ) {
    const letter = parts[i][0]
    // A rename and a copy name two paths.
    const paths = letter === 'R' || letter === 'C' ? 2 : 1
    if (letter === 'R' && parts[i + 1] && parts[i + 2]) renames.push({ from: parts[i + 1], to: parts[i + 2] })
    i += letter ? 1 + paths : 1
  }
  return renames
}

/** How settling a file of the merge that is open in a worktree ended (`Worktrees.resolve`). */
export type ResolveOutcome =
  /** Git has the answer, and the file is in conflict no more. `deleted`: the side that was kept has no such file, so there is none now. */
  | { kind: 'settled'; file: string; keep: MergeSide; deleted: boolean }
  /** The file is not in conflict: it never was, or was settled before. */
  | { kind: 'not-in-conflict'; file: string }
  /**
   * What was named is a folder, and one file is settled at a time: settling a folder would put
   * one side's version over every file in it, one that was edited into its result among them.
   * `files` are the files in conflict under it. Nothing was changed.
   */
  | { kind: 'folder'; file: string; files: string[] }
  /** No merge is open in the worktree. */
  | { kind: 'no-merge' }
  /** The worktree is one no more (`GoneFolder`). */
  | { kind: 'gone'; folder: GoneFolder }

/** What a folder is to git, as far as a new chat in it needs to know. Told without running git. */
export interface RepoInfo {
  /**
   * The `main` folder of a repository, a folder `linked` to one (a worktree someone made, or a
   * module of another repository), or `none` of it. The app makes worktrees from a main folder.
   */
  kind: 'main' | 'linked' | 'none'
  /** Git is installed where the app finds it. */
  git: boolean
  /** The person said git may be run in this repository. */
  allowed: boolean
  /** The names that worktrees of the app's have there. */
  taken: string[]
  /** A name for a new one, where the person gives none. */
  suggested: string
}

/**
 * The page's way to the worktrees (main/worktree-ipc.ts). What changes the settings resolves with
 * them as they are then; `Told` stands for the settings as the page holds them, so that this file
 * needs to know nothing of the rest of the app.
 */
export interface WorktreeApi<Told = unknown> {
  /** What a folder is to git. Asked of a folder a new chat is about to be in. */
  repo(folder: string): Promise<RepoInfo>
  /** The person's yes to git being run in a repository, which is a folder they trusted before. */
  allow(folder: string): Promise<Told>
  /** Takes that back: the next worktree there asks again. Worktrees that are there stay. */
  forget(folder: string): Promise<Told>
  /** How the worktree of a conversation stands against the main folder. Null for a conversation that works in none. */
  state(sessionId: string): Promise<WorktreeState | null>
  /** Brings the work of a conversation's worktree into the main folder. Not while a turn of the conversation is under way. */
  merge(sessionId: string): Promise<MergeOutcome>
  /** Takes one merge of a conversation back. */
  undo(sessionId: string, mergeId: string): Promise<UndoOutcome>
  /**
   * Takes the worktree of a conversation away, before the conversation itself is deleted. One that
   * holds work the main folder does not have is left alone and told of, unless `discard` says to
   * throw that work away. Resolves with `removed` for a conversation that works in none.
   */
  remove(sessionId: string, opts?: { discard?: boolean }): Promise<RemoveOutcome>
}
