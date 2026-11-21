import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { CHATGPT_HELP_URL, CHATGPT_USAGE_URL } from '../../shared/types.ts'
import type { ModelChoice, Settings, SignInOptions, SignInResult } from '../../shared/types.ts'
import { Notice } from './Notice.tsx'
import { errorText } from './util.ts'

const api = window.harness

/**
 * The button that starts signing in with ChatGPT. The label is the one OpenAI asks for and is
 * left as it is; the attribute is how OpenAI wants such buttons marked.
 */
export function ChatGptButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="signin-btn" data-oai-siwc-button="" onClick={onClick} disabled={disabled}>
      Continue with ChatGPT
    </button>
  )
}

function failureText(result: Extract<SignInResult, { ok: false }>): string {
  if (result.reason === 'denied') return '你在登录页面上选择了不授权，所以没有登录。'
  if (result.reason === 'timeout') return '十分钟内没有等到登录完成，已经停止等待。可以重新开始。'
  return `登录没有完成：${result.detail}`
}

type Phase = { step: 'idle' } | { step: 'opening' } | { step: 'waiting'; url: string; copied: boolean }

/**
 * Everything about using a ChatGPT plan: signing in, the account that is signed in, the model to
 * use, and signing out. Shown for a provider that exists, or to add one by signing in.
 */
export function ChatGptPane({
  settings,
  providerId,
  autoStart,
  onBack,
  onChanged,
  onWelcome
}: {
  settings: Settings
  /** Absent to add a provider by signing in. */
  providerId?: string
  /** Start signing in at once: the pane was reached through the sign-in button. */
  autoStart?: boolean
  onBack: () => void
  onChanged: (settings: Settings) => void
  /** The first sign-in with plan usage has just succeeded. */
  onWelcome: () => void
}) {
  /** A sign-in adds the provider; from then on the pane shows that one. */
  const [id, setId] = useState(providerId)
  const provider = settings.providers.find((p) => p.id === id && p.auth === 'chatgpt')
  const account = provider?.account
  const [phase, setPhase] = useState<Phase>({ step: 'idle' })
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [model, setModel] = useState(provider?.model ?? '')
  const [models, setModels] = useState<ModelChoice[]>([])
  const [busy, setBusy] = useState(false)
  /** Removing takes a second press. */
  const [confirming, setConfirming] = useState(false)
  /** Counts sign-ins started here, so the end of an abandoned one is not mistaken for the current one's. */
  const attempt = useRef(0)
  const linkRef = useRef<HTMLInputElement>(null)

  // The model is chosen for the person right after signing in; the field follows.
  useEffect(() => setModel(provider?.model ?? ''), [provider?.model])
  // What the plan offers depends on the account, so the list is asked again when that changes.
  useEffect(() => {
    setModels([])
    if (id && provider?.hasApiKey) api.listModels(id).then(setModels, () => {})
  }, [id, provider?.hasApiKey, account?.email])

  const signIn = async (options: SignInOptions = {}): Promise<void> => {
    const mine = ++attempt.current
    setError('')
    setNotice('')
    setPhase({ step: 'opening' })
    try {
      const { url } = await api.startSignIn({ ...(id ? { providerId: id } : {}), ...options })
      if (mine !== attempt.current) return
      setPhase({ step: 'waiting', url, copied: false })
      const result = await api.finishSignIn()
      // Also reached after the pane was left: the settings are the app's, and are updated all the same.
      if (result.ok) {
        onChanged(result.settings)
        if (result.welcome) onWelcome()
      }
      if (mine !== attempt.current) return
      setPhase({ step: 'idle' })
      if (result.ok) setId(result.providerId)
      else if (result.reason !== 'cancelled') setError(failureText(result))
    } catch (err) {
      if (mine !== attempt.current) return
      setPhase({ step: 'idle' })
      setError(errorText(err))
    }
  }

  const cancel = (): void => {
    attempt.current++
    setPhase({ step: 'idle' })
    void api.cancelSignIn()
  }

  const started = useRef(false)
  useEffect(() => {
    // Once, also where effects run twice during development.
    if (!autoStart || started.current) return
    started.current = true
    void signIn()
  }, [])

  const copyLink = async (url: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url)
      setPhase((p) => (p.step === 'waiting' ? { ...p, copied: true } : p))
    } catch {
      // Selected instead, ready for Ctrl+C.
      linkRef.current?.select()
    }
  }

  const act = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const save = (e: FormEvent): void => {
    e.preventDefault()
    if (!provider) return
    void act(async () => {
      onChanged(await api.saveProvider({ id: provider.id, name: provider.name, kind: provider.kind, baseURL: provider.baseURL, model }))
      onBack()
    })
  }

  const signOut = (): void => {
    if (!provider) return
    void act(async () => {
      const { settings: next, revoked } = await api.signOut(provider.id)
      onChanged(next)
      setNotice(
        revoked
          ? '已退出登录。'
          : '已在这台电脑上退出登录，但没能通知 OpenAI 撤销授权。如果需要，可以到 ChatGPT 的设置里断开 StarBench。'
      )
    })
  }

  const remove = (): void => {
    if (!provider) return
    if (!confirming) return setConfirming(true)
    void act(async () => {
      onChanged(await api.removeProvider(provider.id))
      onBack()
    })
  }

  const messages = (
    <>
      {notice && <Notice>{notice}</Notice>}
      {error && (
        <div className="msg-error" role="alert">
          {error}
        </div>
      )}
    </>
  )

  if (phase.step !== 'idle') {
    return (
      <div className="tab-body">
        <div className="plan-card">
          <div className="plan-title">正在用 ChatGPT 登录</div>
          {phase.step === 'opening' ? (
            <p className="hint">正在打开浏览器…</p>
          ) : (
            <>
              <p className="plan-text">
                登录页面已经在浏览器里打开。在那里登录并允许 StarBench 使用你的 ChatGPT 套餐，完成后会自动回到这里。
              </p>
              <label>
                <span className="hint">浏览器没有打开？复制这个链接，粘贴到浏览器的地址栏：</span>
                <span className="link-row">
                  <input ref={linkRef} readOnly value={phase.url} aria-label="登录链接" onFocus={(e) => e.target.select()} />
                  <button type="button" className="btn btn-small" onClick={() => void copyLink(phase.url)}>
                    {phase.copied ? '已复制' : '复制'}
                  </button>
                </span>
              </label>
            </>
          )}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={cancel}>
            取消
          </button>
        </div>
      </div>
    )
  }

  // Not signed in: a provider that was signed out of, or none yet.
  if (!account?.signedIn) {
    return (
      <div className="tab-body">
        <div className="plan-card">
          <div className="plan-title">使用你的 ChatGPT 套餐</div>
          <p className="plan-text">
            用 ChatGPT 账号登录后，在这里使用 OpenAI 的模型会计入你 ChatGPT 套餐里的额度，不需要 API Key。登录在浏览器里完成，StarBench
            不会看到你的密码。
          </p>
          {account?.email && <p className="hint">上次登录的账号：{account.email}</p>}
          <div className="toolbar toolbar-wrap">
            <ChatGptButton onClick={() => void signIn()} disabled={busy} />
            {/* A registration belongs to one account; another account needs a new one. */}
            {provider && (
              <button type="button" className="btn" disabled={busy} onClick={() => void signIn({ otherAccount: true })}>
                换一个账号
              </button>
            )}
            <a className="plan-link" href={CHATGPT_HELP_URL} target="_blank" rel="noreferrer">
              了解更多
            </a>
          </div>
        </div>
        {messages}
        <div className="dialog-actions">
          {provider && settings.providers.length > 1 && (
            <button type="button" className="btn btn-danger" disabled={busy} onClick={remove}>
              {confirming ? '确认删除？' : '删除'}
            </button>
          )}
          <button type="button" className="btn" onClick={onBack}>
            返回
          </button>
        </div>
      </div>
    )
  }

  return (
    <form className="tab-body" onSubmit={save}>
      <div className="plan-card">
        <div className="plan-title">
          ChatGPT 账号
          <span className={`badge ${account.planUsage ? 'badge-active' : 'badge-waiting'}`}>{account.planUsage ? '正在使用 ChatGPT 套餐' : '未启用套餐额度'}</span>
        </div>
        <p className="plan-text">{account.email ?? '已登录'}</p>
        {account.planUsage ? (
          <p className="hint">
            用这个账号发出的请求会计入你的 ChatGPT 套餐额度。
            <a className="plan-link" href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">
              管理用量
            </a>
          </p>
        ) : (
          <>
            <Notice>这个账号已经登录，但还没有允许 StarBench 使用它的 ChatGPT 套餐，所以暂时不能用它发消息。</Notice>
            <div className="toolbar">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void signIn({ consent: true })}>
                启用套餐额度
              </button>
            </div>
          </>
        )}
      </div>
      {account.planUsage && (
        <label>
          模型
          <input value={model} onChange={(e) => setModel(e.target.value)} list="plan-models" placeholder="可以留空" />
          <datalist id="plan-models">
            {models.map((m) => (
              <option key={m.id} value={m.id} label={m.name} />
            ))}
          </datalist>
          <span className="hint">也可以在输入框右下角点模型名，从这个账号可用的模型里选。</span>
        </label>
      )}
      {messages}
      <div className="dialog-actions">
        <button type="button" className="btn btn-danger" disabled={busy} onClick={signOut}>
          退出登录
        </button>
        <button type="button" className="btn" onClick={onBack}>
          返回
        </button>
        {account.planUsage && (
          <button type="submit" className="btn btn-primary" disabled={busy}>
            保存
          </button>
        )}
      </div>
    </form>
  )
}
