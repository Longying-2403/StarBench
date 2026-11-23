import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { MAX_ATTACHMENTS, MAX_IMAGE_FILE_BYTES } from '../../shared/attachments.ts'
import type { Attachment, AttachmentsRead } from '../../shared/attachments.ts'
import type { PermissionMode } from '../../shared/permissions.ts'
import type { ModelInfo, ReasoningEffort, Settings, SkillInfo } from '../../shared/types.ts'
import { AttachmentRow, attachable, problemsText } from './Attachments.tsx'
import { ModeMenu } from './ModeMenu.tsx'
import { ModelControl } from './ModelControl.tsx'
import { PlusMenu } from './PlusMenu.tsx'
import { notify } from './Toasts.tsx'
import { EnterIcon, StopIcon } from './icons.tsx'
import { errorText, roomStyle, usePopupPlace } from './util.ts'

const api = window.harness

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
  const matches = visible ? skills.filter((s) => s.name.toLowerCase().includes(filter)) : []
  const activeIndex = Math.min(active, Math.max(matches.length - 1, 0))

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

  /** Puts files that were read with the message, as far as they can go with one, and says of the others why not. */
  const attach = async (reading: Promise<AttachmentsRead>): Promise<void> => {
    try {
      const { files: more, problems } = await attachable(await reading, MAX_ATTACHMENTS - held.current)
      if (more.length) setFiles((now) => [...now, ...more].slice(0, MAX_ATTACHMENTS))
      if (problems.length) notify({ kind: 'error', title: problems.length > 1 ? `${problems.length} 个文件没有添加` : '有一个文件没有添加', text: problemsText(problems) })
    } catch (err) {
      notify({ kind: 'error', title: '添加文件没有成功', text: errorText(err) })
    }
    inputRef.current?.focus()
  }

  /** Files dropped on the box or pasted into it: handed to the main process as their bytes, to be read the way picked ones are. */
  const attachDropped = (dropped: File[]): Promise<void> =>
    attach(
      (async (): Promise<AttachmentsRead> => {
        const problems: AttachmentsRead['problems'] = []
        const given: { name: string; data: ArrayBuffer }[] = []
        for (const file of dropped) {
          try {
            // One too large to be anything that is sent is not read at all. A folder cannot be read, and says so here.
            if (file.size > MAX_IMAGE_FILE_BYTES) problems.push({ name: file.name, reason: 'too-large' })
            else given.push({ name: file.name, data: await file.arrayBuffer() })
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
    if (e.key === 'Enter' && !e.shiftKey) {
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
        void attachDropped([...e.dataTransfer.files])
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
              <div
                key={skill.name}
                role="option"
                aria-selected={index === activeIndex}
                className={`skill-option ${index === activeIndex ? 'skill-option-active' : ''}`}
                title={skill.description}
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
          void attachDropped([...e.clipboardData.files])
        }}
        placeholder={blocked || '输入消息，Shift+Enter 换行，输入 / 选择 Skill'}
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
          <button type="button" className="send send-stop" onClick={onStop} aria-label="停止" title="停止">
            <StopIcon />
          </button>
        ) : (
          <button
            type="button"
            className="send"
            onClick={submit}
            disabled={Boolean(blocked) || (!draft.trim() && files.length === 0)}
            aria-label="发送"
            title="发送（Enter）"
          >
            <EnterIcon />
          </button>
        )}
      </div>
    </div>
  )
}
