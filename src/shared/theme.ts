// The look of the app: its dark colours, its light ones, or whichever of the two the system is
// set to. Chosen under 设置 → 外观 and kept in the settings.

/** What can be chosen, in the order it is offered. */
export const THEMES = ['system', 'light', 'dark'] as const
export type Theme = (typeof THEMES)[number]

/** How the app comes: it goes by the system, as it did before there was a choice. */
export const DEFAULT_THEME = 'system' satisfies Theme

export const isTheme = (value: unknown): value is Theme => THEMES.some((theme) => theme === value)
