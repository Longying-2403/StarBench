// The look for a newer build, as the page shows it. On the About page of the settings: a button
// that looks now, a line that says what the last look found, and the switch that lets the app look
// by itself. In the corner of the window: a notice when a look of the app's own finds a newer
// build. What a look is and what it tells GitHub is in main/update-check.ts.

import { useCallback, useEffect, useState } from 'react'
import type { UpdateFailure, UpdateState } from '../../shared/update.ts'
import { whenExact, whenText } from '../../shared/when.ts'
import { notify } from './Toasts.tsx'
import { errorText, useNow } from './util.ts'

const api = window.harness

/** Why a look came to nothing, said to the person. */
const FAILURES: Record<UpdateFailure, string> = {
  offline: '没能检查：连不上 GitHub。',
  limited: '没能检查：GitHub 暂时不再回答这台电脑的请求，过一个小时再试。',
  refused: '没能检查：GitHub 没有给出发布列表。',
  unreadable: '没能检查：读不懂 GitHub 的回答。'
}

export interface Updates {
  /** Null until the app has said what it knows. */
  state: UpdateState | null
  /** Something went wrong between the page and the app, as against a look that failed. */
  error: string
  check(): void
  setAuto(on: boolean): void
}

/** What is known about updates, kept current as the app tells of changes. */
export function useUpdates(): Updates {
  const [state, setState] = useState<UpdateState | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let gone = false
    const take = (next: UpdateState): void => {
      if (!gone) setState(next)
    }
    api.updateState().then(take, (err: unknown) => !gone && setError(errorText(err)))
    const stop = api.onUpdateEvent((event) => event.type === 'state' && take(event.state))
    return () => {
      gone = true
      stop()
    }
  }, [])
  const check = useCallback((): void => {
    setError('')
    api.checkForUpdate().then(setState, (err: unknown) => setError(errorText(err)))
  }, [])
  const setAuto = useCallback((on: boolean): void => {
    setError('')
    api.setAutoUpdateCheck(on).then(setState, (err: unknown) => setError(errorText(err)))
  }, [])
  return { state, error, check, setAuto }
}

/**
 * The mark of something that is being tried out: the look for updates is one, for as long as the
 * app itself is in its Beta and its builds are not yet published the way finished ones will be.
 */
function BetaMark() {
  return <span className="badge update-beta">Beta</span>
}

/** The newer build that is known of, if there is one: for the way to it at the foot of the sidebar. */
export function newerBuild(state: UpdateState | null): { name: string } | null {
  return state?.finding?.state === 'newer' ? { name: state.finding.name } : null
}

/** Beside the version on the About page: looks now. Marked as being tried out. */
export function UpdateButton({ updates }: { updates: Updates }) {
  const checking = updates.state?.checking === true
  return (
    <>
      <button type="button" className="btn btn-small update-check" disabled={!updates.state || checking} onClick={updates.check}>
        {checking ? '正在检查…' : '检查更新'}
      </button>
      <BetaMark />
    </>
  )
}

/** Under the version: what the last look found, and when it was. Said aloud to a screen reader as it changes. */
export function UpdateStatus({ updates }: { updates: Updates }) {
  const now = useNow(30_000)
  const { state, error } = updates
  // "上次检查：刚刚", "上次检查：今天 08:10": the words in front, so that they read well before a time of day as before "3 分钟前".
  const when = state?.checked !== undefined ? <span data-tip={`检查于 ${whenExact(state.checked)}`}>上次检查：{whenText(state.checked, now)}</span> : null
  const finding = state?.finding
  return (
    <div className="update-status" role="status">
      {error && <span className="update-failed">{error}</span>}
      {state?.checking && <span>正在向 GitHub 查询…</span>}
      {state && !state.checking && state.failure && <span className="update-failed">{FAILURES[state.failure]}</span>}
      {state && !state.checking && finding?.state === 'newer' && (
        <>
          <span className="badge badge-active">有新版本 {finding.name}</span>
          {finding.published !== undefined && <span>{whenExact(finding.published).slice(0, 10)} 发布</span>}
          {/* The page of the release, made by the app from the tag of the build: opened in the browser. */}
          <a className="about-link" href={finding.page} target="_blank" rel="noreferrer">
            前往下载页面
          </a>
        </>
      )}
      {state && !state.checking && finding?.state === 'latest' && <span>已是最新版本</span>}
      {state && !state.checking && finding?.state === 'none' && <span>GitHub 上还没有已发布的版本</span>}
      {state && !state.checking && !finding && !state.failure && <span>还没有检查过。</span>}
      {state && !state.checking && finding && when}
      {/* Said under whatever the look found: it is being tried out, and a Beta build may find nothing. */}
      <span className="update-note">检查更新还在 Beta 阶段，Beta 版本可能不会生效。</span>
    </div>
  )
}

/** Under the list on the About page: whether the app looks by itself, and what a look tells GitHub. */
export function AutoUpdateRow({ updates }: { updates: Updates }) {
  return (
    <label className="setting-row update-auto">
      <span className="setting-words">
        <span className="setting-name update-auto-name">
          自动检查更新
          <BetaMark />
        </span>
        <span className="hint">启动后检查一次，每天最多一次。检查时只向 GitHub 查询已发布的版本，不发送任何个人信息；GitHub 会看到这台电脑的网络地址。应用不会自己下载或安装。</span>
      </span>
      <input type="checkbox" role="switch" className="switch" checked={updates.state?.auto === true} disabled={!updates.state} onChange={(e) => updates.setAuto(e.target.checked)} />
    </label>
  )
}

/**
 * Shows a notice in the corner of the window when a look of the app's own finds a newer build.
 * It stays until it is closed: it comes once for a build, and may come while nobody is looking.
 */
export function useUpdateNotice(): void {
  useEffect(() => {
    const stop = api.onUpdateEvent((event) => {
      if (event.type !== 'found') return
      notify({
        title: `有新版本 ${event.finding.name}`,
        text: `你现在用的是 ${event.current}。`,
        link: { label: '前往下载页面', href: event.finding.page },
        sticky: true,
        key: 'update'
      })
    })
    // Listening from here on: the app may look now, if the person lets it and a look is due. A look that fails is told on the About page and nowhere else.
    api.autoCheckForUpdate().catch(() => {})
    return stop
  }, [])
}
