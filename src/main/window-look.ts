// What the window itself is drawn with, outside the page: its ground until the page has drawn
// and, on Windows, the three buttons the system draws over the page's upper right corner where
// the window has no title bar. The colours are the page's own (styles.css); a test holds them to it.

/** The page's ground and its text in each look (`--bg` and `--text` in styles.css). */
export const WINDOW_LOOKS = {
  dark: { ground: '#16171a', text: '#e6e8ec' },
  light: { ground: '#f6f7f9', text: '#1c1e22' }
} as const

/** How high the system's buttons are, in pixels: the strip the page keeps clear along its top (`--window-bar`). */
export const WINDOW_BAR_HEIGHT = 36

/**
 * Whether the window goes without a title bar of the system's. On Windows, where the system can
 * draw its buttons over the page: the bar would only say the app's name again, above the sidebar
 * that says it too. Elsewhere the window keeps the bar it has always had.
 */
export const barless = (platform: NodeJS.Platform): boolean => platform === 'win32'

/** The ground of the window until the page has drawn. */
export const windowGround = (dark: boolean): string => WINDOW_LOOKS[dark ? 'dark' : 'light'].ground

/** The system's buttons over the page: on the page's ground, in the colour of its text. */
export function windowButtons(dark: boolean): { color: string; symbolColor: string; height: number } {
  const look = WINDOW_LOOKS[dark ? 'dark' : 'light']
  return { color: look.ground, symbolColor: look.text, height: WINDOW_BAR_HEIGHT }
}
