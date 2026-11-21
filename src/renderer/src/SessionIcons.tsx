// The marks a session can be given in the list: small line drawings, each in a colour of its own,
// so that a session is found again by its shape and its colour.

import type { ReactNode } from 'react'
import type { SessionIcon } from '../../shared/types.ts'
import { line } from './icons.tsx'

interface Mark {
  /** Shown when the pointer rests on the choice, and read out by screen readers. */
  label: string
  /** The colour of the theme the mark is drawn in. */
  tone: 'accent' | 'peak' | 'danger' | 'warn' | 'ok'
  shape: ReactNode
}

const MARKS: Record<SessionIcon, Mark> = {
  star: {
    label: '星标',
    tone: 'warn',
    shape: <path d="M12 3 14.5 9.1 21 9.6 16 13.8 17.6 20.2 12 16.7 6.4 20.2 8 13.8 3 9.6 9.5 9.1z" />
  },
  heart: {
    label: '喜欢',
    tone: 'danger',
    shape: <path d="M12 20.5 4.6 12.9a4.7 4.7 0 0 1 6.6-6.7l.8.8.8-.8a4.7 4.7 0 0 1 6.6 6.7z" />
  },
  flag: {
    label: '旗标',
    tone: 'danger',
    shape: <path d="M5 21V4h12l-2.5 4.5L17 13H5" />
  },
  bookmark: {
    label: '书签',
    tone: 'accent',
    shape: <path d="M7 3h10a1 1 0 0 1 1 1v17l-6-4.5L6 21V4a1 1 0 0 1 1-1z" />
  },
  pin: {
    label: '图钉',
    tone: 'accent',
    shape: <path d="M9 4h6l-1 6 3.5 3.5V15h-11v-1.5L10 10zM12 15v6" />
  },
  bolt: {
    label: '闪电',
    tone: 'warn',
    shape: <path d="M13 3 5 13h6l-1 8 8-10h-6z" />
  },
  bulb: {
    label: '想法',
    tone: 'warn',
    shape: <path d="M12 2a6 6 0 0 0-4 10.5c.6.6 1 1 1 1.5h6c0-.5.4-.9 1-1.5A6 6 0 0 0 12 2zM9 18h6M10 21.5h4" />
  },
  rocket: {
    label: '发布',
    tone: 'peak',
    shape: (
      <>
        <path d="M12 2.5c3.2 2.3 5 5.6 5 9.5v4H7v-4c0-3.9 1.8-7.2 5-9.5z" />
        <path d="M7 12l-3 3.5V19l3-3M17 12l3 3.5V19l-3-3M10 16c0 2 .8 3.6 2 5.5 1.2-1.9 2-3.5 2-5.5" />
        <circle cx="12" cy="10" r="1.5" />
      </>
    )
  },
  bug: {
    label: '排错',
    tone: 'danger',
    shape: (
      <>
        <path d="M8 10a4 4 0 0 1 8 0v5a4 4 0 0 1-8 0z" />
        <path d="M9.5 6.5 8 4M14.5 6.5 16 4M8 11H4.5M8 15H4.5M16 11h3.5M16 15h3.5M8.6 18 6 20.5M15.4 18l2.6 2.5" />
      </>
    )
  },
  code: {
    label: '代码',
    tone: 'accent',
    shape: <path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14" />
  },
  terminal: {
    label: '终端',
    tone: 'ok',
    shape: (
      <>
        <rect x="3" y="4.5" width="18" height="15" rx="2" />
        <path d="m7 10 3 2.5L7 15M13 15h4" />
      </>
    )
  },
  flask: {
    label: '实验',
    tone: 'peak',
    shape: <path d="M9 3h6M10 3v6l-5.2 9a2 2 0 0 0 1.7 3h11a2 2 0 0 0 1.7-3L14 9V3M7.5 15h9" />
  },
  book: {
    label: '文档',
    tone: 'accent',
    shape: <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v18H6.5A1.5 1.5 0 0 1 5 19.5zM5 18.5A1.5 1.5 0 0 1 6.5 17H19" />
  },
  pencil: {
    label: '写作',
    tone: 'peak',
    shape: <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4zM14 6l3 3" />
  },
  chat: {
    label: '讨论',
    tone: 'ok',
    shape: <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-4.5 3.5V17H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />
  },
  globe: {
    label: '网络',
    tone: 'accent',
    shape: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9s1.3-6.4 3.8-9z" />
      </>
    )
  },
  check: {
    label: '完成',
    tone: 'ok',
    shape: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="m8 12.5 3 3 5-6" />
      </>
    )
  }
}

export const markLabel = (name: SessionIcon): string => MARKS[name].label

/** The drawing of a mark, in its colour. */
export function SessionMark({ name }: { name: SessionIcon }) {
  const { tone, shape } = MARKS[name]
  return (
    <svg {...line} style={{ color: `var(--${tone})` }}>
      {shape}
    </svg>
  )
}

/** A crossed-out circle: no mark. */
export function NoMarkIcon() {
  return (
    <svg {...line}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m6 6 12 12" />
    </svg>
  )
}
