import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { ProviderInfo, Settings } from '../../shared/types.ts'
import { NO_PROMPT, PromptField, promptToSave } from './PromptField.tsx'
import { errorText } from './util.ts'

const api = window.harness

/**
 * The person's own instructions for the models of the provider in use, opened from the message
 * box. They are kept with the provider: another provider has its own.
 */
export function PromptDialog({
  provider,
  onClose,
  onSaved
}: {
  provider: ProviderInfo
  onClose: () => void
  onSaved: (settings: Settings) => void
}) {
  const [prompt, setPrompt] = useState(provider.prompt ?? NO_PROMPT)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      onSaved(await api.setPrompt(provider.id, promptToSave(prompt)))
      onClose()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="prompt-title" onSubmit={(e) => void save(e)}>
        <div className="dialog-head">
          <h2 id="prompt-title">提示词</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="dialog-body">
          <p className="hint">
            这里写的内容每条消息都会发给"{provider.name}"的模型。它跟着模型服务走：换用别的服务时，用的是那个服务自己的提示词。
          </p>
          <PromptField value={prompt} onChange={setPrompt} autoFocus />
          {error && (
            <div className="msg-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            保存
          </button>
        </div>
      </form>
    </div>
  )
}
