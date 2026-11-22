// Run with: node --test test/session-search.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { searchSessions, searchableOf, termsOf } from '../src/main/session-search.ts'
import type { ChatMessage, SessionHit } from '../src/shared/types.ts'

const session = (id: string, title: string, messages: ChatMessage[]) => searchableOf({ id, title, messages })
const user = (content: string): ChatMessage => ({ role: 'user', content })
const model = (content: string, more: object = {}): ChatMessage => ({ role: 'assistant', content, ...more })

const sessions = [
  session('login', '重构登录模块', [
    user('帮我看看登录模块'),
    model('好的，我先读一下相关的文件。', { reasoning_content: '用户想重构 OAuth 回调。', tool_calls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"src/auth/session.ts"}' }] }),
    { role: 'tool', tool_call_id: 'c1', content: 'export function refreshToken() { /* 很长的文件内容 */ }' },
    model('登录流程里有两处可以合并：\n\n1. Token 刷新\n2. 会话恢复')
  ]),
  session('build', '修复构建脚本', [user('npm run build 报错了，说找不到 vite.config.ts'), model('这是因为路径写成了 Vite.Config.ts，大小写不对。')]),
  session('empty', '还没说话的对话', [])
]
const found = (query: string): string[] => searchSessions(sessions, query).map((hit) => hit.id)
const hit = (query: string, id: string): SessionHit | undefined => searchSessions(sessions, query).find((h) => h.id === id)
/** The piece of a message a hit comes with, the words that were found set off in brackets. */
const shown = ({ snippet }: SessionHit): string => {
  if (!snippet) return ''
  let out = ''
  let at = 0
  for (const [from, to] of snippet.marks) {
    out += `${snippet.text.slice(at, from)}[${snippet.text.slice(from, to)}]`
    at = to
  }
  return out + snippet.text.slice(at)
}

test('a conversation is found by its name, with nothing to show beside it', () => {
  assert.deepEqual(found('登录'), ['login'])
  assert.deepEqual(hit('登录', 'login'), { id: 'login' }, 'the name already shows where the word is')
  assert.deepEqual(found('构'), ['login', 'build'], 'in the order they were handed over')
  assert.deepEqual(found('没说话'), ['empty'])
})

test('a conversation is found by what was said in it, and comes with the place', () => {
  assert.deepEqual(found('大小写'), ['build'])
  assert.equal(shown(hit('大小写', 'build')!), '…Config.ts，[大小写]不对。')
  // What the person wrote counts as much as what the model answered, whatever the case of the letters.
  assert.deepEqual(found('NPM'), ['build'])
  // The piece shown starts at a word, not in the middle of one, and has the word as it was written.
  assert.equal(shown(hit('VITE.CONFIG', 'build')!), '…说找不到 [vite.config].ts')
  // Line breaks in a message do not break the line it is shown on.
  assert.equal(shown(hit('刷新', 'login')!), '…1. Token [刷新] 2. 会话恢复')
})

test('every word has to be there, in the name or in a message', () => {
  assert.deepEqual(found('登录 刷新'), ['login'])
  assert.equal(shown(hit('登录 刷新', 'login')!), '…1. Token [刷新] 2. 会话恢复', 'shown is the place of the word the name does not have')
  assert.deepEqual(found('登录 大小写'), [], 'one word in this conversation and the other in that one is not a find')
  assert.deepEqual(found('构建 vite'), ['build'])
  assert.deepEqual(found('run NPM'), ['build'], 'in whatever order they were typed')
  // The piece is the place of the word the name does not have, even when the name has the others.
  assert.equal(shown(hit('模块 合并 登录', 'login')!), '…里有两处可以[合并]： 1. Token 刷新 2. 会话恢复')
  // Every word that stands in the piece shown is set off.
  assert.equal(shown(hit('流程 合并', 'login')!), '登录[流程]里有两处可以[合并]： 1. Token 刷新 2. 会话恢复')
})

test('what the model thought and what the tools returned is not searched', () => {
  assert.deepEqual(found('OAuth'), [], 'thinking is not something that was said')
  assert.deepEqual(found('refreshToken'), [], 'nor is a file that was read')
  assert.deepEqual(found('session.ts'), [], 'nor what a tool was called with')
})

test('a search that is no search finds nothing, and odd characters are only characters', () => {
  assert.deepEqual([found(''), found('   '), found('\n')], [[], [], []])
  assert.deepEqual(termsOf('  Hello   WORLD hello '), ['hello', 'world'], 'the same word twice is one word')
  assert.equal(termsOf('a b c d e f g h i j k').length, 8)
  assert.equal(termsOf('x'.repeat(500))[0].length, 100)
  // Characters that mean something in a pattern are looked for as they are.
  const odd = [session('odd', '价格', [user('一共 $5.00 (含税) [草稿] a+b?')])]
  for (const query of ['$5.00', '(含税)', '[草稿]', 'a+b?', '.']) {
    assert.deepEqual(searchSessions(odd, query).map((h) => h.id), ['odd'], query)
  }
  assert.deepEqual(searchSessions(odd, '5x00'), [], 'a dot is a dot, not any character')
  assert.equal(searchSessions(odd, '(含税)')[0].snippet?.text.includes('(含税)'), true)
})

test('the piece shown starts a little before the word and does not run on', () => {
  const long = [session('long', '长对话', [model(`${'前'.repeat(300)}关键词${'后'.repeat(300)}`)])]
  const [{ snippet }] = searchSessions(long, '关键词')
  assert.ok(snippet)
  // Six Chinese characters are as wide as twelve Latin letters: the word is on the line of a narrow list.
  assert.equal(snippet.text, `…${'前'.repeat(6)}关键词${'后'.repeat(60)}…`)
  assert.deepEqual(snippet.marks, [[7, 10]])
  // At the very start of a message nothing is cut off before it.
  const [{ snippet: atStart }] = searchSessions([session('s', '短', [user('关键词在最前面')])], '关键词')
  assert.deepEqual(atStart, { text: '关键词在最前面', marks: [[0, 3]] })
})
