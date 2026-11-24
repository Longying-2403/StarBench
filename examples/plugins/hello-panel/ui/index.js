// 示例插件的界面部分：对话右侧的一个面板。完整说明见 docs/plugin-ui.md。
//
// 这个文件运行在 StarBench 的窗口里。它是一个普通的 ES 模块，不经过编译，所以不能写 JSX，
// 用 React.createElement 来描述界面。（想写 JSX 的话，自己先编译成普通的 JS，见文档。）

/**
 * StarBench 加载界面时调用一次。
 * @param {import('../starbench-plugin').PluginUiApi} api
 * @returns {import('../starbench-plugin').PluginUiResult}
 */
export default function setup({ React, controls, backend }) {
  // React 要用应用交进来的这一份，不要自己 import。
  const { useEffect, useState, createElement: h } = React
  const { Field, Slider, Switch } = controls

  // 后台发来的通知。计数放在组件外面：面板收起时组件会卸载，放在这里的数不会丢。
  let greeted = 0
  const watchers = new Set()
  const stopListening = backend.on('greeted', (payload) => {
    greeted = /** @type {{ count: number }} */ (payload).count
    for (const redraw of watchers) redraw()
  })

  /** @param {import('../starbench-plugin').PluginPlaceProps} props */
  function Panel({ conversation, model }) {
    // 控件不保存值：值放在组件自己的状态里，变化时由 onChange 告诉你。
    const [name, setName] = useState('')
    const [loud, setLoud] = useState(false)
    const [times, setTimes] = useState(1)
    const [answer, setAnswer] = useState('')

    // 后台来了通知就重画一次。
    const [, setTick] = useState(0)
    useEffect(() => {
      const redraw = () => setTick((n) => n + 1)
      watchers.add(redraw)
      return () => void watchers.delete(redraw)
    }, [])

    // 向后台部分提问。后台抛出的异常会在这里变成 Promise 的拒绝，原因在 err.message 里。
    const greet = () =>
      backend.call('greet', { name, loud, times }).then(
        (reply) => setAnswer(/** @type {{ text: string }} */ (reply).text),
        (err) => setAnswer(`出错了：${err.message}`)
      )

    return h(
      'div',
      { className: 'hello-panel' },
      h(Field, { label: '名字', placeholder: '怎么称呼你', value: name, onChange: setName }),
      h(Switch, { label: '大声一点', hint: '句尾换成感叹号', checked: loud, onChange: setLoud }),
      h(Slider, { label: '说几遍', value: times, min: 1, max: 5, step: 1, onChange: setTimes }),
      // btn、btn-primary、hint 是应用公开给插件用的类名。
      h('button', { type: 'button', className: 'btn btn-primary', onClick: greet }, '打个招呼'),
      // 模型输出或者别处来的文字，一律当作文字放进去，不要当作 HTML。
      answer ? h('p', { className: 'hello-answer' }, answer) : null,
      h('p', { className: 'hint' }, `后台已经打过 ${greeted} 次招呼。`),
      h('p', { className: 'hint' }, model ? `当前模型：${model.id}（${model.provider.name}${model.provider.local ? '，本地' : ''}）` : '还没有选模型。'),
      h('p', { className: 'hint' }, conversation.running ? '模型正在回答…' : '模型空闲。')
    )
  }

  return {
    // 对话右侧的面板。应用会在输入框上面那条栏的右端加一个写着 title 的按钮来打开它。
    panel: { title: '示例面板', component: Panel },
    // 界面被撤掉（停用或重新加载）时调用：把自己开的东西停掉。
    dispose: stopListening
  }
}
