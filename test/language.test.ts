// Run with: node --test test/language.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { languageOf, writtenIn } from '../src/main/language.ts'
import type { ChatMessage } from '../src/shared/types.ts'

test('the language of a text is told from its letters, where a language has letters of its own', () => {
  assert.equal(writtenIn('9.11 和 9.9 哪个大？一句话说明理由。'), 'Chinese')
  assert.equal(writtenIn('好'), 'Chinese')
  // A question in Chinese is in Chinese, whatever is pasted under it.
  const log = "TypeError: Cannot read properties of undefined (reading 'map')\n    at App (App.tsx:42:18)\n".repeat(40)
  assert.equal(writtenIn(`${log}这个报错一般是什么原因？`), 'Chinese')

  // The other way of writing Chinese is named, so that the model does not think in Simplified characters.
  assert.equal(writtenIn('幫我想一個變數名稱，用來存使用者上次登入的時間。'), 'Chinese (繁體中文, Traditional characters)')
  assert.equal(writtenIn('幫我看一下'), 'Chinese (繁體中文, Traditional characters)')
  // One quoted word does not make a sentence Traditional.
  assert.equal(writtenIn('“檔案”在简体中文里叫文件，这两个词有什么区别吗？'), 'Chinese')

  // Japanese is written in Chinese characters too: the kana among them tell it apart.
  assert.equal(writtenIn('JavaScript の let と const の違いを一文で説明してください。'), 'Japanese')
  assert.equal(writtenIn('ありがとう'), 'Japanese')
  // The の of a shop's name in a Chinese sentence does not.
  assert.equal(writtenIn('优の良品这家店的零食怎么样？'), 'Chinese')

  assert.equal(writtenIn('자바스크립트에서 let과 const의 차이를 한 문장으로 설명해 주세요.'), 'Korean (한국어)')

  // No language is named for the rest: the model keeps its habit, and nothing is said of it.
  for (const other of ['', 'ok', 'Which is bigger, 9.11 or 9.9?', 'Привет, как дела?', 'src/main/agent.ts', '。，！？「」（）…']) {
    assert.equal(writtenIn(other), undefined, JSON.stringify(other))
  }
})

test('a conversation is in the language of the latest message of the person that shows one', () => {
  const answer: ChatMessage = { role: 'assistant', content: 'こんにちは。' }
  assert.equal(languageOf([]), undefined)
  assert.equal(languageOf([{ role: 'user', content: 'hello' }, answer]), undefined, 'what the model wrote does not count')

  // "ok", a path or a pasted error says nothing: the language stays what it was.
  const chinese: ChatMessage[] = [{ role: 'user', content: '这个文件夹里有什么？' }, answer, { role: 'user', content: 'ok' }, answer, { role: 'user', content: 'npm run dev' }]
  assert.equal(languageOf(chinese), 'Chinese')
  // Someone who changes language is followed.
  assert.equal(languageOf([...chinese, answer, { role: 'user', content: 'ファイルを一覧してください' }]), 'Japanese')

  // What a tool read is not the person's writing.
  assert.equal(
    languageOf([
      { role: 'user', content: 'read notes.txt' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"notes.txt"}' }] },
      { role: 'tool', tool_call_id: 'c1', content: '周五之前把登录页的按钮改成蓝色。' }
    ]),
    undefined
  )
})
