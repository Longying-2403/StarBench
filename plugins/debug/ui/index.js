// 调试面板的界面：对话右侧的“调试”面板，和输入框上面那条栏里的一小段读数。
// 这个文件运行在 StarBench 的窗口里。设置和记录都放在后台部分（../index.js），这里只负责
// 显示和改动；怎么把设置变成请求里的字段在 params.js，怎么把记录变成文字在 format.js。

import { PARAMS, appliesTo, fieldsFor, normalize, plainFor, readExtra, readSeed } from './params.js'
import { headline, messageCount, messagesText, pretty, replyText, seconds, settingsOf } from './format.js'

/** 界面里留着的记录条数，和后台部分一致。 */
const KEEP = 12

/** 用滑块调的几项在面板上的名字和说明。 */
const SLIDERS = {
  temperature: { label: '温度', hint: 'temperature：越高越随机，越低越确定' },
  top_p: { label: 'Top-p', hint: 'top_p：只在概率最高的那一部分词里挑' },
  max_tokens: { label: '最大输出长度', hint: 'max_tokens：一次回应最多输出多少 token' }
}

/**
 * @param {import('../../../types/starbench-plugin').PluginUiApi} api
 * @returns {import('../../../types/starbench-plugin').PluginUiResult}
 */
export default function setup({ React, controls, backend }) {
  const { memo, useState, useSyncExternalStore, createElement: h } = React
  const { Field, Slider, Switch } = controls

  // 状态放在组件外面：面板收起时组件会卸载，而且面板和输入框上面那条栏里的读数要看到同一份。
  // 每次改动都换成一个新对象，组件靠这个知道要不要重画。
  let state = { loaded: false, config: normalize(undefined), exchanges: [], problem: '' }
  const watchers = new Set()
  const set = (patch) => {
    state = { ...state, ...patch }
    for (const redraw of watchers) redraw()
  }
  const subscribe = (redraw) => {
    watchers.add(redraw)
    return () => void watchers.delete(redraw)
  }
  const current = () => state
  const useStore = () => useSyncExternalStore(subscribe, current, current)
  const failed = (what) => (err) => set({ problem: `${what}：${err instanceof Error ? err.message : String(err)}` })

  // 加载时向后台要一次全部状态，之后新的记录由后台推过来。
  backend.call('state').then((reply) => {
    const { config, exchanges } = /** @type {{ config: unknown, exchanges: any[] }} */ (reply)
    set({ loaded: true, config: normalize(config), exchanges: exchanges.slice(-KEEP) })
  }, failed('没能读到调试面板的状态'))
  const stops = [
    backend.on('exchange', (exchange) => {
      const one = /** @type {any} */ (exchange)
      set({ exchanges: [...state.exchanges.filter((kept) => kept.id !== one.id), one].slice(-KEEP) })
    }),
    backend.on('problem', (text) => set({ problem: String(text) }))
  ]

  // 改动先在这里生效，再告诉后台。不拿后台的回答来覆盖：拖动滑块时一连串的回答会晚到，
  // 用它们覆盖会让滑块往回跳。两边用的是同一个 normalize，结果是一样的。
  const change = (patch) => {
    const config = normalize({ ...state.config, ...patch })
    set({ config, problem: '' })
    backend.call('configure', config).catch(failed('设置没有生效'))
  }
  const reset = () => backend.call('reset').then((config) => set({ config: normalize(config), problem: '' }), failed('没能恢复默认'))
  const clear = () => backend.call('clear').then(() => set({ exchanges: [] }), failed('没能清空记录'))

  const targetOf = (model) => ({ kind: model.provider.kind, local: model.provider.local })

  /** 这些设置对当前模型的效果，写成一句话。tone 决定它的颜色：on 有参数会加进去，idle 没有，warn 设置到不了这个模型。 */
  const statusOf = (config, model) => {
    if (!model) return { tone: 'idle', text: '还没有选模型。' }
    const reach = appliesTo(config, targetOf(model))
    if (!reach.applies) {
      if (reach.why === 'off') return { tone: 'idle', text: '总开关关着，请求里不带下面这些参数。' }
      if (reach.why === 'kind') return { tone: 'warn', text: `${model.provider.name} 用的不是 OpenAI 兼容（Chat Completions）接口，这些参数加不进发给它的请求。` }
      return { tone: 'warn', text: `${model.provider.name} 不是本机或局域网里的模型服务，下面的参数不会发给它。想对它也生效，就关掉“只用于本地模型”。` }
    }
    const fields = fieldsFor(config, targetOf(model))
    if (!fields) return { tone: 'idle', text: '还没有打开任何一项，请求和平时一样。' }
    return { tone: 'on', text: `发给 ${model.id} 的请求会带上：${Object.keys(fields).join('、')}` }
  }

  /** 发给当前模型的消息是不是以纯对话发出，写成一句话。tone 的意思和上面一样。 */
  const plainStatusOf = (config, model) => {
    if (!model) return { tone: 'idle', text: '还没有选模型。' }
    const reach = plainFor(config, targetOf(model))
    if (reach.plain) {
      return { tone: 'on', text: `发给 ${model.id} 的消息会以纯对话发出：不带任何工具，系统提示词只有你在“提示词”里给这个模型服务写的那一份，没写就没有。` }
    }
    if (reach.why === 'off') return { tone: 'idle', text: '关着：消息照常发出，带着工具和 StarBench 的提示词。' }
    return { tone: 'warn', text: `${model.provider.name} 不是本机或局域网里的模型服务，发给它的消息照常带着工具。想对它也用纯对话，就关掉“只用于本地模型”。` }
  }

  /**
   * 输入框上面那条栏里的读数：消息会以纯对话发出、或者有参数正在加进请求时提醒一下，面板收着也看得到。
   * @param {import('../../../types/starbench-plugin').PluginPlaceProps} props
   */
  function Readout({ model }) {
    const { loaded, config } = useStore()
    if (!loaded || !model) return null
    const plain = plainFor(config, targetOf(model)).plain
    const fields = fieldsFor(config, targetOf(model))
    if (!plain && !fields) return null
    const names = Object.keys(fields ?? {})
    const detail = names.map((name) => `${name} = ${JSON.stringify(fields[name])}`).join('\n')
    // 说明用应用自己的提示框（data-tip），和应用里其他地方一样。
    return h(
      React.Fragment,
      null,
      plain
        ? h(
            'span',
            {
              className: 'hint debug-readout debug-readout-plain',
              'data-tip': '调试面板开着“纯对话”：发给这个模型的消息不带任何工具，也不带 StarBench 的提示词、Skills 列表和记忆。'
            },
            '纯对话'
          )
        : null,
      fields ? h('span', { className: 'hint debug-readout', 'data-tip': `调试面板正在给请求加上：\n${detail}` }, `已调 ${names.length} 项参数`) : null
    )
  }

  /** 一段可以复制的文字：标题、“复制”按钮和内容。folded 的那种先收着，点标题展开。 */
  function Block({ title, text, note, folded }) {
    const [open, setOpen] = useState(!folded)
    const [copied, setCopied] = useState(false)
    const copy = () =>
      navigator.clipboard.writeText(text).then(
        () => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        },
        () => {}
      )
    return h(
      'div',
      { className: 'debug-block' },
      h(
        'div',
        { className: 'debug-block-head' },
        folded
          ? h('button', { type: 'button', className: 'debug-fold', 'aria-expanded': open, onClick: () => setOpen(!open) }, `${open ? '▾' : '▸'} ${title}`)
          : h('span', null, title),
        h('button', { type: 'button', className: 'btn btn-small', onClick: copy }, copied ? '已复制' : '复制')
      ),
      note ? h('p', { className: 'hint debug-note' }, note) : null,
      // 请求和回应里的文字来自模型、文件和网页：一律当作文字显示，不当作 HTML。
      open ? h('pre', { className: 'code debug-pre' }, text) : null
    )
  }

  /** 一条记录展开后的内容。 */
  function Details({ exchange }) {
    const { request, reply, timing } = exchange
    // 流式的回应记着第一段是什么时候到的；一次取回的回应没有这一项。
    const streamed = timing.first !== undefined
    const facts = [
      `${exchange.provider.name}${exchange.provider.local ? '（本地）' : ''}`,
      `用时 ${seconds(timing.total)}${streamed ? `（等第一段 ${seconds(timing.first)}）` : ''}`,
      // 段数只数文字和思考：只有工具调用的回应没有可数的段，但同样是一段一段到的。
      streamed ? (exchange.pieces > 1 ? `流式，分 ${exchange.pieces} 段到达` : '流式') : '一次到达，不是流式',
      // 服务拒绝了请求里的某一项（流式、工具、思考摘要等），或者登录凭证过期：应用去掉那一项或换了凭证再发。
      ...(exchange.attempts > 1 ? [`重发过，一共发了 ${exchange.attempts} 次`] : [])
    ]
    const settings = settingsOf(request.body)
    const body = pretty(request.body)
    const count = messageCount(request.body)
    const size = `${count !== undefined ? `${count} 条消息，` : ''}${body.length} 个字符`
    const messages = messagesText(request.body)
    return h(
      'div',
      { className: 'debug-exchange-body' },
      h('p', { className: 'hint debug-note' }, facts.join(' · ')),
      exchange.error !== undefined ? h('p', { className: 'debug-problem' }, `请求失败：${exchange.error}`) : null,
      exchange.stopped !== undefined ? h('p', { className: 'debug-problem' }, `StarBench 没有照这个回应执行：${exchange.stopped}`) : null,
      Object.keys(settings).length ? h(Block, { title: '参数', text: pretty(settings) }) : null,
      // 应用自己加的请求头，例如发给 xAI 的对话标识。带密钥的请求头不在记录里。
      request.headers && Object.keys(request.headers).length ? h(Block, { title: '请求头（应用另外加的）', text: pretty(request.headers) }) : null,
      messages ? h(Block, { title: `模型读到的消息（${count} 条）`, text: messages, folded: true }) : null,
      h(Block, {
        title: `完整的请求体（${size}）`,
        text: body,
        folded: true,
        // 没有出错却没有请求体：是这种格式不上报。出了错的，也可能是请求根本没有发出去。
        note: request.wire
          ? ''
          : exchange.error === undefined
            ? '这种接口格式还不上报实际发出的请求体，这里是 StarBench 自己的表述。'
            : '这里是 StarBench 自己的表述：这种接口格式还不上报实际发出的请求体，或者请求没有发出去就失败了。'
      }),
      exchange.usage !== undefined ? h(Block, { title: '用量（服务报告的原样）', text: pretty(exchange.usage) }) : null,
      exchange.error === undefined ? h(Block, { title: '回应', text: replyText(reply) || '（空的回应）' }) : null
    )
  }

  /** 一条记录：收着时是一行，点一下展开。展开的内容只在展开时才画，请求体可能很长。 */
  const Row = memo(function Row({ exchange }) {
    const [open, setOpen] = useState(false)
    return h(
      'div',
      { className: exchange.error !== undefined ? 'debug-exchange debug-exchange-failed' : 'debug-exchange' },
      h(
        'button',
        { type: 'button', className: 'debug-exchange-head', 'aria-expanded': open, onClick: () => setOpen(!open) },
        h('span', { 'aria-hidden': true }, open ? '▾' : '▸'),
        h(
          'span',
          { className: 'debug-exchange-parts' },
          headline(exchange).map((part, at) => h('span', { key: at }, part))
        )
      ),
      open ? h(Details, { exchange }) : null
    )
  })

  /**
   * 对话右侧的面板。
   * @param {import('../../../types/starbench-plugin').PluginPlaceProps} props
   */
  function Panel({ conversation, model }) {
    const { loaded, config, exchanges, problem } = useStore()
    if (!loaded) return h('p', { className: problem ? 'debug-problem' : 'hint' }, problem || '正在读取…')

    const status = statusOf(config, model)
    const plainStatus = plainStatusOf(config, model)
    const setItem = (name, patch) => change({ [name]: { ...config[name], ...patch } })
    // 一项参数：一个开关，打开后在它下面出现调它的控件。控件的名字开关上已经写了，不再显示一遍。
    const item = (name, label, hint, control, problemText) =>
      h(
        'div',
        { className: 'debug-item', key: name },
        h(Switch, { label, hint, checked: config[name].on, onChange: (on) => setItem(name, { on }) }),
        config[name].on ? control : null,
        config[name].on && problemText ? h('p', { className: 'debug-problem' }, problemText) : null
      )
    const text = (name, label, more) => h(Field, { label, labelHidden: true, value: config[name].value, onChange: (value) => setItem(name, { value }), ...more })
    const extra = readExtra(config.extra.value)

    // 只显示当前对话的记录，新的在上面。
    const mine = exchanges.filter((exchange) => exchange.conversation === conversation.id).reverse()
    const elsewhere = exchanges.length - mine.length

    return h(
      'div',
      { className: 'debug-panel' },
      problem ? h('p', { className: 'debug-problem' }, problem) : null,
      h(
        'section',
        { className: 'debug-section' },
        // “恢复默认”恢复的是整个面板的设置，所以放在最上面这一栏。
        h('h3', { className: 'debug-heading' }, '适用范围', h('button', { type: 'button', className: 'btn btn-small', onClick: reset }, '恢复默认')),
        h(Switch, {
          label: '只用于本地模型',
          hint: '下面的纯对话和采样参数，都只对地址在本机或局域网里的模型服务生效',
          checked: config.localOnly,
          onChange: (localOnly) => change({ localOnly })
        })
      ),
      h(
        'section',
        { className: 'debug-section' },
        h('h3', { className: 'debug-heading' }, '纯对话'),
        h('p', { className: `debug-status debug-status-${plainStatus.tone}` }, plainStatus.text),
        h(Switch, {
          label: '纯对话（不带工具）',
          hint: '不给模型任何工具，也不加 StarBench 的提示词、Skills 列表和记忆。从下一条消息起生效，发出的消息下面会标上“纯对话”',
          checked: config.plain,
          onChange: (plain) => change({ plain })
        })
      ),
      h(
        'section',
        { className: 'debug-section' },
        h('h3', { className: 'debug-heading' }, '采样参数'),
        h('p', { className: `debug-status debug-status-${status.tone}` }, status.text),
        h(Switch, { label: '调整采样参数', hint: '总开关。关掉后请求里不带下面任何一项', checked: config.enabled, onChange: (enabled) => change({ enabled }) }),
        Object.keys(PARAMS).map((name) =>
          item(
            name,
            SLIDERS[name].label,
            SLIDERS[name].hint,
            h(Slider, { label: SLIDERS[name].label, labelHidden: true, ...PARAMS[name], value: config[name].value, onChange: (value) => setItem(name, { value }) })
          )
        ),
        item(
          'seed',
          '随机种子',
          'seed：种子和其他参数都相同时，输出尽量保持一致',
          text('seed', '随机种子', { type: 'number', placeholder: '一个整数' }),
          readSeed(config.seed.value) === undefined ? '要写成一个整数，否则不会发出去。' : ''
        ),
        item('stop', '停止词', 'stop：输出里一出现其中一个就停下', text('stop', '停止词', { multiline: true, placeholder: '一行一个，最多 4 个' })),
        item(
          'extra',
          '其他字段',
          '写成一个 JSON 对象，原样并入请求。给各家服务自己才有的参数用',
          text('extra', '其他字段', { multiline: true, placeholder: '{"top_k": 40}' }),
          'problem' in extra
            ? `${extra.problem}。改对之前不会发出去。`
            : extra.ignored.length
              ? `${extra.ignored.join('、')} 由 StarBench 自己决定，写在这里不会生效。`
              : ''
        )
      ),
      h(
        'section',
        { className: 'debug-section' },
        h('h3', { className: 'debug-heading' }, '请求记录', exchanges.length ? h('button', { type: 'button', className: 'btn btn-small', onClick: clear }, '清空') : null),
        h(Switch, {
          label: '记录每次请求',
          hint: '把每次请求实际发出的内容和应用读到的回应记下来，显示在下面。关掉后不再保留这些内容',
          checked: config.record,
          onChange: (record) => change({ record })
        }),
        mine.map((exchange) => h(Row, { key: exchange.id, exchange })),
        mine.length === 0
          ? h('p', { className: 'hint debug-note' }, config.record ? '这个对话还没有记录。发一条消息，这里就会出现发出去的请求和收到的回应。' : '记录关着。')
          : null,
        elsewhere > 0 ? h('p', { className: 'hint debug-note' }, `另有 ${elsewhere} 条是别的对话的，切换到那个对话就能看到。`) : null,
        h('p', { className: 'hint debug-note' }, `只保留最近 ${KEEP} 条，关掉应用就没有了。记录里没有 API Key。`)
      )
    )
  }

  return {
    slots: { 'composer.actions': Readout },
    panel: { title: '调试', component: Panel },
    // 界面被撤掉（停用或重新加载）时，停掉对后台的监听。
    dispose: () => {
      for (const stop of stops) stop()
    }
  }
}
