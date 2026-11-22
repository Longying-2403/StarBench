// 把一次往来的记录（StarBench 交给 ctx.trace.observe 的 Exchange）变成面板上显示的文字。
// 这里的函数都不碰界面，测试直接用它们。

const two = (n) => String(n).padStart(2, '0')

/** 时刻显示成 时:分:秒。 */
export function clock(at) {
  const d = new Date(at)
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

/** 毫秒显示成秒：不到 10 秒留两位小数，再长留一位。 */
export function seconds(ms) {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} 秒`
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 服务报告的用量里，输入和输出各多少 token。各家的字段名不一样：Chat Completions 用
 * prompt_tokens / completion_tokens，Responses 和 Anthropic 用 input_tokens / output_tokens。
 * 没有报告的那一项就没有。
 * @returns {{ input?: number, output?: number }}
 */
export function tokensOf(usage) {
  if (!isObject(usage)) return {}
  const pick = (...names) => {
    for (const name of names) if (typeof usage[name] === 'number' && Number.isFinite(usage[name])) return usage[name]
    return undefined
  }
  const input = pick('prompt_tokens', 'input_tokens')
  const output = pick('completion_tokens', 'output_tokens')
  return { ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}) }
}

/**
 * 输出速度：每秒多少 token。服务报告了输出的 token 数就用它；没有报告时用回应到达的段数估计
 * （很多本地服务一个 token 发一段），这时 estimated 为 true。算不出来时返回 undefined。
 * @returns {{ perSecond: number, estimated: boolean } | undefined}
 */
export function speedOf(exchange) {
  const { first, total } = exchange.timing
  // 流式的回应记着第一段是什么时候到的，一次取回的回应没有这一项。到达的段数只数文字和思考，
  // 所以只有一个工具调用的回应段数是 0，也照样是流式的。
  const streamed = typeof first === 'number'
  // 流式的回应从第一段到达算起：之前的时间是服务在读提示词，还没有开始输出。
  const ms = streamed ? total - first : total
  const reported = tokensOf(exchange.usage).output
  const count = reported ?? (streamed && exchange.pieces > 1 ? exchange.pieces : undefined)
  if (count === undefined || count <= 0 || !(ms > 0)) return undefined
  return { perSecond: (count * 1000) / ms, estimated: reported === undefined }
}

/** 请求体里放长内容的字段：对话、工具和提示词。其余的就是“参数”。 */
const LONG_FIELDS = new Set(['messages', 'tools', 'input', 'system', 'instructions'])

/**
 * 请求体里的参数：除了对话、工具、提示词之外的所有字段，例如 model、stream、temperature、max_tokens。
 * 想确认某个参数有没有真的发出去，看它就够了。
 */
export function settingsOf(body) {
  if (!isObject(body)) return {}
  return Object.fromEntries(Object.entries(body).filter(([name]) => !LONG_FIELDS.has(name)))
}

/**
 * 放在消息列表之外的系统提示：Responses 格式叫 instructions，应用自己的表述里叫 system。
 * Chat Completions 格式的系统提示本身就是第一条消息，这里没有。
 * @returns {{ name: string, text: string } | undefined}
 */
function promptOf(body) {
  if (typeof body.instructions === 'string' && body.instructions) return { name: 'instructions', text: body.instructions }
  if (typeof body.system === 'string' && body.system) return { name: 'system', text: body.system }
  return undefined
}

/**
 * 请求体里有多少条消息；看不出来时是 undefined。放在列表之外的系统提示也算一条，
 * 这样同一段对话不管用哪种格式发，数出来的差不多。
 */
export function messageCount(body) {
  if (!isObject(body)) return undefined
  const list = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : undefined
  return list === undefined ? undefined : list.length + (promptOf(body) ? 1 : 0)
}

/** 内容显示成文字：本来就是文字的原样显示，别的显示成 JSON，没有的是空字符串。 */
const words = (content) => (typeof content === 'string' ? content : content === undefined || content === null ? '' : pretty(content))

/**
 * Responses 格式的一项输入写成的几行文字。这种格式里，一条回复拆成好几项：思考、回答、每个工具调用
 * 各是一项，工具的结果也是单独的一项。
 */
function inputLines(item) {
  if (!isObject(item)) return [pretty(item)]
  if (item.type === 'reasoning') {
    const texts = (parts) =>
      (Array.isArray(parts) ? parts : [])
        .map((part) => (isObject(part) && typeof part.text === 'string' ? part.text : ''))
        .filter(Boolean)
        .join('\n\n')
    const summary = texts(item.summary)
    // 有的服务（多是自己运行的开源模型）把思考的原文直接放在 content 里，不加密。
    const plain = texts(item.content)
    const lines = [
      ...(summary ? [`（思考摘要）${summary}`] : []),
      ...(plain ? [`（思考）${plain}`] : []),
      // 加密的原文只有写它的模型读得懂；带回去，模型才接得上之前的思路。
      ...(typeof item.encrypted_content === 'string' ? [`（加密的思考原文，${item.encrypted_content.length} 个字符）`] : [])
    ]
    // 三样都没有的，原样显示出来，免得看上去像是什么都没带。
    return ['【reasoning】', ...(lines.length ? lines : [pretty(item)])]
  }
  if (item.type === 'function_call') return ['【assistant】', `（调用工具 ${item.call_id ?? ''}）${item.name ?? '?'} ${words(item.arguments)}`]
  if (item.type === 'function_call_output') return [`【tool，回应 ${item.call_id ?? ''}】`, words(item.output)]
  if (item.type === undefined || item.type === 'message') {
    // 回答的内容是分段的；每段都是文字时连起来显示。
    const parts = Array.isArray(item.content) ? item.content : undefined
    const content = parts && parts.every((part) => isObject(part) && typeof part.text === 'string') ? parts.map((part) => part.text).join('') : words(item.content)
    return [`【${String(item.role ?? '?')}】`, ...(content ? [content] : [])]
  }
  return [`【${String(item.type)}】`, pretty(item)]
}

/**
 * 请求里的消息按顺序写成一段方便阅读的文字：每条消息先是一行谁说的，然后是内容，换行就是真的换行
 * （完整的请求体里它们是转义过的 \n）。用来看模型到底读到了什么。Chat Completions 格式和应用自己的表述，
 * 消息在 messages 里；Responses 格式的在 input 里。两样都没有时是空字符串。放在列表之外的系统提示排在最前面。
 */
export function messagesText(body) {
  if (!isObject(body)) return ''
  const list = Array.isArray(body.messages) ? body.messages.map(messageLines) : Array.isArray(body.input) ? body.input.map(inputLines) : undefined
  if (list === undefined) return ''
  const prompt = promptOf(body)
  return [...(prompt ? [[`【${prompt.name}】`, prompt.text]] : []), ...list].map((lines) => lines.join('\n')).join('\n\n')
}

/** messages 里的一条消息写成的几行文字。 */
function messageLines(message) {
  if (!isObject(message)) return [pretty(message)]
  const lines = [`【${String(message.role ?? '?')}${message.tool_call_id ? `，回应 ${message.tool_call_id}` : ''}】`]
  // 上一轮的思考：有的服务要求原样带回去。两种字段名都有人用。
  const thought = words(message.reasoning_content ?? message.reasoning)
  if (thought) lines.push(`（思考）${thought}`)
  const content = words(message.content)
  if (content) lines.push(content)
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    // Chat Completions 把名字和参数放在 function 里；应用自己的表述里它们直接在调用上。
    lines.push(`（调用工具 ${call?.id ?? ''}）${call?.function?.name ?? call?.name ?? '?'} ${words(call?.function?.arguments ?? call?.arguments)}`)
  }
  return lines
}

/** 任意的值显示成带缩进的 JSON。 */
export function pretty(value) {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2) ?? ''
  } catch {
    return String(value)
  }
}

/**
 * 一条记录在收起时显示的那一行，分成几小段：时刻、模型、结束原因、用量、速度。
 * 没有的那一段就不出现。
 * @returns {string[]}
 */
export function headline(exchange) {
  const parts = [clock(exchange.at), exchange.model]
  if (exchange.error !== undefined) parts.push('失败')
  else if (exchange.finish) parts.push(exchange.finish)
  const { input, output } = tokensOf(exchange.usage)
  if (input !== undefined || output !== undefined) parts.push(`${input ?? '?'} → ${output ?? '?'} tokens`)
  const speed = speedOf(exchange)
  if (speed) parts.push(`${speed.estimated ? '约 ' : ''}${speed.perSecond.toFixed(1)} tok/s`)
  return parts
}

/** 回应的全部内容拼成一段文字：思考、回答、工具调用，各自标明。复制回应时用。 */
export function replyText(reply) {
  const parts = []
  if (reply.reasoning) parts.push(`【思考】\n${reply.reasoning}`)
  if (reply.text) parts.push(reply.reasoning || reply.toolCalls.length ? `【回答】\n${reply.text}` : reply.text)
  for (const call of reply.toolCalls) parts.push(`【工具调用】${call.name}\n${call.arguments}`)
  return parts.join('\n\n')
}
