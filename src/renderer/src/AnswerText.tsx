import { Children, createContext, isValidElement, memo, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentProps, MouseEvent, ReactNode } from 'react'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import dos from 'highlight.js/lib/languages/dos'
import powershell from 'highlight.js/lib/languages/powershell'
import { common } from 'lowlight'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import type { Components, Options } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { githubCommit, isCommitHash, linkGitHubRefs, onGitHub } from '../../shared/github.ts'
import type { GitHubRepo, MarkdownNode } from '../../shared/github.ts'
import { fetchablePicture, namesFile, webAddress, webPlace, writtenAddress } from '../../shared/links.ts'
import type { ImagePreview, OpenOutcome } from '../../shared/types.ts'
import { CheckIcon, CopyIcon, GitHubIcon } from './icons.tsx'
import { openWebLink } from './LinkAsk.tsx'

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
        data-tip={title ?? `打开 ${writtenAddress(address)}`}
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
  const place = address ? webPlace(address) : null
  // An address that is no page on the web (mail, and the like) stays as it was: the window goes
  // nowhere, and the main process opens nothing but pages.
  if (!place) {
    return (
      <a href={address} data-tip={title && address ? `${title}\n${address}` : (address ?? title)} target="_blank" rel="noreferrer">
        {children}
      </a>
    )
  }
  // A page on the web. The window has no status bar to show where a link leads, and the words of
  // an answer can say anything: pointing at a link shows its whole address, and pressing it asks
  // before the browser goes there (LinkAsk.tsx). It has no href, so that nothing follows it but
  // that question: not a press of the wheel, and not a press with a key held down.
  const follow = (): void => openWebLink(place.address)
  const toGitHub = onGitHub(place.address)
  // The hash of a commit, as GitHub itself shows one: small, in the letters of code, in a frame.
  const hash = toGitHub && githubCommit(place.address) !== null && isCommitHash(wordsOf(children).trim())
  return (
    <a
      className={toGitHub ? (hash ? 'web-link github-link github-commit' : 'web-link github-link') : 'web-link'}
      role="link"
      tabIndex={0}
      data-tip={title ? `${title}\n${place.address}` : place.address}
      onClick={follow}
      onKeyDown={(e) => {
        if (e.key === 'Enter') follow()
      }}
    >
      {toGitHub && <GitHubIcon />}
      {children}
    </a>
  )
}

/** The words that something drawn is made of, without what they are dressed in. */
function wordsOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(wordsOf).join('')
  return isValidElement<{ children?: ReactNode }>(node) ? wordsOf(node.props.children) : ''
}

/** The languages code is coloured in: the usual ones, and three more that commands for this computer come in. */
const LANGUAGES = { ...common, dockerfile, dos, powershell }

/** The name of the language a block of code was said to be in ("```bash"), as it was written; undefined where none was said. */
function languageOf(children: ReactNode): string | undefined {
  for (const child of Children.toArray(children)) {
    if (!isValidElement<{ className?: string }>(child)) continue
    const named = /(?:^|\s)language-(\S+)/.exec(child.props.className ?? '')
    if (named) return named[1]
  }
  return undefined
}

/**
 * Code that an answer sets apart, a command to run or a piece of a file: in a frame of its own
 * with the name of its language on top and a button that copies it, coloured by what each word is
 * (rehype-highlight; the colours are the app's, in styles.css). A long line is scrolled sideways,
 * not broken: a command is copied as it stands.
 */
function CodeWindow({ children, node: _node, ...rest }: ComponentProps<'pre'> & { node?: unknown }) {
  const body = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])
  const copy = (): void => {
    // As it reads on the page, without the line end the block closes with.
    const text = (body.current?.textContent ?? '').replace(/\n$/, '')
    navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false)
    )
  }
  return (
    <div className="code-window">
      <div className="code-head">
        <span className="code-language">{languageOf(children) ?? '代码'}</span>
        <button type="button" className="code-copy" onClick={copy}>
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre ref={body} {...rest}>
        {children}
      </pre>
    </div>
  )
}

/** The repository on GitHub each workspace is a clone of, as the main process told it: asked once for a folder, by however many answers. */
const repos = new Map<string, Promise<GitHubRepo | null>>()

function useGitHubRepo(workspace: string): GitHubRepo | null {
  const [repo, setRepo] = useState<GitHubRepo | null>(null)
  useEffect(() => {
    let current = true
    setRepo(null)
    if (!workspace) return
    let told = repos.get(workspace)
    if (!told) {
      told = api.githubRepo(workspace).catch(() => null)
      repos.set(workspace, told)
    }
    void told.then((found) => current && setRepo(found))
    return () => {
      current = false
    }
  }, [workspace])
  return repo
}

/** For the Markdown reader: makes links of the words that name something on GitHub (shared/github.ts). */
function remarkGitHubRefs(repo: GitHubRepo | null) {
  return (tree: MarkdownNode): void => linkGitHubRefs(tree, repo)
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
    return <img className="answer-image" src={address} alt={alt} data-tip={title ?? address} referrerPolicy="no-referrer" onError={() => setState('failed')} />
  }
  if (state === 'failed' || !fetchablePicture(address)) {
    return (
      <span className="file-note" role="status" data-tip={alt}>
        {state === 'failed' ? '网络图片加载失败：' : '只加载 https 地址的图片：'}
        {address}
      </span>
    )
  }
  return (
    <button
      type="button"
      className="web-image"
      data-tip="点击后从网络加载这张图片"
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
      <button type="button" className="answer-image-open" data-tip={title ?? `${name}（点击用默认程序打开）`} onClick={open}>
        <img className="answer-image" src={shown.url} alt={alt} />
      </button>
    )
  }
  if (shown.reason === 'loading') return <span className="file-note">正在载入图片…</span>
  // Too large to show here, or of a kind the page cannot draw: the file can still be opened.
  if (shown.reason === 'too-large' || shown.reason === 'not-image') {
    return (
      <span className="file-note" data-tip={alt}>
        {shown.reason === 'too-large' ? '图片超过 20 MB，这里不预览：' : '这种文件无法在这里预览：'}
        <FileLink address={address}>{name}</FileLink>
      </span>
    )
  }
  const why = { missing: '找不到图片', outside: '图片不在工作文件夹里', unreadable: '图片读取失败' }[shown.reason]
  return (
    <span className="file-note" role="status" data-tip={alt}>
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
const COMPONENTS: Components = { a: AnswerLink, img: AnswerImage, pre: CodeWindow }
// Code is coloured only in the language it says it is in: a guess at an unnamed one colours plain text.
const COLOURS: Options['rehypePlugins'] = [[rehypeHighlight, { languages: LANGUAGES }]]

/**
 * The text of an answer, as Markdown. Pictures and links that name a file in `workspace` show
 * and open that file; a link to the web asks before it is followed; words that name a pull
 * request or a commit of the repository the workspace is a clone of become links to it. An
 * answer that has not changed is not read again when another one grows.
 */
export const AnswerText = memo(function AnswerText({ text, workspace }: { text: string; workspace: string }) {
  const repo = useGitHubRepo(workspace)
  // After the reader has made links of the addresses written out, which are then left alone.
  const plugins = useMemo((): Options['remarkPlugins'] => [remarkGfm, [remarkGitHubRefs, repo]], [repo])
  return (
    <div className="markdown">
      <Workspace.Provider value={workspace}>
        <Markdown remarkPlugins={plugins} rehypePlugins={COLOURS} urlTransform={keepFiles} components={COMPONENTS}>
          {text}
        </Markdown>
      </Workspace.Provider>
    </div>
  )
})
