import { createContext, memo, useContext, useEffect, useState } from 'react'
import type { ComponentProps, MouseEvent, ReactNode } from 'react'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { fetchablePicture, namesFile, webAddress, writtenAddress } from '../../shared/links.ts'
import type { ImagePreview, OpenOutcome } from '../../shared/types.ts'

const api = window.harness

/** The folder of the conversation: where the files that an answer names are looked for. */
const Workspace = createContext('')

/**
 * Addresses of files are let through as they are written. The page never goes to one: it asks
 * the main process for the file, which looks no further than the folder of the conversation.
 * The usual check would empty "C:\out\chart.png", whose drive letter it takes for a scheme.
 */
const keepFiles = (url: string): string => (namesFile(url) ? url : defaultUrlTransform(url))

const OPEN_PROBLEMS: Record<Extract<OpenOutcome, { ok: false }>['reason'], string> = {
  missing: '找不到这个文件',
  outside: '不在工作文件夹里，无法打开',
  failed: '系统没能打开它'
}

/**
 * A link to a file in the workspace. Pressing it opens the file with the program the system has
 * for it, or points it out in its folder when it is of a kind that opening might run. What went
 * wrong is said beside the link.
 */
function FileLink({ address, title, children }: { address: string; title?: string; children: ReactNode }) {
  const workspace = useContext(Workspace)
  const [problem, setProblem] = useState('')
  const open = (): void => {
    setProblem('')
    api.openFile(workspace, address).then(
      (outcome) => setProblem(outcome.ok ? '' : OPEN_PROBLEMS[outcome.reason]),
      () => setProblem(OPEN_PROBLEMS.failed)
    )
  }
  return (
    <>
      {/* No href: there is no address the window itself could go to. */}
      <a
        className="file-link"
        role="link"
        tabIndex={0}
        title={title ?? `打开 ${writtenAddress(address)}`}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === 'Enter') open()
        }}
      >
        {children}
      </a>
      {problem && (
        <span className="file-note" role="status">
          （{problem}）
        </span>
      )}
    </>
  )
}

function AnswerLink({ href, title, children }: ComponentProps<'a'>) {
  if (href && namesFile(href)) {
    return (
      <FileLink address={href} title={title}>
        {children}
      </FileLink>
    )
  }
  const address = href ? webAddress(href) : undefined
  // The window has no status bar to show where a link leads, and the words of an answer can say
  // anything: pointing at a link shows its whole address, to be judged before the press.
  return (
    <a href={address} title={title && address ? `${title}\n${address}` : (address ?? title)} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
}

/**
 * A picture from the web. It is fetched when the person asks for it and never by itself. An
 * address is something an answer can be led to write, by a file or a page the model read, with
 * whatever it was told to give away put into it; fetching the picture would hand that over. So
 * the address is shown whole, to be judged before the press.
 */
function WebImage({ address, alt, title }: { address: string; alt: string; title?: string }) {
  const [state, setState] = useState<'waiting' | 'shown' | 'failed'>('waiting')
  if (state === 'shown') {
    return <img className="answer-image" src={address} alt={alt} title={title ?? address} referrerPolicy="no-referrer" onError={() => setState('failed')} />
  }
  if (state === 'failed' || !fetchablePicture(address)) {
    return (
      <span className="file-note" role="status" title={alt}>
        {state === 'failed' ? '网络图片加载失败：' : '只加载 https 地址的图片：'}
        {address}
      </span>
    )
  }
  return (
    <button
      type="button"
      className="web-image"
      title="点击后从网络加载这张图片"
      onClick={(e) => {
        // Inside a link the press asks for the picture, and does not follow the link yet.
        e.preventDefault()
        e.stopPropagation()
        setState('shown')
      }}
    >
      <span>网络图片{alt ? `“${alt}”` : ''}，点击加载</span>
      <span className="web-image-address">{address}</span>
    </button>
  )
}

type Shown = ImagePreview | { ok: false; reason: 'loading' | 'unreadable' }

/**
 * A picture in the workspace, read by the main process when the answer first shows it. Pressing
 * it opens the file itself. A picture that cannot be shown leaves a line saying why.
 */
function FileImage({ address, alt, title }: { address: string; alt: string; title?: string }) {
  const workspace = useContext(Workspace)
  const [shown, setShown] = useState<Shown>({ ok: false, reason: 'loading' })
  useEffect(() => {
    let current = true
    setShown({ ok: false, reason: 'loading' })
    api.readImage(workspace, address).then(
      (preview) => current && setShown(preview),
      () => current && setShown({ ok: false, reason: 'unreadable' })
    )
    return () => {
      current = false
    }
  }, [workspace, address])

  const name = writtenAddress(address)
  if (shown.ok) {
    const open = (e: MouseEvent<HTMLElement>): void => {
      // A picture that is itself a link leads where the link says.
      if (e.currentTarget.closest('a')) return
      void api.openFile(workspace, address)
    }
    return (
      <button type="button" className="answer-image-open" title={title ?? `${name}（点击用默认程序打开）`} onClick={open}>
        <img className="answer-image" src={shown.url} alt={alt} />
      </button>
    )
  }
  if (shown.reason === 'loading') return <span className="file-note">正在载入图片…</span>
  // Too large to show here, or of a kind the page cannot draw: the file can still be opened.
  if (shown.reason === 'too-large' || shown.reason === 'not-image') {
    return (
      <span className="file-note" title={alt}>
        {shown.reason === 'too-large' ? '图片超过 20 MB，这里不预览：' : '这种文件无法在这里预览：'}
        <FileLink address={address}>{name}</FileLink>
      </span>
    )
  }
  const why = { missing: '找不到图片', outside: '图片不在工作文件夹里', unreadable: '图片读取失败' }[shown.reason]
  return (
    <span className="file-note" role="status" title={alt}>
      {why}：{name}
    </span>
  )
}

function AnswerImage({ src, alt, title }: ComponentProps<'img'>) {
  if (typeof src !== 'string' || !src) return <>{alt}</>
  if (namesFile(src)) return <FileImage address={src} alt={alt ?? ''} title={title} />
  return <WebImage address={webAddress(src)} alt={alt ?? ''} title={title} />
}

// Kept from one drawing to the next: with new ones every time, each picture would be read again
// at every word of an answer that is still being written.
const COMPONENTS: Components = { a: AnswerLink, img: AnswerImage }
const PLUGINS = [remarkGfm]

/**
 * The text of an answer, as Markdown. Pictures and links that name a file in `workspace` show
 * and open that file. An answer that has not changed is not read again when another one grows.
 */
export const AnswerText = memo(function AnswerText({ text, workspace }: { text: string; workspace: string }) {
  return (
    <div className="markdown">
      <Workspace.Provider value={workspace}>
        <Markdown remarkPlugins={PLUGINS} urlTransform={keepFiles} components={COMPONENTS}>
          {text}
        </Markdown>
      </Workspace.Provider>
    </div>
  )
})
