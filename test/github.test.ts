// Links of an answer that lead to the web, and GitHub among them: what a link leads to as the
// person is shown it before it is followed, which sites are kept as ones not to ask about again,
// and which words of an answer name a pull request, an issue or a commit.

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { githubRepoOf } from '../src/main/github.ts'
import * as model from '../src/main/settings-model.ts'
import { commitAddress, githubCommit, githubRefs, isCommitHash, linkGitHubRefs, onGitHub, originRepo, repoOfRemote } from '../src/shared/github.ts'
import type { GitHubRepo, MarkdownNode } from '../src/shared/github.ts'
import { isSite, webPlace } from '../src/shared/links.ts'

const REPO: GitHubRepo = { owner: 'Longying-2403', name: 'StarBench' }
const HOME = 'https://github.com/Longying-2403/StarBench'

test('a link to the web is taken apart: the site, what stands in front of it, and what follows', () => {
  assert.deepEqual(webPlace('https://github.com/Longying-2403/StarBench/pull/5?diff=split#files'), {
    address: 'https://github.com/Longying-2403/StarBench/pull/5?diff=split#files',
    site: 'https://github.com',
    host: 'github.com',
    before: 'https://',
    after: '/Longying-2403/StarBench/pull/5?diff=split#files',
    named: false
  })
  // An address without "https:" is given it; a port belongs to the site.
  assert.equal(webPlace('//example.com/a.png')?.address, 'https://example.com/a.png')
  assert.deepEqual(
    [webPlace('http://localhost:8080/x')?.site, webPlace('http://localhost:8080/x')?.host],
    ['http://localhost:8080', 'localhost:8080']
  )
})

test('a name written in front of the site is told apart from the site, and said', () => {
  const place = webPlace('https://github.com@elsewhere.example/login')
  assert.equal(place?.host, 'elsewhere.example')
  assert.equal(place?.site, 'https://elsewhere.example')
  assert.equal(place?.before, 'https://github.com@')
  assert.equal(place?.named, true)
  assert.equal(webPlace('https://name:word@elsewhere.example/')?.before, 'https://name:word@')
  // A site spelt with a letter of another alphabet shows in the spelling of the address itself.
  assert.match(webPlace('https://g\u0456thub.com/')?.host ?? '', /^xn--/)
})

test('what is no page on the web is not one', () => {
  for (const address of ['', 'mailto:someone@example.com', 'javascript:alert(1)', 'file:///C:/out/a.png', 'C:\\out\\a.png', 'out/chart.png', 'https://']) {
    assert.equal(webPlace(address), null, address)
  }
})

test('a site is how it is reached and where, and nothing more', () => {
  assert.equal(isSite('https://github.com'), true)
  assert.equal(isSite('http://localhost:8080'), true)
  for (const value of ['https://github.com/', 'https://github.com/a', 'github.com', 'HTTPS://GitHub.com', 'https://name@github.com', '', 42, null, ['https://github.com']]) {
    assert.equal(isSite(value), false, String(value))
  }
})

test('the sites not to ask about again are kept each once, the latest first, and can be taken back', () => {
  const none = model.readSettings({})
  assert.equal(model.toPublic(none).trustedSites.length, 0)
  assert.equal('trustedSites' in none, false)

  const one = model.trustSite(none, 'https://github.com')
  const two = model.trustSite(one, 'https://www.electronjs.org')
  assert.deepEqual(model.toPublic(model.trustSite(two, 'https://github.com')).trustedSites, ['https://github.com', 'https://www.electronjs.org'])
  assert.equal(model.trustsSite(two, 'https://github.com'), true)
  // Another way of reaching it, or another name of it, is another site.
  assert.equal(model.trustsSite(two, 'http://github.com'), false)
  assert.equal(model.trustsSite(two, 'https://docs.github.com'), false)

  // What is no site is not kept, whoever sends it.
  for (const not of ['https://github.com/a', 'javascript:alert(1)', '', 7]) assert.throws(() => model.trustSite(none, not))

  const back = model.forgetSite(two, 'https://github.com')
  assert.deepEqual(back.trustedSites, ['https://www.electronjs.org'])
  assert.equal('trustedSites' in model.forgetSite(back, 'https://www.electronjs.org'), false)
  assert.deepEqual(model.forgetSite(two, 'https://not-kept.example').trustedSites, two.trustedSites)
})

test('a settings file is read with only the sites in it that are sites', () => {
  const read = model.readSettings({ trustedSites: ['https://github.com', 'https://github.com', 'https://github.com/path', 'nonsense', 3, 'http://localhost:3000'] })
  assert.deepEqual(read.trustedSites, ['https://github.com', 'http://localhost:3000'])
  const many = Array.from({ length: model.SITES_MAX + 20 }, (_, n) => `https://site-${n}.example`)
  assert.equal(model.readSettings({ trustedSites: many }).trustedSites?.length, model.SITES_MAX)
  // One more than the list holds: the oldest gives way.
  const full = model.readSettings({ trustedSites: many.slice(0, model.SITES_MAX) })
  const more = model.trustSite(full, 'https://newest.example').trustedSites ?? []
  assert.equal(more.length, model.SITES_MAX)
  assert.equal(more[0], 'https://newest.example')
  assert.equal(more.includes(`https://site-${model.SITES_MAX - 1}.example`), false)
})

test('GitHub is github.com, and nothing that only has its name in it', () => {
  for (const address of [`${HOME}`, 'https://www.github.com/a/b', 'http://github.com/a']) assert.equal(onGitHub(address), true, address)
  for (const address of ['https://gist.github.com/a/1', 'https://github.com.elsewhere.example/a/b', 'https://elsewhere.example/github.com', 'https://github.com@elsewhere.example/', 'mailto:a@github.com']) {
    assert.equal(onGitHub(address), false, address)
  }
})

test('the commit a GitHub address leads to', () => {
  assert.equal(githubCommit(`${HOME}/commit/b446e11`), 'b446e11')
  assert.equal(githubCommit(`${HOME}/commit/37B6435F00AA11BB22CC33DD44EE55FF66778899`), '37b6435f00aa11bb22cc33dd44ee55ff66778899')
  assert.equal(githubCommit(`${HOME}/pull/5/commits/b446e11`), 'b446e11')
  assert.equal(githubCommit(`${HOME}/commit/b446e11.patch`), 'b446e11')
  for (const address of [`${HOME}/commits/main`, `${HOME}/commit/not-a-hash`, `${HOME}/pull/5`, 'https://elsewhere.example/a/b/commit/b446e11']) {
    assert.equal(githubCommit(address), null, address)
  }
})

test('a hash is told from a number and from a word', () => {
  for (const hash of ['b446e11', '37b6435', '0123456789abcdef0123456789abcdef01234567']) assert.equal(isCommitHash(hash), true, hash)
  for (const not of ['1234567', 'defaced', 'B446E11', 'b446e1', 'b446e11z', '0123456789abcdef0123456789abcdef012345678', '']) assert.equal(isCommitHash(not), false, not)
})

test('the repository a remote leads to, in the ways git writes an address', () => {
  for (const address of [
    'https://github.com/Longying-2403/StarBench.git',
    'https://github.com/Longying-2403/StarBench',
    'https://github.com/Longying-2403/StarBench/',
    'git@github.com:Longying-2403/StarBench.git',
    'ssh://git@github.com/Longying-2403/StarBench.git',
    'ssh://git@github.com:22/Longying-2403/StarBench',
    'git://github.com/Longying-2403/StarBench.git',
    // A name and a token in the address are not looked at.
    'https://someone:not-a-real-token@github.com/Longying-2403/StarBench.git'
  ]) {
    assert.deepEqual(repoOfRemote(address), REPO, address)
  }
  assert.deepEqual(repoOfRemote('https://github.com/someone/my.repo.git'), { owner: 'someone', name: 'my.repo' })
  for (const address of ['https://gitlab.com/a/b.git', 'https://github.com.elsewhere.example/a/b', 'https://github.com/only-owner', 'https://github.com/a/b/more', 'git@elsewhere.example:a/b.git', '']) {
    assert.equal(repoOfRemote(address), null, address)
  }
})

test("a clone's settings name its origin, with either kind of line end", () => {
  const config = ['[core]', '\trepositoryformatversion = 0', '[remote "upstream"]', '\turl = https://github.com/someone/else.git', '[remote "origin"]', '\turl = https://github.com/Longying-2403/StarBench.git', '\tfetch = +refs/heads/*:refs/remotes/origin/*', '[branch "main"]', '\tremote = origin']
  assert.deepEqual(originRepo(config.join('\n')), REPO)
  assert.deepEqual(originRepo(config.join('\r\n')), REPO)
  assert.equal(originRepo('[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/a/b.git\n'), null)
  assert.equal(originRepo('[remote "origin"]\n\turl = https://gitlab.com/a/b.git\n'), null)
  assert.equal(originRepo(''), null)
})

const linked = (text: string, repo: GitHubRepo | null): [string, string][] => githubRefs(text, repo).map((ref) => [text.slice(ref.start, ref.end), ref.address])

test('words that name a pull request, an issue or a commit of the repository are found', () => {
  assert.deepEqual(linked('改动已经推送到 PR #5。提交 b446e11 只改了一个文件。', REPO), [
    ['PR #5', `${HOME}/pull/5`],
    ['b446e11', `${HOME}/commit/b446e11`]
  ])
  assert.deepEqual(linked('See pull request #7, PR#8 and Issue #12; 议题#3、拉取请求 #4。', REPO), [
    ['pull request #7', `${HOME}/pull/7`],
    ['PR#8', `${HOME}/pull/8`],
    ['Issue #12', `${HOME}/issues/12`],
    ['议题#3', `${HOME}/issues/3`],
    ['拉取请求 #4', `${HOME}/pull/4`]
  ])
  assert.deepEqual(linked('commit: 37b6435f and Commit 184c4d7', REPO), [
    ['37b6435f', `${HOME}/commit/37b6435f`],
    ['184c4d7', `${HOME}/commit/184c4d7`]
  ])
  // The little that may stand between the word and the hash.
  assert.deepEqual(linked('上一次的提交是 37b6435，提交号：e9d177b；commit hash 6127c95, commit sha c825fd1', REPO), [
    ['37b6435', `${HOME}/commit/37b6435`],
    ['e9d177b', `${HOME}/commit/e9d177b`],
    ['6127c95', `${HOME}/commit/6127c95`],
    ['c825fd1', `${HOME}/commit/c825fd1`]
  ])
  assert.equal(commitAddress(REPO, 'b446e11'), `${HOME}/commit/b446e11`)
})

test('a repository and a number written the short way are found wherever they stand; bare words only for the repository of the folder', () => {
  assert.deepEqual(linked('见 Longying-2403/StarBench#9 和 PR #5', null), [['Longying-2403/StarBench#9', `${HOME}/issues/9`]])
  assert.deepEqual(linked('PR #5，提交 b446e11', null), [])
})

test('what only looks like such words is left alone', () => {
  for (const text of [
    '第 #5 步',
    'expr #5 and spr#6',
    'color: #353941',
    '提交 1234567 条记录',
    'commit defaced the page',
    'commit B446E11',
    'PR #5a',
    'PR #',
    'src/main/index.ts#12',
    'https://github.com/a/b/issues/5#12',
    '提交了 b446e11x'
  ]) {
    assert.deepEqual(linked(text, REPO), [], text)
  }
})

test('in a Markdown text the words become links; what is a link or code already is left as it is', () => {
  const tree = (): MarkdownNode => ({
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [
          { type: 'text', value: '已推送到 PR #5。提交 ' },
          { type: 'inlineCode', value: 'b446e11' },
          { type: 'text', value: ' 见 ' },
          { type: 'link', url: 'https://elsewhere.example', title: null, children: [{ type: 'text', value: 'PR #6' }] },
          { type: 'text', value: '，另有 ' },
          { type: 'inlineCode', value: 'c0ffee1' }
        ]
      },
      { type: 'code', value: 'PR #7 and commit b446e11' }
    ]
  })
  const made = tree()
  linkGitHubRefs(made, REPO)
  assert.deepEqual(made.children?.[0].children, [
    { type: 'text', value: '已推送到 ' },
    { type: 'link', url: `${HOME}/pull/5`, title: null, children: [{ type: 'text', value: 'PR #5' }] },
    { type: 'text', value: '。提交 ' },
    { type: 'link', url: `${HOME}/commit/b446e11`, title: null, children: [{ type: 'inlineCode', value: 'b446e11' }] },
    { type: 'text', value: ' 见 ' },
    { type: 'link', url: 'https://elsewhere.example', title: null, children: [{ type: 'text', value: 'PR #6' }] },
    { type: 'text', value: '，另有 ' },
    // Code that reads like a hash, with no word for a commit in front of it, stays code.
    { type: 'inlineCode', value: 'c0ffee1' }
  ])
  assert.deepEqual(made.children?.[1], { type: 'code', value: 'PR #7 and commit b446e11' })

  // Without a repository of the folder, nothing of this is a link.
  const plain = tree()
  linkGitHubRefs(plain, null)
  assert.deepEqual(plain, tree())
})

const scratch = fs.mkdtemp(path.join(os.tmpdir(), 'starbench-github-'))
after(async () => fs.rm(await scratch, { recursive: true, force: true }))

test('the repository of a folder is read from the settings of its clone, also in a worktree, and nothing is read that is none', async () => {
  const root = await scratch
  const clone = path.join(root, 'clone')
  await fs.mkdir(path.join(clone, '.git', 'worktrees', 'side'), { recursive: true })
  await fs.writeFile(path.join(clone, '.git', 'config'), '[remote "origin"]\r\n\turl = git@github.com:Longying-2403/StarBench.git\r\n')
  assert.deepEqual(await githubRepoOf(clone), REPO)

  // A worktree: `.git` is a file that names where git keeps its things, and that names the clone's own folder.
  const side = path.join(root, 'side')
  await fs.mkdir(side)
  await fs.writeFile(path.join(side, '.git'), `gitdir: ${path.join(clone, '.git', 'worktrees', 'side')}\n`)
  await fs.writeFile(path.join(clone, '.git', 'worktrees', 'side', 'commondir'), '../..\n')
  assert.deepEqual(await githubRepoOf(side), REPO)

  const bare = path.join(root, 'no-clone')
  await fs.mkdir(bare)
  assert.equal(await githubRepoOf(bare), null)
  assert.equal(await githubRepoOf(path.join(root, 'missing')), null)

  // Settings far larger than a clone's are not read.
  const large = path.join(root, 'large')
  await fs.mkdir(path.join(large, '.git'), { recursive: true })
  await fs.writeFile(path.join(large, '.git', 'config'), `[remote "origin"]\n\turl = https://github.com/a/b.git\n${'#'.repeat(300 * 1024)}\n`)
  assert.equal(await githubRepoOf(large), null)
})
