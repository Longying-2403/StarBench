// What the page shows of worktrees (shared/worktree.ts): the switch that puts a new chat into
// one, the question before git is run in a repository for the first time, what the bar above the
// message box says of the worktree a conversation works in, the record a merge leaves in the
// conversation, and the question before a conversation is deleted with work in its worktree
// that was not merged.

import { useEffect, useRef, useState } from 'react'
import { whenExact, whenText } from '../../shared/when.ts'
import { GIT_MISSING, hasUnmerged, isWorktreeName, leftFiles, tidyWorktreeName } from '../../shared/worktree.ts'
import type { ChangedFile, GoneFolder, Kept, MergeOutcome, MergeRecord, RepoInfo, UndoOutcome, WorktreeInfo, WorktreeState } from '../../shared/worktree.ts'
import { BranchIcon, FolderIcon, MergeIcon, PencilIcon, ResetIcon, WarningIcon } from './icons.tsx'
import { Notice } from './Notice.tsx'
import type { ToastInput } from '../../shared/toasts.ts'
import { errorText } from './util.ts'

/** As many names of files as a notice holds; the rest is counted. */
const NAMES_SHOWN = 4

function named(files: readonly string[]): string {
  const shown = files.slice(0, NAMES_SHOWN).join('、')
  return files.length > NAMES_SHOWN ? `${shown} 等 ${files.length} 个文件` : shown
}

/**
 * What is said of a worktree that is one no more (`WorktreeState.gone`), in a few words and at
 * length, by which of the two it is: its folder is not there, or is still there, files and all,
 * and git takes it for no worktree. In the second nothing written in it was lost.
 */
const GONE_LABEL: Record<GoneFolder, string> = { missing: 'worktree 文件夹不在了', left: 'worktree 文件夹还在，但已经失效' }
const GONE_WORDS: Record<GoneFolder, string> = {
  missing: '这个会话的 worktree 文件夹已经不在了（被删掉或移走了），里面还没提交的改动也跟着一起不在了。已经提交的内容还在它的 git 分支上。',
  left: '这个会话的 worktree 文件夹还在，里面的文件也都在，但 git 写在里面的 .git 文件不见了（或者指向的不是这个仓库），git 不再把它当作 worktree，所以不能再提交或合并。'
}

/** What the person is told of a merge that did not go through. Nothing for one that did: the conversation shows that one itself. */
export function mergeNotice(outcome: MergeOutcome): ToastInput | null {
  switch (outcome.kind) {
    case 'merged':
      return null
    case 'nothing':
      return { title: '没有可以合并的改动', text: '主文件夹已经有这个 worktree 提交过的全部内容。' }
    case 'conflict':
      return {
        kind: 'warning',
        sticky: true,
        title: '有冲突，没有合并',
        text: `主文件夹之后有了新的提交，和这里的改动在这些文件上冲突：${named(outcome.files)}。两边都没有动。可以让模型处理：对它说“把主文件夹的提交并进来，解决冲突”，之后再合并。`
      }
    case 'blocked':
      return {
        kind: 'warning',
        sticky: true,
        title: '主文件夹里有文件会被覆盖，没有合并',
        text: `这些文件在主文件夹里改过还没提交，或者挡在要新增的文件的位置上（被 git 忽略的文件也算），合并会覆盖它们：${named(outcome.files)}。先把它们提交或移开，再合并。`
      }
    case 'unfinished': {
      const marked = outcome.files.length > 0 ? `这些文件里还留着冲突标记：${named(outcome.files)}。` : ''
      // No marks to edit away: a binary file, or one that a side deleted. Nobody has said which side it keeps.
      const undecided = outcome.undecided.length > 0 ? `这些文件有冲突，但没有标记可改（二进制文件，或者有一边把它删了），还没有选定保留哪一边：${named(outcome.undecided)}。` : ''
      return {
        kind: 'warning',
        sticky: true,
        title: 'worktree 里有一次合并还没完成',
        text: `${marked}${undecided}让模型解决并提交之后再合并。`
      }
    }
    case 'detached':
      return { kind: 'warning', sticky: true, title: '主文件夹不在任何 git 分支上，没有合并', text: '主文件夹现在是“游离的 HEAD”。先在主文件夹里切回一个分支。' }
    case 'busy':
      return { kind: 'warning', sticky: true, title: '主文件夹自己正合并到一半，没有合并', text: '主文件夹里有一次合并、变基或类似的操作还没完成。先把它做完或放弃。' }
    case 'gone':
      return { kind: 'warning', sticky: true, title: `${GONE_LABEL[outcome.folder]}，没有合并`, text: GONE_WORDS[outcome.folder] }
  }
}

/** What the person is told of a merge that could not be taken back. Nothing for one that was. */
export function undoNotice(outcome: UndoOutcome): ToastInput | null {
  if (outcome.kind === 'undone') return null
  if (outcome.kind === 'moved') return { kind: 'warning', sticky: true, title: '这次合并不能撤回了', text: '主文件夹已经不在这次合并停下的地方：之后有了新的提交，或者换到了别的 git 分支。' }
  return { kind: 'warning', sticky: true, title: '没有撤回', text: `主文件夹里有未提交的改动挡着。git 的说明：${outcome.detail || '（没有说明）'}` }
}

/**
 * The switch in the bar above the message box of a new chat, right of its folder, for a folder
 * that is a repository: on, the chat works in a worktree of that name, which is made as its
 * first message is sent. The name is proposed and can be changed.
 */
export function WorktreeSwitch({
  repo,
  on,
  name,
  onToggle,
  onName
}: {
  repo: RepoInfo
  on: boolean
  /** The name of the worktree to be made. */
  name: string
  onToggle: (on: boolean) => void
  onName: (name: string) => void
}) {
  /** What is being typed as the name; null while it is not being changed. */
  const [draft, setDraft] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const editing = draft !== null
  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus({ preventScroll: true })
    inputRef.current?.select()
  }, [editing])

  const taken = repo.taken.includes(name)
  const commit = (): void => {
    const tidy = tidyWorktreeName(draft ?? '')
    setDraft(null)
    // What cannot be a name leaves the one it had.
    if (tidy) onName(tidy)
  }

  const tip = !repo.git
    ? `${GIT_MISSING}之后就可以使用 worktree。`
    : on
      ? '这个会话会在仓库的一个 worktree 里进行：模型改的是仓库的一份副本，做完再合并回来。再点一次关闭。'
      : '让这个会话在仓库的一个 worktree 里进行：模型改的是仓库的一份副本，做完再合并回来。'
  return (
    <>
      <button type="button" className="wt-switch" role="switch" aria-checked={on} aria-label="在 worktree 里进行" data-tip={tip} disabled={!repo.git} onClick={() => onToggle(!on)}>
        <BranchIcon />
        <span>Worktree</span>
        <span className="wt-track" aria-hidden="true" />
      </button>
      {on &&
        (editing ? (
          <input
            ref={inputRef}
            className="wt-name-input"
            value={draft}
            aria-label="worktree 的名字"
            maxLength={60}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              // While an IME is composing, Enter confirms its candidate, not the name.
              if (e.nativeEvent.isComposing) return
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') setDraft(null)
            }}
          />
        ) : (
          <button
            type="button"
            className="wt-name"
            data-taken={taken ? '' : undefined}
            aria-label={`worktree 的名字：${name}，点击修改`}
            data-tip={taken ? `已经有一个叫 ${name} 的 worktree 或 git 分支了，换一个名字。` : '这个 worktree 的名字，也是它的 git 分支 starbench/… 的名字。点击修改：小写字母、数字和连字符。'}
            onClick={() => setDraft(name)}
          >
            <span>{name}</span>
            {taken ? <WarningIcon /> : <PencilIcon />}
          </button>
        ))}
    </>
  )
}

/**
 * The question before git is run in a repository for the first time: asked when the switch is
 * turned on there. It looks and works like the question about a folder (TrustDialog.tsx), and
 * the no has the keyboard.
 */
export function GitDialog({ folder, onAllow, onCancel }: { folder: string; onAllow: () => Promise<void>; onCancel: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // The question sits on top of everything, so Escape answers it with a no and reaches nothing underneath.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  const allow = (): void => {
    setBusy(true)
    setError('')
    onAllow().catch((err: unknown) => {
      setBusy(false)
      setError(errorText(err))
    })
  }

  return (
    <div className="overlay">
      <div className="dialog dialog-small" role="alertdialog" aria-modal="true" aria-labelledby="git-title" aria-describedby="git-text">
        <h2 id="git-title">允许在这个仓库里运行 git 吗？</h2>
        <div className="trust-path" data-tip={folder}>
          <FolderIcon />
          <span>{folder}</span>
        </div>
        <p id="git-text" className="plan-text">
          建立和合并 worktree 要运行 git。git 会按这个仓库自己的配置运行程序，例如钩子和过滤器。StarBench 运行 git 时会关掉钩子，不运行仓库配置里指定的程序，只做本地操作，不推送也不拉取。
        </p>
        <p className="hint">只对你了解来历的仓库这样做。之后可以在 设置 → 通用 里收回。</p>
        {error && <Notice role="alert">{error}</Notice>}
        <div className="dialog-actions">
          <button type="button" className="btn" autoFocus disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={allow}>
            允许运行 git
          </button>
        </div>
      </div>
    </div>
  )
}

/** How a worktree stands, in a few words for the bar, and at length for whoever asks. */
function stateWords(state: WorktreeState | null): { label: string; tip: string; warn?: true } {
  if (!state) return { label: '', tip: '' }
  if (state.gone) return { label: GONE_LABEL[state.gone], tip: `${GONE_WORDS[state.gone]}删除这个会话时，如果还留着文件或没合并的提交，会先问你。`, warn: true }
  const parts = [`未提交：${state.uncommitted} 个文件`, `还没合并的提交：${state.ahead} 个`, `主文件夹有而这里没有的提交：${state.behind} 个`]
  if (state.conflicts.length > 0) return { label: `有一次合并还没完成（${state.conflicts.length} 个文件冲突）`, tip: parts.join('\n'), warn: true }
  // Said the same of a worktree nothing was done in yet and of one whose work was all merged: neither has anything to merge.
  if (!hasUnmerged(state)) return { label: '没有未合并的改动', tip: parts.join('\n') }
  // Commits that leave every file as the main folder has it (a clash settled its way) are still commits to merge.
  return { label: state.files.length > 0 ? `${state.files.length} 个文件有改动` : `${state.ahead} 个提交还没合并`, tip: parts.join('\n') }
}

/**
 * What the bar above the message box says of a conversation that works in a worktree: the
 * repository and the worktree, how many files it has changed, and the button that brings its
 * work into the main folder.
 */
export function WorktreePlace({
  repoName,
  folder,
  info,
  state,
  problem,
  running,
  merging,
  onMerge,
  onAllow
}: {
  /** The repository, by the name its workspace goes by. */
  repoName: string
  /** The folder of the worktree. */
  folder: string
  info: WorktreeInfo
  /** Null until it has been asked for. */
  state: WorktreeState | null
  /** Why it could not be asked for, where it could not: git was not allowed in the repository any more, for one. */
  problem: string
  /** A turn of the conversation is under way. */
  running: boolean
  /** A merge the person asked for is under way. */
  merging: boolean
  onMerge: () => void
  /**
   * There when git may not be run in the repository any more: the person took their yes back in
   * the settings. Nothing can be told or done of the worktree until they give it again, which
   * this asks them for.
   */
  onAllow?: () => void
}) {
  const words: ReturnType<typeof stateWords> = onAllow
    ? { label: '这个仓库里现在不能运行 git', tip: '你在设置里收回了允许。worktree 还在，重新允许之后才能查看状态、合并或删除。', warn: true }
    : problem
      ? { label: '看不了 worktree 的状态', tip: problem, warn: true }
      : stateWords(state)
  const nothing = state !== null && !state.gone && !hasUnmerged(state)
  /** What the button does, or why it cannot be pressed just now. */
  const why = ((): string => {
    if (problem) return `看不了 worktree 的状态：${problem}`
    if (!state) return '正在查看 worktree 的状态…'
    if (state.gone) return `${GONE_LABEL[state.gone]}，不能合并。`
    if (!state.target) return '主文件夹不在任何 git 分支上，不能合并。'
    if (running) return '这一轮结束后才能合并。'
    if (merging) return '正在合并…'
    if (nothing) return '这个 worktree 里没有主文件夹还没有的改动。'
    return `把这个 worktree 的改动合并进主文件夹的 ${state.target} 分支。没提交的改动会先提交；主文件夹里没提交的改动不会被覆盖。`
  })()
  const disabled = !state || state.gone !== false || !state.target || running || merging || nothing
  return (
    <>
      <span className="composer-place" data-tip={`工作文件夹：${folder}\ngit 分支：starbench/${info.name}`}>
        <FolderIcon />
        <span>{repoName}</span>
        <span className="wt-sep" aria-hidden="true">
          ›
        </span>
        <BranchIcon />
        <span className="wt-place-name">{info.name}</span>
      </span>
      {words.label && (
        <span className="wt-state" data-warn={words.warn ? '' : undefined} data-tip={words.tip}>
          {words.label}
        </span>
      )}
      {onAllow ? (
        <button type="button" className="wt-merge" data-tip="重新允许 StarBench 在这个仓库里运行 git。" onClick={onAllow}>
          允许运行 git…
        </button>
      ) : (
        <button type="button" className="wt-merge" disabled={disabled} data-tip={why} onClick={onMerge}>
          <MergeIcon />
          {merging ? '正在合并…' : `合并到 ${state?.target ?? '主文件夹'}`}
        </button>
      )}
    </>
  )
}

const CHANGE_WORDS: Record<ChangedFile['change'], string> = { added: '新', modified: '改', deleted: '删' }

/**
 * The record a merge leaves in the conversation, at the end of the turn it was made in: what was
 * merged where, the files on request, and the way to take it back. Once taken back it says so,
 * and offers nothing.
 */
export function MergeLine({
  record,
  now,
  focus,
  faded,
  onUndo
}: {
  record: MergeRecord
  now: number
  /**
   * Not 0 for the record the person asked to see, from the notice in the corner: it opens and
   * comes into view. The number counts the askings, so that asking again brings it into view again.
   */
  focus: number
  faded: boolean
  onUndo: (record: MergeRecord) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!focus) return
    setOpen(true)
    rowRef.current?.scrollIntoView({ block: 'center' })
  }, [focus])

  if (record.undone !== undefined) {
    return (
      <div ref={rowRef} className={`msg wt-record wt-record-undone${faded ? ' faded' : ''}`}>
        <div className="wt-record-line">
          <ResetIcon />
          <span className="wt-record-words">
            已撤回这次合并
            <span className="hint" data-tip={`撤回于 ${whenExact(record.undone)}`}>
              {record.target} 回到合并之前 · {whenText(record.undone, now)}
            </span>
          </span>
        </div>
      </div>
    )
  }
  const more = record.fileCount - record.files.length
  return (
    <div ref={rowRef} className={`msg wt-record${faded ? ' faded' : ''}`}>
      <div className="wt-record-line">
        <MergeIcon />
        <span className="wt-record-words">
          已合并到 {record.target}
          <span className="hint" data-tip={`合并于 ${whenExact(record.at)}`}>
            {record.fileCount} 个文件，{record.commits} 个提交 · {whenText(record.at, now)}
          </span>
        </span>
        <button type="button" className="btn btn-small" aria-expanded={open} onClick={() => setOpen((shown) => !shown)}>
          {open ? '收起' : '查看'}
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={busy}
          data-tip="把主文件夹退回这次合并之前。worktree 里的提交不动，之后还可以再合并。"
          onClick={() => {
            setBusy(true)
            void onUndo(record).finally(() => setBusy(false))
          }}
        >
          撤回
        </button>
      </div>
      {open && (
        <div className="wt-files">
          {record.files.map((file) => (
            <div key={file.path} className="wt-file">
              <span className={`wt-file-change wt-file-${file.change}`}>{CHANGE_WORDS[file.change]}</span>
              <span className="wt-file-path">{file.path}</span>
            </div>
          ))}
          {more > 0 && <div className="wt-file wt-file-more">… 还有 {more} 个文件</div>}
        </div>
      )}
    </div>
  )
}

/** What the question before a deletion says, by what it is asked for: its title, its text, and the yes. */
function discardWords(name: string, kept: Kept): { title: string; text: string; yes: string } {
  if (kept.kind === 'locked') {
    return {
      title: '解锁并删除这个 worktree 吗？',
      text: `worktree「${name}」被你用 git worktree lock 锁住了${kept.reason ? `（当时写的原因：${kept.reason}）` : ''}。里面没有还没合并的改动。删除会话会把它解锁，再连同它的 git 分支一起删掉。`,
      yes: '解锁并删除'
    }
  }
  if (kept.kind === 'left') {
    // Files that git cannot tell from changes any more: said for what they are, and not counted as changes.
    const commits = kept.commits > 0 ? `；它的 git 分支上还有 ${kept.commits} 个还没合并的提交` : ''
    return {
      title: '连同 worktree 一起删除吗？',
      text: `worktree「${name}」已经失效，但它的文件夹里还留着 ${leftFiles(kept.files)}，git 已经分不出其中哪些是还没提交的改动${commits}。删除会话会把${kept.commits > 0 ? '文件夹和这个分支' : '这个文件夹连同里面的文件'}一并删掉，不能恢复。`,
      yes: kept.commits > 0 ? '删除并丢弃文件和提交' : '删除并丢弃这些文件'
    }
  }
  return {
    title: '连同 worktree 一起删除吗？',
    text: `worktree「${name}」里有还没合并的改动：${kept.files} 个文件，${kept.commits} 个提交。删除会话会把它们一并丢弃，不能恢复。`,
    yes: '删除并丢弃改动'
  }
}

/**
 * The question before a conversation is deleted whose worktree holds what deleting would throw
 * away: work the main folder does not have, or files left in what was a worktree, which git
 * cannot tell from changes any more. Asked only then, and of a worktree the person locked
 * themselves (`git worktree lock`), which is their word that it stays; a worktree with nothing
 * of its own goes with its conversation unasked. The no has the keyboard.
 */
export function DiscardDialog({
  name,
  kept,
  onDiscard,
  onCancel
}: {
  name: string
  /** What it is asked about for. */
  kept: Kept
  onDiscard: () => Promise<void>
  onCancel: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  const discard = (): void => {
    setBusy(true)
    setError('')
    onDiscard().catch((err: unknown) => {
      setBusy(false)
      setError(errorText(err))
    })
  }

  const words = discardWords(name, kept)
  return (
    <div className="overlay">
      <div className="dialog dialog-small" role="alertdialog" aria-modal="true" aria-labelledby="discard-title" aria-describedby="discard-text">
        <h2 id="discard-title">{words.title}</h2>
        <p id="discard-text" className="plan-text">
          {words.text}
        </p>
        {error && <Notice role="alert">{error}</Notice>}
        <div className="dialog-actions">
          <button type="button" className="btn" autoFocus disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button type="button" className="btn wt-danger" disabled={busy} onClick={discard}>
            {words.yes}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Whether a name can be used for a new worktree in a repository: it reads like one, and none there has it. */
export const nameIsFree = (repo: RepoInfo, name: string): boolean => isWorktreeName(name) && !repo.taken.includes(name)
