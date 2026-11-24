// The page's way to the record of what was asked of the model services and to DeepSeek's
// balance: `window.usage`, put there by the preload script beside `window.harness`
// (src/preload/index.ts).

import { useEffect, useState } from 'react'
import type { BalanceState, UsageApi, UsageSettings } from '../../shared/usage.ts'

declare global {
  interface Window {
    usage: UsageApi
  }
}

export const usageApi: UsageApi = window.usage

/** What the person chose on the usage page, kept up to date as it changes. Null until it is known. */
export function useUsageSettings(): UsageSettings | null {
  const [settings, setSettings] = useState<UsageSettings | null>(null)
  useEffect(() => {
    let current = true
    const off = usageApi.onEvent((event) => {
      if (event.type === 'settings') setSettings(event.settings)
    })
    usageApi.settings().then(
      (told) => {
        if (current) setSettings(told)
      },
      () => {}
    )
    return () => {
      current = false
      off()
    }
  }, [])
  return settings
}

/**
 * The balance of a DeepSeek service as last known: asked for when it is first needed (the main
 * process answers from what it was told a moment ago where it can), and kept up to date as looks
 * begin and end. Null until something is known, and for no service at all.
 */
export function useBalance(providerId: string | undefined): BalanceState | null {
  const [state, setState] = useState<BalanceState | null>(null)
  useEffect(() => {
    setState(null)
    if (!providerId) return
    let current = true
    const off = usageApi.onEvent((event) => {
      if (event.type === 'balance' && event.state.provider === providerId) setState(event.state)
    })
    usageApi.balance(providerId).then(
      (told) => {
        if (current) setState(told)
      },
      () => {}
    )
    return () => {
      current = false
      off()
    }
  }, [providerId])
  return state
}
