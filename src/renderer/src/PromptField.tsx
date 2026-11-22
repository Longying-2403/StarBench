import { useState } from 'react'
import { CUSTOM_PROMPT_LIMIT } from '../../shared/types.ts'
import type { CustomPrompt } from '../../shared/types.ts'
import { errorText } from './util.ts'

const api = window.harness

/** What a provider starts with: no instructions of the person's own. */
export const NO_PROMPT: CustomPrompt = { text: '', replace: false }

/** A prompt as it is saved: null when nothing was written, which removes the stored one. */
export const promptToSave = (prompt: CustomPrompt): CustomPrompt | null => (prompt.text.trim() ? prompt : null)

/**
 * The person's own instructions for the models of one provider: the text, and whether it follows
 * the app's instructions or stands in their place. The app's own can be looked at underneath.
 * Shown in `PromptDialog`.
 */
export function PromptField({
  value,
  onChange,
  autoFocus
}: {
  value: CustomPrompt
  onChange: (next: CustomPrompt) => void
  /** The text is what the person came to write: the cursor starts in it. */
  autoFocus?: boolean
}) {
  /** The app's own instructions, read when they are first looked at. */
  const [builtin, setBuiltin] = useState<string | null>(null)
  const written = value.text.trim() !== ''
  const replacing = written && value.replace

  return (
    <div className="prompt-field">
      <label>
        自定义系统提示
        <textarea
          className="prompt-input"
          value={value.text}
          rows={5}
          autoFocus={autoFocus}
          maxLength={CUSTOM_PROMPT_LIMIT}
          placeholder="可以留空。写给这个服务的模型的固定要求，例如回答用的语言、代码风格，或者微调模型训练时用的那段系统提示。"
          onChange={(e) => onChange({ ...value, text: e.target.value })}
        />
      </label>
      <label className="check-row">
        <input type="checkbox" checked={replacing} disabled={!written} onChange={(e) => onChange({ ...value, replace: e.target.checked })} />
        用它替换内置提示
      </label>
      <span className="hint">
        {replacing
          ? '模型只会看到你写的内容，后面附上应用补充的几行环境信息（工作文件夹、系统、日期）和 Skill 清单。内置提示里的工作守则、模型名和“用你的语言思考”的要求都不再发送。'
          : '不勾选时，你写的内容加在内置提示后面，两者模型都会看到。'}
        从下一条消息开始生效。
      </span>
      <details
        className="prompt-builtin"
        onToggle={(e) => {
          if (e.currentTarget.open && builtin === null) api.builtinPrompt().then(setBuiltin, (err) => setBuiltin(errorText(err)))
        }}
      >
        <summary>查看内置提示</summary>
        <pre className="code">{builtin ?? '正在读取…'}</pre>
        <span className="hint">尖括号里的内容按每个对话填入。最后一行只在你用中文、日文或韩文提问时发送，让模型用同一种语言写思考过程。</span>
      </details>
    </div>
  )
}
