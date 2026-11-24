// Small line icons, drawn in the current text colour.

export const line = {
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

/** A globe: the web, which the model searches with its service's own tool. */
export function GlobeIcon() {
  return (
    <svg {...line}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9s1.3-6.4 3.8-9z" />
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

/** A quill writing a line: begin something new. */
export function QuillIcon() {
  return (
    <svg {...line}>
      <path d="M20.5 3C16 2.5 11.5 4.7 9.7 10.9l2.7 2.7C15.3 12.8 19 9.2 20.5 3z" />
      <path d="M6.5 16.8 15 8.3" />
      <path d="M4 20.5h1M9.5 20.5H20" />
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

/** A magnifying glass: look for something. */
export function SearchIcon() {
  return (
    <svg {...line}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.3-4.3" />
    </svg>
  )
}

/** A clock: how long something took. */
export function ClockIcon() {
  return (
    <svg {...line}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  )
}

/** A stack of discs: how much of something was used. */
export function StackIcon() {
  return (
    <svg {...line}>
      <ellipse cx="12" cy="6" rx="7.5" ry="3" />
      <path d="M4.5 6v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6" />
      <path d="M4.5 12v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" />
    </svg>
  )
}

/** A plug: what is added to the app from outside. */
export function PluginIcon() {
  return (
    <svg {...line}>
      <path d="M9 3v5M15 3v5" />
      <path d="M6 8h12v3a6 6 0 0 1-12 0z" />
      <path d="M12 17v4" />
    </svg>
  )
}

/** A triangle with an exclamation mark: read this before going on. */
export function WarningIcon() {
  return (
    <svg {...line}>
      <path d="M12 4 2.5 20h19z" />
      <path d="M12 10v4.5M12 17.2v.3" />
    </svg>
  )
}

export function ChevronLeftIcon() {
  return (
    <svg {...line}>
      <path d="m15 6-6 6 6 6" />
    </svg>
  )
}

export function ChevronRightIcon() {
  return (
    <svg {...line} width={12} height={12}>
      <path d="m9 6 6 6-6 6" />
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

/** A paper clip: put a file with the message. */
export function PaperclipIcon() {
  return (
    <svg {...line}>
      <path d="M20.5 11.5 12 20a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.7a1.7 1.7 0 0 1-2.4-2.4L15 7.6" />
    </svg>
  )
}

/** An open book: the skills, which are instructions a model looks up when it needs them. */
export function BookIcon() {
  return (
    <svg {...line}>
      <path d="M12 6.5C10.5 5.2 8.3 4.5 5 4.5H3v13h2c3.3 0 5.5.7 7 2 1.5-1.3 3.7-2 7-2h2v-13h-2c-3.3 0-5.5.7-7 2z" />
      <path d="M12 6.5v13" />
    </svg>
  )
}

/** A speech bubble with lines in it: what the model is told every time. */
export function PromptIcon() {
  return (
    <svg {...line}>
      <path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-8l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />
      <path d="M7.5 9.5h9M7.5 13h6" />
    </svg>
  )
}

/** A bug: looking into why something behaves as it does. */
export function BugIcon() {
  return (
    <svg {...line}>
      <path d="M8 10.5a4 4 0 0 1 8 0V15a4 4 0 0 1-8 0z" />
      <path d="M9.5 6.8a2.5 2.5 0 0 1 5 0" />
      <path d="M12 11v8M8 12H4.5M8 16H5M16 12h3.5M16 16h3M9 5 7.5 3.5M15 5l1.5-1.5" />
    </svg>
  )
}

/** An eye: looking, and nothing more. */
export function EyeIcon() {
  return (
    <svg {...line}>
      <path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </svg>
  )
}

/** A raised hand: stop and ask first. */
export function HandIcon() {
  return (
    <svg {...line}>
      <path d="M8 12.5V6.2a1.4 1.4 0 0 1 2.8 0V11" />
      <path d="M10.8 11V4.4a1.4 1.4 0 0 1 2.8 0V11" />
      <path d="M13.6 11V5.4a1.4 1.4 0 0 1 2.8 0v6.1" />
      <path d="M16.4 11.5V8.2a1.4 1.4 0 0 1 2.8 0v6.3a6.5 6.5 0 0 1-6.5 6.5h-1.3a6 6 0 0 1-4.7-2.3l-3-3.9a1.5 1.5 0 0 1 2.4-1.8L8 14.9" />
    </svg>
  )
}

/** A pencil: changing what is written. */
export function PencilIcon() {
  return (
    <svg {...line}>
      <path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z" />
      <path d="m14.5 6.5 3 3" />
    </svg>
  )
}

/** A padlock left open: nothing is held back. */
export function UnlockIcon() {
  return (
    <svg {...line}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7.5a4 4 0 0 1 7.6-1.7" />
    </svg>
  )
}

/** A sheet of paper with lines: a text file. */
export function FileIcon() {
  return (
    <svg {...line}>
      <path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M14 3v5h5M9 13h6M9 17h6" />
    </svg>
  )
}

/**
 * The star of the app's own icon (build/icon.svg), four points drawn in one piece and filled. It
 * stands beside the app's name on the first page; its size and colour are given where it is used.
 */
export function StarIcon() {
  return (
    <svg className="star" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 1Q14.14 9.86 23 12Q14.14 14.14 12 23Q9.86 14.14 1 12Q9.86 9.86 12 1Z" />
    </svg>
  )
}

/** The sun: the light look of the app. */
export function SunIcon() {
  return (
    <svg {...line}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
    </svg>
  )
}

/** A crescent moon: the dark look of the app. */
export function MoonIcon() {
  return (
    <svg {...line}>
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
    </svg>
  )
}

/** A screen on its stand: the look the system is set to. */
export function MonitorIcon() {
  return (
    <svg {...line}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  )
}

/**
 * The app's own icon, as the window and the taskbar show it (build/icon.svg): a prompt and a
 * star on a dark ground. It keeps its colours in either look of the app. Drawn once in the page
 * at a time, since the ground is named by an id. A test holds it to that file.
 */
export function AppIcon() {
  return (
    <svg className="app-icon" viewBox="0 0 512 512" aria-hidden="true">
      <defs>
        <radialGradient id="app-icon-ground" cx="346" cy="286" r="360" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#22396c" />
          <stop offset="1" stopColor="#111b35" />
        </radialGradient>
      </defs>
      <rect width="512" height="512" rx="112" fill="url(#app-icon-ground)" />
      <polyline points="116,176 212,256 116,336" fill="none" stroke="#fff" strokeWidth="44" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M346 214Q360 272 418 286Q360 300 346 358Q332 300 274 286Q332 272 346 214Z" fill="#5b8def" />
    </svg>
  )
}

/** A window with its left column marked off and an arrow into that column: the sidebar folds away. */
export function FoldIcon() {
  return (
    <svg {...line}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M16 10l-2 2 2 2" />
    </svg>
  )
}

/** The same window with the arrow out of the column: the sidebar opens again. */
export function UnfoldIcon() {
  return (
    <svg {...line}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M14 10l2 2-2 2" />
    </svg>
  )
}
