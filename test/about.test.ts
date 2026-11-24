// Run with: node --test test/about.test.ts
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { ABOUT, buildLabel } from '../src/shared/about.ts'

test('what the About page says of the project is what the project says of itself', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8')) as { homepage: string; repository: { url: string }; author: string; version: string }
  // Where the code is: the same place the package names.
  assert.equal(ABOUT.repo.url, manifest.homepage)
  assert.equal(manifest.repository.url, `git+${ABOUT.repo.url}.git`)
  assert.equal(ABOUT.issues.url, `${ABOUT.repo.url}/issues`)
  assert.equal(ABOUT.repo.label, ABOUT.repo.url.replace('https://', ''))
  // Who makes it: the author the package names comes first, then the team that tests it.
  assert.equal(ABOUT.authors[0].name, manifest.author)
  assert.deepEqual(
    ABOUT.authors.map((who) => who.role),
    ['作者', '参与测试的团队']
  )
  // Every address is a page on GitHub, written without a slash at its end.
  for (const { url } of [ABOUT.repo, ABOUT.issues, ...ABOUT.authors]) assert.match(url, /^https:\/\/github\.com\/[\w-]+(\/[\w-]+)*$/, url)
  // The page shows the version of the running app; the package has one to show.
  assert.match(manifest.version, /^\d+\.\d+\.\d+/)
  assert.equal(ABOUT.stage, 'Beta')
  // Beside the version stands the revision: a whole number, counted from one.
  assert.ok(Number.isInteger(ABOUT.revision) && ABOUT.revision >= 1, String(ABOUT.revision))
  // A build is named by both, with "-r." between them: the hyphen and the dot are the author's.
  assert.equal(buildLabel('0.1.0', 11), '0.1.0-r.11')
  assert.equal(buildLabel(manifest.version), `${manifest.version}-r.${ABOUT.revision}`)
})
