import { Fragment, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { HEAD_BYTES, MAX_ATTACHMENTS, MAX_IMAGE_FILE_BYTES } from '../../shared/attachments.ts'
import type { Attachment, AttachmentsRead, FileAttachment } from '../../shared/attachments.ts'
import type { PermissionMode } from '../../shared/permissions.ts'
import { SEND_KEYS, keysInText, sendsMessage } from '../../shared/shortcuts.ts'
import type { ModelInfo, ReasoningEffort, Settings, SkillInfo } from '../../shared/types.ts'
import { AttachmentRow, attachable, largeText, problemsText } from './Attachments.tsx'
import { ModeMenu } from './ModeMenu.tsx'
import { ModelControl } from './ModelControl.tsx'
import { PlusMenu } from './PlusMenu.tsx'
import { notify } from './Toasts.tsx'
import { EnterIcon, StopIcon } from './icons.tsx'
import { errorText, isMac, roomStyle, usePopupPlace } from './util.ts'

const api = window.harness

/**
 * The files of a drop or a paste, each with whether it is a folder. A folder comes as a file of its
 * own that cannot be read, and only the entries of the event, while it lasts, tell it from one.
 */
function droppedFiles(data: DataTransfer): { file: File; folder: boolean }[] {
  const entries = [...data.items].filter((item) => item.kind === 'file').map((item) => item.webkitGetAsEntry?.() ?? null)
  // The entries stand in the order of the files; where their number differs, nothing is told by them.
  return [...data.files].map((file, i) => ({ file, folder: entries.length === data.files.length && entries[i]?.isDirectory === true }))
}

/**
 * The message box: the text, with the files put with it above it, and under it a row of what
 * belongs to the message being written. At the left the "+" for adding files and picking a skill
 * (typing "/" finds a skill too) and what the model may do without asking; at the right the model
 * with its thinking effort, and the send button.
 */
export function Composer({
  blocked,
  running,
  settings,
  modelInfo,
  mode,
  onModeChange,
  onEffortChange,
  onFastChange,
  onWebSearchChange,
  onSelectModel,
  onOpenSettings,
  onSend,
  onStop
}: {
  /** Why sending is impossible right now; empty when it is possible. */
  blocked: string
  running: boolean
  /** Null until the settings have been read. */
  settings: Settings | null
  /** What the service says about the current model, once known. */
  modelInfo: ModelInfo | null
  /** What the model may do in this conversation without asking. */
  mode: PermissionMode
  onModeChange: (mode: PermissionMode) => void
  onEffortChange: (effort: ReasoningEffort) => void
  onFastChange: (on: boolean) => void
  onWebSearchChange: (on: boolean) => void
  onSelectModel: (providerId: string, model: string) => void
  onOpenSettings: () => void
  onSend: (text: string, skill: string | undefined, attachments: Attachment[]) => void
  onStop: () => void
}) {
  const [draft, setDraft] = useState('')
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [picked, setPicked] = useState<string | null>(null)
  /** The files put with the message being written. */
  const [files, setFiles] = useState<Attachment[]>([])
  /** Files are being held over the box, about to be dropped on it. */
  const [dropping, setDropping] = useState(false)
  /** The draft for which Escape closed the "/" menu, so it stays closed until the text changes. */
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const areaRef = useRef<HTMLDivElement>(null)
  /** How many files the message holds, for the reading that ends later than the press that began it. */
  const held = useRef(0)
  held.current = files.length

  // "/name" with nothing after it is a skill search; "/usr/bin is missing" is an ordinary message.
  const slash = /^\/([\w-]*)$/.exec(draft)
  const slashOpen = slash !== null && dismissed !== draft
  const visible = !blocked && slashOpen
  const filter = slashOpen ? slash[1].toLowerCase() : ''
  const found = visible ? skills.filter((s) => s.name.toLowerCase().includes(filter)) : []
  // The commands (skills only the person picks, such as the memory's) first, then the skills, each under a heading.
  const matches = [...found.filter((s) => s.userOnly), ...found.filter((s) => !s.userOnly)]
  const headingAt = (index: number): string | null => {
    if (!matches.some((s) => s.userOnly)) return null
    if (index === 0) return matches[0].userOnly ? '指令' : 'Skills'
    return matches[index - 1].userOnly && !matches[index].userOnly ? 'Skills' : null
  }
  const activeIndex = Math.min(active, Math.max(matches.length - 1, 0))
  /** What the Enter key does here (设置 → 通用), and what sends the message: Enter, or Ctrl+Enter where Enter makes a new line. */
  const enter = settings?.enterKey ?? 'send'
  const sendKeys = enter === 'send' ? 'Enter' : keysInText(SEND_KEYS, isMac)

  // Below the box while it sits in the middle of a new chat and the whole menu fits there, above
  // it once it is at the bottom. `.skill-menu` is 300px at its tallest and sits 6px from the box.
  const menuPlace = usePopupPlace(visible, areaRef, 300, 6)

  // Read the list each time the menu opens: skills can be added while the app is running.
  useEffect(() => {
    if (visible) api.listSkills().then(setSkills, () => setSkills([]))
  }, [visible])

  useEffect(() => {
    if (visible) areaRef.current?.querySelector('.skill-option-active')?.scrollIntoView({ block: 'nearest' })
  }, [visible, activeIndex])

  const pick = (name: string): void => {
    setPicked(name)
    if (slashOpen) setDraft('')
    inputRef.current?.focus()
  }

  /**
   * Puts files that were read with the message, as far as they can go with one, and says of the
   * others why not. A text or a picture too large for its content to go is put with it all the
   * same, as a file whose place is told, and the person is told so.
   */
  const attach = async (reading: Promise<AttachmentsRead>): Promise<void> => {
    try {
      const { files: more, problems } = await attachable(await reading, MAX_ATTACHMENTS - held.current)
      if (more.length) setFiles((now) => [...now, ...more].slice(0, MAX_ATTACHMENTS))
      if (problems.length) notify({ kind: 'error', title: problems.length > 1 ? `${problems.length} 个文件没有添加` : '有一个文件没有添加', text: problemsText(problems) })
      const large = more.filter((file): file is FileAttachment => file.kind === 'file' && file.tooLarge !== undefined)
      if (large.length) notify({ kind: 'warning', title: large.length > 1 ? `${large.length} 个文件过大` : '文件过大', text: largeText(large) })
    } catch (err) {
      notify({ kind: 'error', title: '添加文件没有成功', text: errorText(err) })
    }
    inputRef.current?.focus()
  }

  /**
   * Files dropped on the box or pasted into it: handed to the main process as their bytes, with
   * how large they are and where they lie, to be read the way picked ones are.
   */
  const attachDropped = (dropped: { file: File; folder: boolean }[]): Promise<void> =>
    attach(
      (async (): Promise<AttachmentsRead> => {
        const problems: AttachmentsRead['problems'] = []
        const given: { name: string; data: ArrayBuffer; size: number; path: string }[] = []
        for (const { file, folder } of dropped) {
          if (folder) {
            problems.push({ name: file.name, reason: 'folder' })
            continue
          }
          try {
            // One larger than any picture that is read whole is read only as far as it takes to tell what it is: its content does not go with the message.
            const data = await (file.size > MAX_IMAGE_FILE_BYTES ? file.slice(0, HEAD_BYTES) : file).arrayBuffer()
            given.push({ name: file.name, data, size: file.size, path: api.pathOf(file) })
          } catch {
            problems.push({ name: file.name, reason: 'unreadable' })
          }
        }
        const read = given.length ? await api.readAttachments(given) : { files: [], problems: [] }
        return { files: read.files, problems: [...problems, ...read.problems] }
      })()
    )

  const submit = (): void => {
    const text = draft.trim()
    if ((!text && files.length === 0) || running || blocked) return
    onSend(text, picked ?? undefined, files)
    setDraft('')
    setPicked(null)
    setFiles([])
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // While an IME is composing, Enter and the arrows belong to its candidate list.
    if (e.nativeEvent.isComposing) return
    if (visible) {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (slashOpen) setDismissed(draft)
        return
      }
      if (matches.length > 0) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const step = e.key === 'ArrowDown' ? 1 : -1
          setActive((activeIndex + step + matches.length) % matches.length)
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          pick(matches[activeIndex].name)
          return
        }
      }
    }
    // What does not send is left to the box: a new line for Shift+Enter, and for Enter where it is set to make one.
    if (sendsMessage(e, enter, isMac)) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div
      className="composer"
      ref={areaRef}
      data-dropping={dropping ? '' : undefined}
      // The whole card is the text box: a click on its padding puts the cursor in the text.
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return
        e.preventDefault()
        inputRef.current?.focus()
      }}
      // Files can be dropped anywhere on the card. Only files: text that is dragged goes where text goes.
      onDragOver={(e) => {
        if (blocked || !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDropping(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
      }}
      onDrop={(e) => {
        setDropping(false)
        if (blocked || e.dataTransfer.files.length === 0) return
        e.preventDefault()
        void attachDropped(droppedFiles(e.dataTransfer))
      }}
    >
      {visible && (
        <div className="skill-menu" id="skill-menu" role="listbox" aria-label="Skills" data-side={menuPlace.side} style={roomStyle(menuPlace)}>
          {matches.length === 0 ? (
            <div className="skill-empty">
              {skills.length === 0 ? '还没有 Skill。在"设置 → Skills"里可以打开文件夹添加。' : '没有匹配的 Skill'}
            </div>
          ) : (
            matches.map((skill, index) => (
              <Fragment key={skill.name}>
                {headingAt(index) && (
                  <div className="skill-group" role="presentation">
                    {headingAt(index)}
                  </div>
                )}
                <div
                  role="option"
                  aria-selected={index === activeIndex}
                  className={`skill-option ${index === activeIndex ? 'skill-option-active' : ''}`}
                  data-tip={skill.description}
                  onMouseEnter={() => setActive(index)}
                  // mousedown, not click: picking must not take focus away from the text box.
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pick(skill.name)
                  }}
                >
                  <span className="skill-name">{skill.name}</span>
                  {skill.description && <span className="skill-desc">{skill.description}</span>}
                </div>
              </Fragment>
            ))
          )}
        </div>
      )}
      <AttachmentRow files={files} onRemove={(index) => setFiles((now) => now.filter((_, i) => i !== index))} />
      <textarea
        ref={inputRef}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setActive(0)
        }}
        onKeyDown={onKeyDown}
        // A picture copied from somewhere, or files copied in the file manager, are put with the message. Text is pasted as text.
        onPaste={(e) => {
          if (e.clipboardData.files.length === 0) return
          e.preventDefault()
          void attachDropped(droppedFiles(e.clipboardData))
        }}
        placeholder={blocked || `输入消息，${enter === 'send' ? `${keysInText('Shift+Enter', isMac)} 换行` : `${sendKeys} 发送`}，输入 / 选择 Skill`}
        disabled={Boolean(blocked)}
        rows={1}
        aria-label="消息"
        aria-controls={visible ? 'skill-menu' : undefined}
      />
      <div className="composer-bar">
        <PlusMenu disabled={Boolean(blocked)} onAddFiles={() => void attach(api.pickAttachments())} onPickSkill={pick} />
        {/* Does not wait for a folder or a model: it is about the conversation, whenever its next message goes out. */}
        <ModeMenu mode={mode} onChange={onModeChange} />
        {picked && (
          <span className="chip">
            {picked}
            <button className="chip-remove" onClick={() => setPicked(null)} aria-label={`取消使用 Skill ${picked}`}>
              ×
            </button>
          </span>
        )}
        {settings && (
          <ModelControl
            settings={settings}
            modelInfo={modelInfo}
            onEffortChange={onEffortChange}
            onFastChange={onFastChange}
            onWebSearchChange={onWebSearchChange}
            onSelectModel={onSelectModel}
            onOpenSettings={onOpenSettings}
          />
        )}
        {running ? (
          <button type="button" className="send send-stop" onClick={onStop} aria-label="停止" data-tip="停止">
            <StopIcon />
          </button>
        ) : (
          <button
            type="button"
            className="send"
            onClick={submit}
            disabled={Boolean(blocked) || (!draft.trim() && files.length === 0)}
            aria-label="发送"
            data-tip={`发送（${sendKeys}）`}
          >
            <EnterIcon />
          </button>
        )}
      </div>
    </div>
  )
}
