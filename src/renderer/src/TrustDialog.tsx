import { useEffect, useState } from 'react'
import { FolderIcon } from './icons.tsx'
import { Notice } from './Notice.tsx'
import { errorText } from './util.ts'

/**
 * The question a new chat asks of a folder the app has not been in before: may a model read it?
 * What a yes means here is said as it is. Nothing in a folder is run or loaded by choosing it;
 * what changes is that a model reads its files without asking, and that what it reads goes to
 * the model service. Changing files and running commands stay with the permission mode of the
 * conversation.
 */
export function TrustDialog({ folder, onTrust, onCancel }: { folder: string; onTrust: () => Promise<void>; onCancel: () => void }) {
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

  const trust = (): void => {
    setBusy(true)
    setError('')
    onTrust().catch((err: unknown) => {
      setBusy(false)
      setError(errorText(err))
    })
  }

  return (
    <div className="overlay">
      <div className="dialog dialog-small" role="alertdialog" aria-modal="true" aria-labelledby="trust-title" aria-describedby="trust-text">
        <h2 id="trust-title">信任这个文件夹吗？</h2>
        <div className="trust-path" data-tip={folder}>
          <FolderIcon />
          <span>{folder}</span>
        </div>
        <p id="trust-text" className="plan-text">
          模型可以直接读取这个文件夹里的文件，读到的内容会发给模型服务。修改文件和执行命令，按消息框左下角的权限设置进行。
        </p>
        <p className="hint">只信任你了解其内容的文件夹。之后可以在侧栏里把这个工作区删除，下次再选它时会重新询问。</p>
        {error && <Notice role="alert">{error}</Notice>}
        {/* The no has the keyboard: an Enter meant for the message box as the question came up trusts nothing. */}
        <div className="dialog-actions">
          <button type="button" className="btn" autoFocus disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={trust}>
            信任文件夹
          </button>
        </div>
      </div>
    </div>
  )
}
