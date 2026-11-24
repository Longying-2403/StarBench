import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { WINDOW_BAR_HEIGHT, WINDOW_LOOKS, barless, windowButtons, windowGround } from '../src/main/window-look.ts'
import { DEFAULT_THEME, THEMES, isTheme } from '../src/shared/theme.ts'

test('the looks to choose from are the three the window knows, and the app comes going by the system', () => {
  // The names are handed to Electron as they are (`nativeTheme.themeSource`), so they have to be its own.
  assert.deepEqual([...THEMES].sort(), ['dark', 'light', 'system'])
  assert.equal(DEFAULT_THEME, 'system')
  for (const theme of THEMES) assert.equal(isTheme(theme), true, theme)
  for (const odd of ['Dark', 'auto', '', 0, null, undefined]) assert.equal(isTheme(odd), false, String(odd))
})

test('what is drawn of a look outside the page is drawn in the colours of that look', async () => {
  const css = await readFile(path.resolve('src/renderer/src/styles.css'), 'utf8')
  const valuesIn = (block: string | undefined): Record<string, string> =>
    Object.fromEntries([...(block ?? '').matchAll(/(--[a-z-]+):\s*([^;]+);/g)].map((found) => [found[1], found[2].trim()]))
  const dark = valuesIn(/:root \{([^}]*)\}/.exec(css)?.[1])
  const light = valuesIn(/@media \(prefers-color-scheme: light\) \{\s*:root \{([^}]*)\}/.exec(css)?.[1])
  assert.match(dark['--bg'], /^#[0-9a-f]{6}$/)
  assert.match(light['--bg'], /^#[0-9a-f]{6}$/)

  // The small pictures of the two looks under 设置 → 外观 name their colours a second time.
  for (const [look, whole] of [
    ['dark', dark],
    ['light', light]
  ] as const) {
    const picture = valuesIn(new RegExp(`\\.theme-look\\[data-look='${look}'\\] \\{([^}]*)\\}`).exec(css)?.[1])
    assert.deepEqual(Object.keys(picture).sort(), ['--bg', '--border', '--panel', '--raised'], `the ${look} picture: what it is drawn with`)
    for (const [name, value] of Object.entries(picture)) assert.equal(value, whole[name], `the ${look} picture: ${name}`)
  }

  // So does the window: for what it shows before the page has drawn, and for the buttons the system draws over the page.
  assert.deepEqual(WINDOW_LOOKS.dark, { ground: dark['--bg'], text: dark['--text'] })
  assert.deepEqual(WINDOW_LOOKS.light, { ground: light['--bg'], text: light['--text'] })
  assert.equal(windowGround(true), dark['--bg'])
  assert.equal(windowGround(false), light['--bg'])
})

test('on Windows the window has no title bar, and the system draws its buttons over the page in the page\'s colours', async () => {
  assert.equal(barless('win32'), true)
  // Elsewhere the window keeps the bar it has always had: nothing there was tried without it.
  for (const platform of ['darwin', 'linux'] as const) assert.equal(barless(platform), false, platform)

  assert.deepEqual(windowButtons(true), { color: WINDOW_LOOKS.dark.ground, symbolColor: WINDOW_LOOKS.dark.text, height: WINDOW_BAR_HEIGHT })
  assert.deepEqual(windowButtons(false), { color: WINDOW_LOOKS.light.ground, symbolColor: WINDOW_LOOKS.light.text, height: WINDOW_BAR_HEIGHT })

  // The page keeps a strip clear for those buttons, as high as the system says they are, and gives way to nothing where there are none.
  const css = await readFile(path.resolve('src/renderer/src/styles.css'), 'utf8')
  assert.match(css, /--window-bar: env\(titlebar-area-height, 0px\);/)
  assert.match(css, /\.stage,\s*\.plugin-panel \{\s*margin-top: var\(--window-bar\);/)
  // The strips the window is moved by mark a place for the system, and take no press away from what lies under them:
  // without that, the button that folds the sidebar could not be pressed.
  assert.match(css, /\.app::before,\s*\.sidebar::before \{[^}]*-webkit-app-region: drag;[^}]*pointer-events: none;/)
  assert.match(css, /\.sidebar-fold,\s*\.sidebar-resizer,[^{]*\{\s*-webkit-app-region: no-drag;/)
  // The window is made with them where it is made.
  const main = await readFile(path.resolve('src/main/index.ts'), 'utf8')
  assert.ok(main.includes("barless(process.platform) ? { titleBarStyle: 'hidden' as const, titleBarOverlay: windowButtons(dark) } : {}"))
})
