// Run with: node --test test/workspace-files.test.ts
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { MAX_IMAGE_BYTES, findNamed, howToOpen, pathsNamed, readImage } from '../src/main/workspace-files.ts'
import { fetchablePicture, namesFile, webAddress, writtenAddress } from '../src/shared/links.ts'

// The smallest PNG there is: one transparent pixel.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

/** A workspace with a picture, a picture whose name has a space and Chinese in it, a page, a script and a folder. */
async function workspaceWithFiles(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'starbench files '))
  await mkdir(path.join(root, 'out', 'charts'), { recursive: true })
  await writeFile(path.join(root, 'sunset.png'), PIXEL)
  await writeFile(path.join(root, 'out', '海上 夕阳.PNG'), PIXEL)
  await writeFile(path.join(root, 'out', 'report.html'), '<h1>report</h1>')
  await writeFile(path.join(root, 'out', 'run.bat'), 'echo hi')
  await writeFile(path.join(root, 'notes.txt'), 'not a picture')
  return root
}

test('an address in an answer is told apart: a file on this computer, or a place on the web', () => {
  for (const file of ['sunset.png', './out/chart.png', 'out\\chart.png', '../elsewhere.png', '/abs/chart.png', 'C:\\out\\chart.png', 'C:/out/chart.png', 'C:%5Cout%5Cchart.png', 'file:///C:/out/chart.png', 'out/%E6%B5%B7.png']) {
    assert.equal(namesFile(file), true, file)
  }
  for (const other of ['', 'https://example.com/a.png', 'http://localhost:3000', 'mailto:someone@example.com', '//example.com/a.png', '#user-content-fn-1', '?page=2', 'javascript:alert(1)', 'data:image/png;base64,AAAA']) {
    assert.equal(namesFile(other), false, other)
  }
  // An address that left out its scheme is one on the web: in a window that is a file, it would name a file on another computer.
  assert.equal(webAddress('//example.com/a.png'), 'https://example.com/a.png')
  assert.equal(webAddress('https://example.com/a.png?x=1'), 'https://example.com/a.png?x=1')
  // A picture is fetched over https or not at all.
  assert.equal(fetchablePicture('https://example.com/a.png'), true)
  for (const refused of ['http://example.com/a.png', 'file://server/share/a.png', '//example.com/a.png', 'data:image/png;base64,AAAA', '']) {
    assert.equal(fetchablePicture(refused), false, refused)
  }
  // The Markdown reader percent-encodes what the model wrote; a stray percent sign is left alone.
  assert.equal(writtenAddress('out/%E6%B5%B7%E4%B8%8A%20%E5%A4%95%E9%98%B3.PNG'), 'out/海上 夕阳.PNG')
  assert.equal(writtenAddress('100%.png'), '100%.png')
})

test('an address may stand for several paths, and the first that is there is the file', async () => {
  assert.deepEqual(pathsNamed('out/report.html#summary'), ['out/report.html#summary', 'out/report.html'])
  assert.deepEqual(pathsNamed('sunset.png?v=2#top'), ['sunset.png?v=2#top', 'sunset.png?v=2', 'sunset.png'])
  assert.deepEqual(pathsNamed('a%20b.png'), ['a b.png', 'a%20b.png'], 'as written, and as it came, in case the name really has a percent sign')
  assert.deepEqual(pathsNamed('file:///not a real address%'), [], 'an address that cannot be read names nothing')

  const root = await workspaceWithFiles()
  const found = async (address: string): Promise<string> => {
    const file = await findNamed(root, address)
    return typeof file === 'string' ? file : path.relative(root, file.full).split(path.sep).join('/') + (file.directory ? '/' : '')
  }
  assert.equal(await found('sunset.png'), 'sunset.png')
  assert.equal(await found('./out/../sunset.png'), 'sunset.png')
  assert.equal(await found('out/%E6%B5%B7%E4%B8%8A%20%E5%A4%95%E9%98%B3.PNG'), 'out/海上 夕阳.PNG')
  assert.equal(await found('out/report.html#summary'), 'out/report.html')
  assert.equal(await found('out/charts'), 'out/charts/')
  assert.equal(await found('.'), '/')
  // The whole path, as some models write it, and as an address.
  assert.equal(await found(path.join(root, 'sunset.png')), 'sunset.png')
  assert.equal(await found(pathToFileURL(path.join(root, 'out', 'report.html')).href), 'out/report.html')

  assert.equal(await found('nowhere.png'), 'missing')
  // Nothing outside the folder of the conversation, however it is written.
  assert.equal(await found('../sunset.png'), 'outside')
  assert.equal(await found(path.join(os.tmpdir(), 'elsewhere.png')), 'outside')
  assert.equal(await found(pathToFileURL(path.join(os.homedir(), 'secret.png')).href), 'outside')
  // Without a folder there is nothing to look in: not the folder the app happens to run in.
  assert.equal(await findNamed('', 'package.json'), 'outside')
  assert.equal(await findNamed('relative/folder', 'package.json'), 'outside')
})

test('a picture in the workspace is handed to the page, and nothing else is', async () => {
  const root = await workspaceWithFiles()
  assert.deepEqual(await readImage(root, 'sunset.png'), { ok: true, url: `data:image/png;base64,${PIXEL.toString('base64')}` })
  const named = await readImage(root, 'out/%E6%B5%B7%E4%B8%8A%20%E5%A4%95%E9%98%B3.PNG')
  assert.equal(named.ok && named.url.startsWith('data:image/png;base64,'), true, 'the kind is told from the name, whatever its case')

  assert.deepEqual(await readImage(root, 'nowhere.png'), { ok: false, reason: 'missing' })
  assert.deepEqual(await readImage(root, '../sunset.png'), { ok: false, reason: 'outside' })
  assert.deepEqual(await readImage(root, 'notes.txt'), { ok: false, reason: 'not-image' })
  assert.deepEqual(await readImage(root, 'out'), { ok: false, reason: 'not-image' })

  // One that is too large to send to the page in one piece is not read at all.
  const huge = path.join(root, 'huge.png')
  await writeFile(huge, '')
  await truncate(huge, MAX_IMAGE_BYTES + 1)
  assert.deepEqual(await readImage(root, 'huge.png'), { ok: false, reason: 'too-large' })
  await rm(huge)
})

test('a link opens what the system only shows, and points out what opening might run', () => {
  const file = (full: string): 'open' | 'reveal' => howToOpen({ full, directory: false })
  for (const shown of ['sunset.png', 'Report.PDF', 'page.html', 'notes.md', 'data.csv', 'slides.pptx', 'clip.mp4']) assert.equal(file(shown), 'open', shown)
  for (const run of ['run.bat', 'setup.exe', 'build.js', 'tool.py', 'script.ps1', 'app.lnk', 'site.url', 'macro.xlsm', 'old.doc', 'Makefile', 'archive.zip']) {
    assert.equal(file(run), 'reveal', run)
  }
  assert.equal(howToOpen({ full: path.join('out', 'charts'), directory: true }), 'open')
  // On a Mac a folder with an extension may be an application.
  assert.equal(howToOpen({ full: 'Tool.app', directory: true }), 'reveal')
})
