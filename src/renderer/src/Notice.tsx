import type { ReactNode } from 'react'
import { WarningIcon } from './icons.tsx'

/**
 * Something the person should not miss before going on: a wide bar in the warning colour, a mark,
 * and a tint behind the text.
 */
export function Notice({ children, className, role }: { children: ReactNode; className?: string; role?: 'status' | 'alert' }) {
  return (
    <div className={className ? `notice ${className}` : 'notice'} role={role}>
      <WarningIcon />
      <div className="notice-text">{children}</div>
    </div>
  )
}
