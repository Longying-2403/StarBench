// 调试面板的设置：有哪些项、默认值是什么，以及怎么把它们变成请求里的字段。
//
// 这个文件放在 ui/ 里，是因为插件的两半都要用它：界面（ui/index.js）用它知道每一项的范围、
// 判断设置对当前模型是否生效；后台部分（index.js）用它算出要加进请求的字段。窗口只读得到
// ui/ 里的文件，后台部分则可以读插件文件夹里的任何文件，所以两边共用的东西放在这里。
// 这里没有任何和 StarBench 相关的代码，测试也直接用它。

/** 面板里能调的参数：请求里的字段名、取值范围和默认值。 */
export const PARAMS = {
  temperature: { min: 0, max: 2, step: 0.01, value: 0.7 },
  top_p: { min: 0, max: 1, step: 0.01, value: 0.9 },
  max_tokens: { min: 16, max: 8192, step: 1, value: 1024 }
}

/** 刚装上时的设置：总开关开着，但每一项都没有打开，所以请求和平时完全一样。 */
export const DEFAULTS = Object.freeze({
  /** 总开关。关掉后请求里不带下面任何一项。 */
  enabled: true,
  /** 只用于自己运行的本地模型服务。纯对话和采样参数都听它的。 */
  localOnly: true,
  /**
   * 纯对话：消息发出时不带任何工具，也不带 StarBench 的提示词、Skills 列表和记忆，
   * 系统提示词只有用户给这个模型服务写的那一份。默认关着。
   */
  plain: false,
  temperature: { on: false, value: PARAMS.temperature.value },
  top_p: { on: false, value: PARAMS.top_p.value },
  max_tokens: { on: false, value: PARAMS.max_tokens.value },
  seed: { on: false, value: '42' },
  /** 停止词，一行一个。 */
  stop: { on: false, value: '' },
  /** 其他字段：一段 JSON 对象，原样并入请求。给各家服务自己才有的参数用。 */
  extra: { on: false, value: '' },
  /**
   * 记录每次请求。开着的时候，StarBench 会为每个请求多做一份记录：请求体和回应的完整拷贝。
   * 关着的时候这个插件不旁观，StarBench 就不做这份拷贝。
   */
  record: true
})

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 把保存下来的设置整理成完整、合法的一份：缺的补上默认值，类型不对的换成默认值，数值收到范围之内。
 * 保存的设置可能来自旧版本，也可能被手动改过，所以每次读出来都过一遍。
 */
export function normalize(saved) {
  const from = isObject(saved) ? saved : {}
  const item = (name, clean) => {
    const given = isObject(from[name]) ? from[name] : {}
    const value = clean(given.value)
    return { on: given.on === true, value: value === undefined ? DEFAULTS[name].value : value }
  }
  const number = (name) =>
    item(name, (value) => {
      const { min, max } = PARAMS[name]
      return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : undefined
    })
  const text = (name, limit) => item(name, (value) => (typeof value === 'string' ? value.slice(0, limit) : undefined))
  return {
    enabled: from.enabled !== false,
    localOnly: from.localOnly !== false,
    // 只有明确打开过才算：它会把工具全部拿掉，旧版本的设置里没有这一项，读出来必须是关着的。
    plain: from.plain === true,
    temperature: number('temperature'),
    top_p: number('top_p'),
    max_tokens: number('max_tokens'),
    // 文字都有上限：整份设置要放得进 StarBench 给每个插件的 64 KB。
    seed: text('seed', 20),
    stop: text('stop', 1000),
    extra: text('extra', 8000),
    record: from.record !== false
  }
}

/**
 * 归 StarBench 自己决定的请求字段：发给哪个模型、说什么、带哪些工具、回应怎么传回来。
 * 插件设不了它们，写了也会被 StarBench 丢掉，所以这里先挑出来告诉用户。
 */
export const RESERVED = ['model', 'messages', 'tools', 'tool_choice', 'stream', 'stream_options', 'n', 'reasoning_effort']

/**
 * “其他字段”那段文字读成的对象。空着就是没有；写得不对时说明哪里不对。
 * ignored 是写了但不会生效的字段名（见 RESERVED），它们不在 fields 里。
 * @returns {{ fields: Record<string, unknown>, ignored: string[] } | { problem: string }}
 */
export function readExtra(text) {
  if (!text.trim()) return { fields: {}, ignored: [] }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { problem: `不是合法的 JSON：${err instanceof Error ? err.message : String(err)}` }
  }
  if (!isObject(parsed)) return { problem: '要写成一个 JSON 对象，例如 {"top_k": 40}' }
  const ignored = Object.keys(parsed).filter((name) => RESERVED.includes(name))
  return { fields: Object.fromEntries(Object.entries(parsed).filter(([name]) => !RESERVED.includes(name))), ignored }
}

/** 随机种子那段文字读成的整数；不是整数时是 undefined。 */
export function readSeed(text) {
  const trimmed = text.trim()
  if (!/^-?\d{1,15}$/.test(trimmed)) return undefined
  return Number(trimmed)
}

/** 停止词那段文字读成的列表：一行一个，空行不算，最多 4 个（OpenAI 接口格式的上限）。 */
export function readStop(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4)
}

/**
 * 这些设置对某个模型是否生效，不生效时为什么。
 * @param {ReturnType<typeof normalize>} config
 * @param {{ kind: string, local: boolean }} target
 * @returns {{ applies: true } | { applies: false, why: 'off' | 'kind' | 'remote' }}
 */
export function appliesTo(config, target) {
  if (!config.enabled) return { applies: false, why: 'off' }
  // StarBench 目前只给 OpenAI 兼容（Chat Completions）的请求加采样参数。
  if (target.kind !== 'openai-chat') return { applies: false, why: 'kind' }
  if (config.localOnly && !target.local) return { applies: false, why: 'remote' }
  return { applies: true }
}

/**
 * 发给某个模型的消息是不是以纯对话发出，不是的话为什么。
 * 它和采样参数是两回事：不看“调整采样参数”那个开关，对每一种接口格式都生效；
 * 只有“只用于本地模型”对两者都管用。
 * @param {ReturnType<typeof normalize>} config
 * @param {{ local: boolean }} target
 * @returns {{ plain: true } | { plain: false, why: 'off' | 'remote' }}
 */
export function plainFor(config, target) {
  if (config.plain !== true) return { plain: false, why: 'off' }
  if (config.localOnly && target.local !== true) return { plain: false, why: 'remote' }
  return { plain: true }
}

/**
 * 要加进请求的字段。没有要加的，或者这些设置对这个模型不生效时，返回 undefined。
 * @param {ReturnType<typeof normalize>} config
 * @param {{ kind: string, local: boolean }} target
 */
export function fieldsFor(config, target) {
  if (!appliesTo(config, target).applies) return undefined
  const fields = {}
  // “其他字段”先放，面板上明确打开的项后放：两边都写了同一个字段时，以面板上的为准。
  if (config.extra.on) {
    const extra = readExtra(config.extra.value)
    if ('fields' in extra) Object.assign(fields, extra.fields)
  }
  for (const name of Object.keys(PARAMS)) if (config[name].on) fields[name] = config[name].value
  if (config.seed.on) {
    const seed = readSeed(config.seed.value)
    if (seed !== undefined) fields.seed = seed
  }
  if (config.stop.on) {
    const stop = readStop(config.stop.value)
    if (stop.length) fields.stop = stop
  }
  return Object.keys(fields).length ? fields : undefined
}
