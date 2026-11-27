// Wherever the app cuts a text to a length, it cuts between characters (shared/well-formed.ts): a
// character of two units, an emoji or a rarer Chinese character, is left out whole and never
// halved. Each place is tried with a text of nothing but such characters, once as it is and once
// with a letter in front, so that one of the two has the cut fall inside a character whatever the
// length is.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fitTokens } from '../src/main/compaction.ts'
import { searchNote } from '../src/main/providers/history.ts'
import * as settings from '../src/main/settings-model.ts'
import { SkillStore } from '../src/main/skills.ts'
import { titleRecord } from '../src/main/title.ts'
import { ToolRegistry, registerBuiltinTools } from '../src/main/tools.ts'
import { FAILURE_TEXT_MAX, failureOf, readFailures } from '../src/shared/failures.ts'
import { TEXT_MAX, lineOf } from '../src/shared/memory.ts'
import { estimateTokens } from '../src/shared/stats.ts'
import { CUSTOM_PROMPT_LIMIT } from '../src/shared/types.ts'
import { isWhole } from '../src/shared/well-formed.ts'

const EMOJI = String.fromCodePoint(0x1f389)
/** Two texts of at least `units` units each, in which every place but the first is half of an emoji: at even places in one, at odd ones in the other. */
const both = (units: number): [string, string] => [EMOJI.repeat(Math.ceil(units / 2) + 2), `a${EMOJI.repeat(Math.ceil(units / 2) + 2)}`]

test('a tool result that is too heavy for the model is cut between characters', () => {
  for (const text of both(40_000)) {
    const fitted = fitTokens(text, 1000)
    assert.notEqual(fitted, text)
    assert.ok(isWhole(fitted), JSON.stringify(fitted.slice(0, 20)))
    assert.match(fitted, /\n… \[cut here to fit the model's context: \d+ more characters\./)
    assert.ok(estimateTokens(fitted) <= 1000)
  }
})

test('what is shown of a conversation to name it by is cut between characters', () => {
  for (const said of both(4000)) {
    for (const answer of both(4000)) {
      const record = titleRecord([
        { role: 'user', content: said },
        { role: 'assistant', content: answer }
      ])
      assert.ok(record && isWhole(record))
      assert.ok(record.length < 2600, String(record.length))
    }
  }
})

test('the note of a web search is cut between characters: what was asked, the titles and the addresses', () => {
  for (const title of both(400)) {
    for (const tail of both(600)) {
      const note = searchNote({ id: 's', kind: 'search', status: 'done', queries: [title], sources: [{ url: `https://example.com/${tail}`, title }] })
      assert.ok(isWhole(note), JSON.stringify(note.slice(0, 60)))
      assert.ok(note.length < 900, String(note.length))
      assert.ok(isWhole(searchNote({ id: 'o', kind: 'open', status: 'done', url: `https://example.com/${tail}` })))
    }
  }
})

test('a note of the memory that is longer than a line may be goes into the instructions cut between characters', () => {
  for (const text of both(TEXT_MAX * 2)) {
    const line = lineOf({ id: 'm1', kind: 'user', text })
    assert.ok(isWhole(line), JSON.stringify(line))
    assert.match(line, /^- \[user\] .+… #m1 \+$/u)
    assert.ok(line.length <= TEXT_MAX + '- [user]  #m1 +'.length)
  }
})

test('the reason a turn failed is kept cut between characters', () => {
  for (const message of both(FAILURE_TEXT_MAX + 100)) {
    const kept = failureOf({ message }, 1, 1000)
    assert.ok(isWhole(kept.message))
    assert.ok(kept.message.length === FAILURE_TEXT_MAX || kept.message.length === FAILURE_TEXT_MAX - 1)
    // Read from a file that holds it uncut, as an earlier version or a hand may have left it.
    const [read] = readFailures([{ turn: 1, at: 1000, message }])
    assert.equal(read.message, kept.message)
  }
  const lengths = both(FAILURE_TEXT_MAX + 100).map((message) => failureOf({ message }, 1, 1).message.length)
  assert.deepEqual(lengths.sort(), [FAILURE_TEXT_MAX - 1, FAILURE_TEXT_MAX])
})

test('the description of a skill and a prompt of the person are cut between characters', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'starbench cuts '))
  t.after(() => rm(root, { recursive: true, force: true }))
  const [even, odd] = both(700)
  for (const [name, description] of [['even', even], ['odd', odd]] as const) {
    await mkdir(path.join(root, name))
    await writeFile(path.join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nDo it.\n`)
  }
  const skills = await new SkillStore(root).list()
  assert.deepEqual(skills.map((skill) => skill.name), ['even', 'odd'])
  for (const skill of skills) assert.ok(isWhole(skill.description), skill.name)
  assert.deepEqual(skills.map((skill) => skill.description.length).sort(), [599, 600])

  const prompts = both(CUSTOM_PROMPT_LIMIT + 100).map((text) => {
    const read = settings.readSettings({ providers: [{ id: 'a', name: 'A', kind: 'openai-chat', baseURL: 'https://a.example', prompt: { text, replace: false } }] })
    return read.providers[0].prompt?.text ?? ''
  })
  for (const text of prompts) assert.ok(isWhole(text))
  assert.deepEqual(prompts.map((text) => text.length).sort(), [CUSTOM_PROMPT_LIMIT - 1, CUSTOM_PROMPT_LIMIT])
})

test('arguments that a tool does not take are handed back to the model cut between characters', async () => {
  const tools = new ToolRegistry()
  registerBuiltinTools(tools)
  for (const text of both(4000)) {
    const said = await tools.execute('read_file', JSON.stringify({ nope: text }), { workspace: os.tmpdir(), signal: new AbortController().signal })
    assert.match(said, /^Error: invalid arguments for read_file: .*Received: \{"nope":"/)
    assert.ok(isWhole(said), JSON.stringify(said.slice(-20)))
    assert.ok(said.length < 2200, String(said.length))
  }
})
