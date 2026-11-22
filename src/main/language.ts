// Which language the person writes in, as far as the letters themselves tell. The model is told
// it in so many words, so that it thinks in that language (`thinkingIn` in agent.ts): asked only
// to think "in the language the user writes in", a real model that thinks in English by habit
// went on doing so more often than not, and told "The user writes in Chinese" it stopped.
//
// Only languages that their writing gives away are named: Chinese, Japanese and Korean. With any
// other the model is left to its habit, which for English is the right one.

import type { StoredMessage } from '../shared/types.ts'

/**
 * Characters that Traditional Chinese writes its own way, among the most used. Simplified
 * Chinese has another form for each of them, so none turns up in Simplified writing.
 */
const TRADITIONAL = new Set(
  '們這個為來時說國會學對發經過還沒麼樣開關問題幫變數稱訊檔錯誤請讓給嗎裡邊現實點機電腦網頁資庫碼寫讀執設檢測試' +
    '東後無與從應該當動處體種長門間聽話語買賣錢車見視覺認識記許論議譯輸轉運進選連專屬層歷氣決準產畫確簡單結構線級' +
    '組總續維編義習號萬術補裝規觀詞調費質軟載較輕辦達遠適錄鍵鏈閉閱隊際隨險雖雙雜難響項順須預領頭顯類風飛驗'
)

const count = (text: string, letters: RegExp): number => text.match(letters)?.length ?? 0

/** The language a text is written in, where its letters give it away. Undefined for every other language, and for no text. */
export function writtenIn(text: string): string | undefined {
  const han = count(text, /\p{Script=Han}/gu)
  const kana = count(text, /[\p{Script=Hiragana}\p{Script=Katakana}]/gu)
  const hangul = count(text, /\p{Script=Hangul}/gu)
  // With the name in its own writing beside it: without, a real model went on thinking in English.
  if (hangul > han + kana) return 'Korean (한국어)'
  // Japanese is written in Chinese characters as well, with kana among them. One kana in a
  // Chinese sentence, the の of a shop's name, does not make it Japanese.
  if (kana > 0 && kana * 4 >= han) return 'Japanese'
  if (han === 0) return undefined
  let traditional = 0
  for (const letter of text) if (TRADITIONAL.has(letter)) traditional++
  // Named apart, or the model thinks in Simplified characters for someone who writes the others.
  // "Chinese" comes first in the name: called "Traditional Chinese", a real model thought in
  // English again in one try of three. One quoted word does not make a sentence Traditional.
  return traditional * 10 >= han ? 'Chinese (繁體中文, Traditional characters)' : 'Chinese'
}

/**
 * The language of a conversation: that of the latest message of the person's that shows one. A
 * message that is only "ok", a path or a pasted error says nothing about it, and the language
 * stays what it was. A question in Chinese with a long English log under it is in Chinese.
 */
export function languageOf(messages: readonly StoredMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    const language = message.role === 'user' ? writtenIn(message.content) : undefined
    if (language) return language
  }
  return undefined
}
