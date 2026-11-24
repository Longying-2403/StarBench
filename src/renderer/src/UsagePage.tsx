// The usage section of the settings: what is left on each DeepSeek account, with the line below
// which the person is told, and what the app asked of each model service, added up over today,
// this month or the last thirty days. The numbers are the app's own record (shared/usage.ts): of
// the requests it made, not of what was done with the same key elsewhere.

import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { cacheHitRate, formatCount, formatShare, formatTokens } from '../../shared/stats.ts'
import type { ProviderInfo, Settings } from '../../shared/types.ts'
import { DEEPSEEK_BILLING_URL, balanceServiceOf, balanceTone, currencyMark, formatMoney, isAlertAmount, otherBalances, usagePageOf } from '../../shared/usage.ts'
import type { UsageRange, UsageRow, UsageSummary } from '../../shared/usage.ts'
import { BALANCE_PROBLEMS, ExternalIcon, RefreshIcon, UpdatedAt } from './Balance.tsx'
import { Notice } from './Notice.tsx'
import { usageApi, useBalance, useUsageSettings } from './usage-api.ts'
import { errorText } from './util.ts'
import './UsagePage.css'

const RANGES: readonly { id: UsageRange; label: string }[] = [
  { id: 'today', label: '今天' },
  { id: 'month', label: '本月' },
  { id: 'days30', label: '近 30 天' }
]

/** The time now, moved on every half minute: enough for "3 分钟前". */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

/** One DeepSeek account: its balance, when DeepSeek said so, and the line below which the person is told. */
function BalanceBlock({ provider }: { provider: ProviderInfo }) {
  const state = useBalance(provider.id)
  const now = useNow()
  const [draft, setDraft] = useState('')
  const [problem, setProblem] = useState('')
  // The box shows the line as it is set, and again after each change to it.
  useEffect(() => setDraft(state?.alert !== undefined ? String(state.alert) : ''), [state?.alert])
  const tone = balanceTone(state)
  const first = state?.balances?.[0]
  const others = otherBalances(state?.balances)
  const currency = first?.currency ?? 'CNY'

  const setLine = (amount: number | null): void => {
    setProblem('')
    usageApi.setAlert(provider.id, amount).catch((err: unknown) => setProblem(errorText(err)))
  }
  const submit = (e: FormEvent): void => {
    e.preventDefault()
    const typed = draft.trim().replace(/[,，]/g, '')
    if (!typed) return setLine(null)
    const amount = Number(typed)
    if (!isAlertAmount(amount)) return setProblem('填一个大于 0 的金额，例如 5 或 10.5。')
    setLine(Math.round(amount * 100) / 100)
  }

  const parts = [
    first?.toppedUp !== undefined ? `充值 ${formatMoney(first.toppedUp, first.currency)}` : null,
    first?.granted !== undefined ? `赠送 ${formatMoney(first.granted, first.currency)}` : null,
    ...others.map((other) => `${other.currency} ${formatMoney(other.total, other.currency)}`)
  ].filter(Boolean)

  return (
    <section className={`usage-balance${tone ? ` usage-${tone}` : ''}`} aria-label={`${provider.name} 余额`}>
      <div className="usage-balance-main">
        <div className="usage-balance-words">
          <div className="usage-label">{provider.name} 余额</div>
          <div className="usage-amount">{first ? formatMoney(first.total, first.currency) : '—'}</div>
          <div className="usage-sub">
            {parts.join(' · ')}
            {parts.length > 0 && state?.at ? ' · ' : ''}
            {state?.checking ? '正在查询…' : state?.at ? <UpdatedAt at={state.at} now={now} /> : null}
          </div>
          {state?.available === false && <div className="usage-tone-danger usage-state">余额不足：DeepSeek 已经不接受调用，充值之后才能继续。</div>}
          {tone === 'warn' && <div className="usage-tone-warn usage-state">低于你设的提醒线 {formatMoney(state!.alert!, currency)}。</div>}
          {state?.problem && (
            <div className="usage-problem" role="alert">
              {BALANCE_PROBLEMS[state.problem]}
            </div>
          )}
        </div>
        <div className="usage-actions">
          <button type="button" className="btn btn-small usage-refresh" disabled={state?.checking} onClick={() => void usageApi.balance(provider.id, true).catch(() => {})}>
            <RefreshIcon />
            刷新
          </button>
          <a className="usage-link" href={DEEPSEEK_BILLING_URL} target="_blank" rel="noreferrer">
            账单
            <ExternalIcon />
          </a>
        </div>
      </div>
      <form className="usage-alert" onSubmit={submit}>
        <label className="usage-alert-words">
          余额低于
          <span className="usage-alert-box">
            <span aria-hidden="true">{currencyMark(currency)}</span>
            <input
              value={draft}
              inputMode="decimal"
              placeholder="不提醒"
              spellCheck={false}
              aria-label={`余额低于多少时提醒，单位 ${currency}`}
              onChange={(e) => {
                setDraft(e.target.value)
                setProblem('')
              }}
            />
          </span>
          时在右上角提醒一次
        </label>
        <button type="submit" className="btn btn-small">
          设置
        </button>
        {state?.alert !== undefined && (
          <button type="button" className="btn btn-small" onClick={() => setLine(null)}>
            不再提醒
          </button>
        )}
        {problem && (
          <span className="usage-problem" role="alert">
            {problem}
          </span>
        )}
      </form>
    </section>
  )
}

const tokens = (value: number | undefined): string => (value === undefined ? '—' : formatTokens(value))

/** All the input of a line: what was read from a cache and written to it as well. Undefined where the service told none of it. */
function inputOf(row: UsageRow): number | undefined {
  const parts = [row.input, row.cacheRead, row.cacheWrite].filter((value): value is number => value !== undefined)
  return parts.length ? parts.reduce((sum, value) => sum + value, 0) : undefined
}

function UsageLine({ row, provider }: { row: UsageRow; provider: ProviderInfo | undefined }) {
  const input = inputOf(row)
  const rate = cacheHitRate(row)
  const page = provider ? usagePageOf(provider) : undefined
  return (
    <tr>
      <td className="usage-cell-name">
        {/* The name as the settings have it now; as it was last counted for a service that has been removed since. */}
        <span>{provider?.name ?? row.name}</span>
        <span className="usage-model"> · {row.model || '—'}</span>
      </td>
      <td data-tip={row.untold ? `其中 ${formatCount(row.untold)} 次服务没有报告用量，没有算进 token 数。` : undefined}>
        {formatCount(row.requests)}
        {row.untold ? <span className="usage-untold">*</span> : null}
      </td>
      <td>
        {tokens(input)}
        {input !== undefined && <span className="usage-model">（{rate === undefined ? '—' : formatShare(rate)}）</span>}
      </td>
      <td data-tip={row.reasoning ? `其中思考 ${formatTokens(row.reasoning)}` : undefined}>{tokens(row.output)}</td>
      <td className="usage-cell-link">
        {page && (
          <a className="usage-link" href={page} target="_blank" rel="noreferrer">
            查看用量
            <ExternalIcon />
          </a>
        )}
      </td>
    </tr>
  )
}

export function UsageTab({ settings }: { settings: Settings }) {
  const [range, setRange] = useState<UsageRange>('month')
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [error, setError] = useState('')
  /** Emptying the record takes a second press. */
  const [confirming, setConfirming] = useState(false)

  const load = useCallback(
    () =>
      usageApi.summary(range).then(
        (told) => {
          setSummary(told)
          setError('')
        },
        (err: unknown) => setError(errorText(err))
      ),
    [range]
  )
  useEffect(() => {
    void load()
  }, [load])
  // Counted while the page is open: added up again a moment after the last count.
  useEffect(() => {
    let timer: number | undefined
    const off = usageApi.onEvent((event) => {
      if (event.type !== 'changed') return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void load(), 400)
    })
    return () => {
      off()
      window.clearTimeout(timer)
    }
  }, [load])

  const clear = (): void => {
    if (!confirming) return setConfirming(true)
    setConfirming(false)
    usageApi.clear().then(
      () => void load(),
      (err: unknown) => setError(errorText(err))
    )
  }

  const usageSettings = useUsageSettings()
  const balanceOn = usageSettings?.balance === true
  const switchBalance = (on: boolean): void => {
    setError('')
    usageApi.setBalance(on).catch((err: unknown) => setError(errorText(err)))
  }

  const deepseek = settings.providers.filter((p) => p.hasApiKey && balanceServiceOf(p))
  const byId = new Map(settings.providers.map((p) => [p.id, p]))
  const onPlan = summary?.rows.some((row) => byId.get(row.provider)?.auth === 'chatgpt')

  return (
    <div className="tab-body usage-page">
      {/* Only where there is a DeepSeek service with a key: no other service tells its balance. */}
      {deepseek.length > 0 && (
        <label className="setting-row usage-switch">
          <span className="setting-words">
            <span className="setting-name">查询 DeepSeek 余额</span>
            <span className="hint">
              用你在“模型”里填好的 API Key 向 DeepSeek 查询账户余额：打开这一页、按“刷新”时，以及用 DeepSeek 的每轮对话结束后（最多一分钟一次）。余额显示在这里和输入框下面，低于提醒线时在右上角提醒一次。关掉后不再查询。
            </span>
          </span>
          <input type="checkbox" role="switch" className="switch" checked={balanceOn} disabled={!usageSettings} onChange={(e) => switchBalance(e.target.checked)} />
        </label>
      )}
      {balanceOn &&
        deepseek.map((provider) => (
          <BalanceBlock key={provider.id} provider={provider} />
        ))}
      {!settings.stats && <Notice>“通用”里的“统计用量和上下文”关着，现在不会记下新的用量。打开它之后，从那时起的请求才会算进来。</Notice>}
      <div className="usage-ranges" role="group" aria-label="统计的时间段">
        {RANGES.map((r) => (
          <button key={r.id} type="button" aria-pressed={range === r.id} onClick={() => setRange(r.id)}>
            {r.label}
          </button>
        ))}
      </div>
      {error && (
        <p className="usage-problem" role="alert">
          {error}
        </p>
      )}
      {summary &&
        (summary.rows.length ? (
          <table className="usage-table">
            <thead>
              <tr>
                <th scope="col">服务 · 模型</th>
                <th scope="col">请求</th>
                <th scope="col">输入（缓存命中）</th>
                <th scope="col">输出</th>
                <th scope="col">
                  <span className="usage-hidden">服务自己的用量页面</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {summary.rows.map((row) => (
                <UsageLine key={`${row.provider}\u0000${row.model}`} row={row} provider={byId.get(row.provider)} />
              ))}
            </tbody>
          </table>
        ) : (
          <p className="hint">这段时间还没有记录。</p>
        ))}
      {onPlan && <p className="hint">ChatGPT 套餐的额度不是按 token 计算的，它那一行的数字只供参考。</p>}
      <div className="usage-foot">
        <p className="hint">
          只统计 StarBench 发出的请求，包括起标题和压缩；同一个 key 在别的地方用掉的不会算进来。不换算成钱。
          {summary?.since ? `记录从 ${summary.since} 开始，保留 12 个月。` : '记录保留 12 个月。'}
        </p>
        <button type="button" className={`btn btn-small${confirming ? ' btn-danger' : ''}`} onClick={clear} onBlur={() => setConfirming(false)}>
          {confirming ? '再按一次清空' : '清空记录'}
        </button>
      </div>
    </div>
  )
}
