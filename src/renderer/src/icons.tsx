// Small line icons, drawn in the current text colour.

const line = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true
} as const

/** The symbol printed on the Enter key. */
export function EnterIcon() {
  return (
    <svg {...line}>
      <path d="M19 5v6a3 3 0 0 1-3 3H6" />
      <path d="m10 10-4 4 4 4" />
    </svg>
  )
}

export function StopIcon() {
  return (
    <svg {...line}>
      <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function FolderIcon() {
  return (
    <svg {...line}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  )
}

export function BoltIcon() {
  return (
    <svg {...line}>
      <path d="M13 3 5 13h6l-1 8 8-10h-6z" />
    </svg>
  )
}

/** An arrow turning back on itself: "put it back the way it was". */
export function ResetIcon() {
  return (
    <svg {...line}>
      <path d="M4 4v5h5" />
      <path d="M4.5 13a7.5 7.5 0 1 0 2-6.5L4 9" />
    </svg>
  )
}

export function CheckIcon() {
  return (
    <svg {...line}>
      <path d="m5 12 5 5 9-10" />
    </svg>
  )
}

export function PlusIcon() {
  return (
    <svg {...line}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

/** A pencil on a line: write something new. */
export function ComposeIcon() {
  return (
    <svg {...line}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  )
}

/** Three dots: more actions. */
export function MoreIcon() {
  return (
    <svg {...line} fill="currentColor" stroke="none">
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  )
}

/** Three sliders: settings. */
export function SettingsIcon() {
  return (
    <svg {...line}>
      <path d="M4 6h9M19 6h1M4 12h3M13 12h7M4 18h11M21 18h-1" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </svg>
  )
}

/** A storage box. */
export function ArchiveIcon() {
  return (
    <svg {...line}>
      <path d="M3 5h18v4H3zM5 9v10h14V9M10 13h4" />
    </svg>
  )
}

export function TrashIcon() {
  return (
    <svg {...line}>
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />
    </svg>
  )
}

export function ChevronDownIcon() {
  return (
    <svg {...line} width={12} height={12}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}
