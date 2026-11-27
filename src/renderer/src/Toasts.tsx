// The notices in the top right corner of the window. What a notice is, how long it stays and how
// many are shown at once is in shared/toasts.ts; this draws them.

import { useSyncExternalStore } from 'react'
import { TOAST_MS, ToastStore } from '../../shared/toasts.ts'
import type { ToastInput } from '../../shared/toasts.ts'

/** The notices of this window. */
export const toasts = new ToastStore()

/** Shows a notice in the corner of the window. Returns its number, for taking it away early. */
export const notify = (input: ToastInput): number => toasts.add(input)

/**
 * The notices on show, newest at the top. Each has a band down its left side in the colour of
 * its kind. One that goes away by itself has its time running out along its lower edge, and the
 * time stands still while the pointer is on it or the keyboard is in it; a failure stays until
 * it is closed.
 */
export function ToastStack() {
  const list = useSyncExternalStore(toasts.subscribe, toasts.snapshot)
  return (
    // There from the start, also while empty: a screen reader announces what is put into a region it already knows.
    <div className="toasts" role="region" aria-label="通知">
      {list.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast-${toast.kind}`}
          role={toast.kind === 'error' ? 'alert' : 'status'}
          data-paused={toast.paused ? '' : undefined}
          onPointerEnter={() => toasts.pause(toast.id)}
          onPointerLeave={() => toasts.resume(toast.id)}
          onFocus={() => toasts.pause(toast.id)}
          onBlur={() => toasts.resume(toast.id)}
        >
          <div className="toast-words">
            <div className="toast-title">{toast.title}</div>
            {toast.text && <div className="toast-text">{toast.text}</div>}
            {toast.link && (
              <a className="toast-link" href={toast.link.href} target="_blank" rel="noreferrer">
                {toast.link.label}
              </a>
            )}
            {toast.actions && (
              <div className="toast-actions">
                {toast.actions.map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    className="toast-action"
                    onClick={() => {
                      // Done once: the notice goes with the press.
                      toasts.dismiss(toast.id)
                      action.run()
                    }}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button type="button" className="icon-btn toast-close" aria-label="关闭通知" onClick={() => toasts.dismiss(toast.id)}>
            ×
          </button>
          {!toast.sticky && <span className="toast-bar" style={{ animationDuration: `${TOAST_MS}ms` }} aria-hidden="true" />}
        </div>
      ))}
    </div>
  )
}
