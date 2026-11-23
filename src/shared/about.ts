// What the app says about itself on the About page of the settings: where its code is, where
// to report a problem, and who makes it. The version is not here: it is read from the app
// itself, so that it is always the one that is running. The revision is here, since the package
// has no place for it.

export const ABOUT = {
  /** One sentence on what the app is. */
  summary: '一个桌面端的 AI 编程助手外壳：选一个工作文件夹，用对话的方式让模型读写文件、搜索代码、执行命令。',
  /** The app is not finished: the settings format and the plugin interface may still change. */
  stage: 'Beta',
  /**
   * How many times the app has been revised at this version. While the stage above lasts the
   * version stays as it is and this number is what goes up: "0.1.0-r9" is the ninth revision,
   * written with a hyphen, as in the names of the released files. It is counted by the author
   * and written here by hand; nothing works it out.
   */
  revision: 10,
  repo: { label: 'github.com/Longying-2403/StarBench', url: 'https://github.com/Longying-2403/StarBench' },
  issues: { label: 'GitHub Issues', url: 'https://github.com/Longying-2403/StarBench/issues' },
  /** Who makes it, each with what they are to the project and where to find them. */
  authors: [
    { role: '作者', name: '龍櫻Longying', url: 'https://github.com/Longying-2403' },
    { role: '参与测试的团队', name: 'Team-Project-Stars', url: 'https://github.com/Team-Project-Stars' }
  ]
} as const satisfies {
  summary: string
  stage: string
  revision: number
  repo: { label: string; url: string }
  issues: { label: string; url: string }
  authors: readonly { role: string; name: string; url: string }[]
}
