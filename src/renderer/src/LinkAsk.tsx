import { useEffect, useState, useSyncExternalStore } from 'react'
import { webPlace } from '../../shared/links.ts'
import type { WebPlace } from '../../shared/links.ts'
import type { Settings } from '../../shared/types.ts'
import { GlobeIcon } from './icons.tsx'
import { Notice } from './Notice.tsx'
import { errorText } from './util.ts'

const api = window.harness

/** The page the person is being asked about, and whether the system has already failed to open it. One question at a time: a link pressed meanwhile takes its place. */
let asked: { place: WebPlace; failed: boolean } | null = null
const watchers = new Set<() => void>()
const tell = (): void => watchers.forEach((watcher) => watcher())
const watch = (watcher: () => void): (() => void) => {
  watchers.add(watcher)
  return () => watchers.delete(watcher)
}
const ask = (place: WebPlace, failed: boolean): void => {
  asked = { place, failed }
  tell()
}

/**
 * Follows a link of an answer to a page on the web. The page is opened in the person's browser at
 * once only where they said not to ask again about its site; otherwise they are shown where the
 * link leads and asked first (`LinkAsk`). An address that is no page on the web is not followed.
 */
export function openWebLink(address: string): void {
  const place = webPlace(address)
  if (!place) return
  api.openWeb(place.address).then(
    (outcome) => {
      if (!outcome.opened && outcome.reason !== 'not-web') ask(place, outcome.reason === 'failed')
    },
    () => ask(place, false)
  )
}

const FAILED = '系统没能打开这个网址。可以复制网址，自己在浏览器里打开。'

/**
 * The question before a link of an answer is followed: the whole address, with the site told
 * apart from what stands around it. The words of a link are the model's, and an address is
 * something an answer can be led to write, by a file or a page the model read, with whatever it
 * was told to give away put into it; so the person sees where they are going before the browser
 * goes there. A site they tick "do not ask again" for is kept (设置 → 通用), and its links open
 * at once from then on.
 */
export function LinkAsk({ onSettings }: { onSettings: (settings: Settings) => void }) {
  const now = useSyncExternalStore(watch, () => asked)
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setRemember(false)
    setBusy(false)
    setCopied(false)
    setError(now?.failed ? FAILED : '')
  }, [now])

  // The question sits on top of everything, so Escape answers it with a no and reaches nothing underneath.
  useEffect(() => {
    if (!now) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      asked = null
      tell()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [now])

  if (!now) return null
  const { place } = now
  const close = (): void => {
    asked = null
    tell()
  }
  const open = (): void => {
    setBusy(true)
    setError('')
    api.openWeb(place.address, { remember }).then(
      (outcome) => {
        if (!outcome.opened) {
          setBusy(false)
          setError(FAILED)
          return
        }
        if (outcome.settings) onSettings(outcome.settings)
        close()
      },
      (err: unknown) => {
        setBusy(false)
        setError(errorText(err))
      }
    )
  }
  const copy = (): void => {
    navigator.clipboard.writeText(place.address).then(
      () => setCopied(true),
      () => setError('没能复制网址。')
    )
  }

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        // A press beside the question is a no.
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="dialog dialog-small" role="alertdialog" aria-modal="true" aria-labelledby="link-ask-title" aria-describedby="link-ask-text">
        <h2 id="link-ask-title">要在浏览器里打开这个网址吗？</h2>
        <div className="trust-path link-address">
          <GlobeIcon />
          <span>
            {place.before}
            <strong>{place.host}</strong>
            {place.after}
          </span>
        </div>
        <p id="link-ask-text" className="hint">
          链接上的文字是模型写的。实际要去的是上面这个网址，亮着的一段是网站。
        </p>
        {place.named && <Notice role="alert">这个网址在网站前面还写了一段名字（@ 之前的部分），这是把一个网站写得像另一个网站的常见手法。亮着的那一段才是要去的网站。</Notice>}
        <label className="check-row">
          <input type="checkbox" checked={remember} disabled={busy} onChange={(e) => setRemember(e.target.checked)} />
          不再询问 {place.host} 的链接
        </label>
        {error && <Notice role="alert">{error}</Notice>}
        {/* The no has the keyboard: an Enter meant for something else as the question came up opens nothing. */}
        <div className="dialog-actions">
          <button type="button" className="btn link-copy" onClick={copy}>
            {copied ? '已复制' : '复制网址'}
          </button>
          <button type="button" className="btn" autoFocus disabled={busy} onClick={close}>
            取消
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={open}>
            打开
          </button>
        </div>
      </div>
    </div>
  )
}
