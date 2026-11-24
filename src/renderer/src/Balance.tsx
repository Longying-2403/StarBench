// DeepSeek's balance where the person sees it: a widget in the row under the message box, beside
// the three of StatusRow.tsx, and a notice in the corner, once, when it falls below the line they
// set on the usage page. What the balance is and how it is had: shared/usage.ts, main/usage.ts.

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { formatTokens } from '../../shared/stats.ts'
import { DEEPSEEK_TOP_UP_URL, balanceTone, formatMoney, otherBalances } from '../../shared/usage.ts'
import type { BalanceProblem, BalanceState } from '../../shared/usage.ts'
import { whenExact, whenText } from '../../shared/when.ts'
import { WarningIcon, line } from './icons.tsx'
import { notify } from './Toasts.tsx'
import { usageApi, useBalance, useUsageSettings } from './usage-api.ts'
import './UsagePage.css'

export function WalletIcon() {
  return (
    <svg {...line}>
      <path d="M17 8V5a1 1 0 0 0-1-1H6a2 2 0 0 0 0 4h12a1 1 0 0 1 1 1v3m0 4v3a1 1 0 0 1-1 1H6a2 2 0 0 1-2-2V6" />
      <path d="M20 12v4h-4a2 2 0 0 1 0-4h4" />
    </svg>
  )
}

export function RefreshIcon() {
  return (
    <svg {...line}>
      <path d="M20 11a8.1 8.1 0 0 0-15.5-2m-.5-4v4h4" />
      <path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" />
    </svg>
  )
}

/** A link that leaves the app: opened in the browser. */
export function ExternalIcon() {
  return (
    <svg {...line}>
      <path d="M12 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
      <path d="m11 13 9-9" />
      <path d="M15 4h5v5" />
    </svg>
  )
}

/** Why a look at the balance came to nothing, in the person's words. */
export const BALANCE_PROBLEMS: Record<BalanceProblem, string> = {
  key: 'DeepSeek 不认这个 API key，或者还没有填。到“模型”里检查一下。',
  offline: '连不上 DeepSeek，稍后再试。',
  refused: 'DeepSeek 这次没有给出余额，稍后再试。',
  limited: '查得太频繁，DeepSeek 暂时不回答，稍后再试。',
  unreadable: '看不懂 DeepSeek 的回答，它可能改了格式。',
  unsupported: '这个服务不提供余额查询。',
  off: '余额查询没有打开。'
}

/** When DeepSeek last answered, said as the list of conversations says it, with the moment in full on the tip. */
export function UpdatedAt({ at, now }: { at: number; now: number }) {
  return <span data-tip={whenExact(at)}>{whenText(at, now)}更新</span>
}

function Line({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="status-line">
      <span>{label}</span>
      <span className="status-value">{value}</span>
    </div>
  )
}

/** The card the balance in the row opens: what DeepSeek said, the line, and what this month asked of it here. */
function BalanceCard({ provider, name, state, onOpenUsage }: { provider: string; name: string; state: BalanceState | null; onOpenUsage?: () => void }) {
  const [month, setMonth] = useState<{ input?: number; output?: number } | null>(null)
  useEffect(() => {
    let current = true
    usageApi.summary('month').then(
      (summary) => {
        if (!current) return
        const rows = summary.rows.filter((row) => row.provider === provider)
        const add = (values: (number | undefined)[]): number | undefined => (values.some((v) => v !== undefined) ? values.reduce<number>((sum, v) => sum + (v ?? 0), 0) : undefined)
        setMonth({
          input: add(rows.flatMap((row) => [row.input, row.cacheRead, row.cacheWrite])),
          output: add(rows.map((row) => row.output))
        })
      },
      () => {}
    )
    return () => {
      current = false
    }
  }, [provider])
  const now = Date.now()
  const tone = balanceTone(state)
  const first = state?.balances?.[0]
  const others = otherBalances(state?.balances)
  const tokens = (value: number | undefined): string => (value === undefined ? '—' : formatTokens(value))
  return (
    <>
      <div className="status-head">
        <span>{name} 余额</span>
        <span className={tone ? `usage-tone-${tone}` : undefined}>{first ? formatMoney(first.total, first.currency) : '—'}</span>
      </div>
      {first?.toppedUp !== undefined && <Line label="充值余额" value={formatMoney(first.toppedUp, first.currency)} />}
      {first?.granted !== undefined && <Line label="赠送余额" value={formatMoney(first.granted, first.currency)} />}
      {others.map((other) => (
        <Line key={other.currency} label={`${other.currency} 余额`} value={formatMoney(other.total, other.currency)} />
      ))}
      {state?.available !== undefined && (
        <Line label="状态" value={state.available ? '可以调用' : <span className="usage-tone-danger">余额不足，DeepSeek 已不接受调用</span>} />
      )}
      {state?.alert !== undefined && <Line label="提醒线" value={formatMoney(state.alert, first?.currency ?? 'CNY')} />}
      <Line label="本月在 StarBench" value={month ? `输入 ${tokens(month.input)} · 输出 ${tokens(month.output)}` : '…'} />
      {state?.problem && (
        <p className="status-note status-problem" role="alert">
          {BALANCE_PROBLEMS[state.problem]}
        </p>
      )}
      <div className="status-compact">
        <span>{state?.checking ? '正在查询…' : state?.at ? <UpdatedAt at={state.at} now={now} /> : '还没有查到'}</span>
        <span className="usage-card-buttons">
          <button type="button" className="btn btn-small" disabled={state?.checking} onClick={() => void usageApi.balance(provider, true).catch(() => {})}>
            刷新
          </button>
          {onOpenUsage && (
            <button type="button" className="btn btn-small" onClick={onOpenUsage}>
              打开用量页
            </button>
          )}
        </span>
      </div>
    </>
  )
}

/** What the balance's widget in the row shows: the words on it, the word on its tip, its colour, and its card. */
export interface BalanceView {
  tip: string
  label: string
  chip: ReactNode
  tone?: 'warn' | 'danger'
  card: ReactNode
}

/**
 * The balance of the service in use, for the row under the message box: nothing where that
 * service tells no balance, or while the person has not switched the looks on (usage page).
 * Asked for when the row first shows it, and kept up to date after.
 */
export function useBalanceView(target: { provider: string; name: string } | undefined, onOpenUsage?: () => void): BalanceView | null {
  const on = useUsageSettings()?.balance === true
  const state = useBalance(on ? target?.provider : undefined)
  if (!target || !on) return null
  const tone = balanceTone(state)
  const first = state?.balances?.[0]
  const amount = first ? formatMoney(first.total, first.currency) : '—'
  const empty = state?.available === false
  return {
    tip: empty ? `${target.name} 余额不足` : tone === 'warn' ? `${target.name} 余额低于提醒线` : `${target.name} 余额`,
    label: `${target.name} 余额：${amount}${empty ? '，余额不足' : tone === 'warn' ? '，低于提醒线' : ''}`,
    ...(tone ? { tone } : {}),
    chip: (
      <>
        {tone === 'warn' ? <WarningIcon /> : <WalletIcon />}
        {empty ? '余额不足' : `余额 ${amount}`}
      </>
    ),
    card: <BalanceCard provider={target.provider} name={target.name} state={state} onOpenUsage={onOpenUsage} />
  }
}

/** Says in the corner, once each time it happens, that a balance has fallen below the person's line. Draws nothing itself. */
export function BalanceNotices() {
  useEffect(
    () =>
      usageApi.onEvent((event) => {
        if (event.type !== 'low') return
        const { balance } = event
        notify({
          kind: 'warning',
          key: `balance:${event.provider}`,
          title: `${event.name} 余额低于提醒线`,
          text: `现在是 ${formatMoney(balance.total, balance.currency)}，提醒线是 ${formatMoney(event.alert, balance.currency)}。`,
          link: { label: '去充值', href: DEEPSEEK_TOP_UP_URL },
          // Said once until the balance is above the line again: it must not go by unseen.
          sticky: true
        })
      }),
    []
  )
  return null
}
