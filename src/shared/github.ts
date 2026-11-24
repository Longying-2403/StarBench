// GitHub in an answer: which links lead there, and which words of an answer name a pull request,
// an issue or a commit of the repository the conversation's folder is a clone of. Such words are
// made links, so that they can be pressed like the ones a model wrote out itself.

import { webPlace } from './links.ts'

/** A repository on GitHub: whose it is, and its name. */
export interface GitHubRepo {
  owner: string
  name: string
}

const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})'
const NAME = '[A-Za-z0-9._-]{1,100}'

/** Whether a web address leads to GitHub itself. Its other sites (gists, pages people publish there) are not it. */
export function onGitHub(address: string): boolean {
  const host = webPlace(address)?.host.toLowerCase()
  return host === 'github.com' || host === 'www.github.com'
}

/** The hash of the commit a GitHub address leads to, or null when it leads to something else. */
export function githubCommit(address: string): string | null {
  if (!onGitHub(address)) return null
  const found = /^\/[^/]+\/[^/]+\/(?:commit|pull\/\d+\/commits)\/([0-9a-f]{7,40})(?:[/?#.]|$)/i.exec(webPlace(address)?.after ?? '')
  return found ? found[1].toLowerCase() : null
}

/**
 * Whether a text reads as the hash of a commit, whole or shortened: seven to forty of the digits
 * hashes are written in, with a letter among them, which a plain number has not, and a figure,
 * which a word has not ("defaced" is spelt with those letters alone). About one short hash in
 * twenty-five has only the one or only the other, and is not taken for one.
 */
export function isCommitHash(text: string): boolean {
  return /^[0-9a-f]{7,40}$/.test(text) && /[a-f]/.test(text) && /[0-9]/.test(text)
}

/**
 * The repository a remote of a clone leads to, when that is on GitHub: from its address, in any
 * of the ways git writes one. A name and a token written into the address are not looked at and
 * go nowhere.
 */
export function repoOfRemote(address: string): GitHubRepo | null {
  const found = new RegExp(
    `^(?:https?://(?:[^@/\\s]+@)?(?:www\\.)?github\\.com/|git@github\\.com:|ssh://git@github\\.com(?::\\d+)?/|git://github\\.com/)(${OWNER})/(${NAME}?)(?:\\.git)?/?$`,
    'i'
  ).exec(address.trim())
  return found ? { owner: found[1], name: found[2] } : null
}

/** The repository on GitHub that a clone's own settings (`.git/config`) name as its origin, or null: no origin, or one that is elsewhere. */
export function originRepo(config: string): GitHubRepo | null {
  let inOrigin = false
  for (const raw of config.split(/\r\n|\r|\n/)) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]$/i.test(line)
      continue
    }
    const url = inOrigin ? /^url\s*=\s*(.+)$/i.exec(line) : null
    if (url) return repoOfRemote(url[1])
  }
  return null
}

const home = (repo: GitHubRepo): string => `https://github.com/${repo.owner}/${repo.name}`

/** Where a commit of a repository is shown. */
export const commitAddress = (repo: GitHubRepo, hash: string): string => `${home(repo)}/commit/${hash}`

/** Words of a text that name something on GitHub, and where that is. */
export interface GitHubRef {
  /** Where the words that become the link begin and end in the text. */
  start: number
  end: number
  address: string
}

/** A repository and a number, as GitHub itself shortens them: `owner/name#12`. Clear wherever it stands. */
const SHORT = new RegExp(`(?<![\\w./#-])(${OWNER})/(${NAME})#(\\d{1,9})(?![\\w#])`, 'g')
/** A pull request or an issue by its number, with the word that says which. Only that word makes a number one of these. */
const NUMBERED = /(?<![A-Za-z])(pull\s+requests?|PRs?|issues?|拉取请求|合并请求|议题)(\s*)#(\d{1,9})(?![\w#])/gi
/** The word for a commit, with the little that may stand between it and the hash: "commit hash", "提交号", "提交是", a colon. */
const COMMIT_WORD = '(?<![A-Za-z])(?:commits?(?:\\s+(?:hash|sha|id))?|提交(?:号|是|为|记录|哈希)?)\\s*[:：]?\\s*'
/** A commit by its hash, after the word for one. */
const HASHED = new RegExp(`${COMMIT_WORD}([0-9a-f]{7,40})(?![0-9A-Za-z])`, 'gi')
/** Text that ends in the word for a commit: what stands next may be its hash, written as code. */
const BEFORE_HASH = new RegExp(`${COMMIT_WORD}$`, 'i')

/**
 * The words of `text` that name something on GitHub, in the order they stand, none inside
 * another. `owner/name#12` is taken wherever it stands. A bare "PR #12" or "commit 1a2b3c4" says
 * nothing of where, and is taken only for `repo`: the repository the conversation's folder is a
 * clone of. Nothing is looked up, so a number or a hash that names nothing leads to a page GitHub
 * does not have.
 */
export function githubRefs(text: string, repo: GitHubRepo | null): GitHubRef[] {
  const found: GitHubRef[] = []
  for (const m of text.matchAll(SHORT)) {
    found.push({ start: m.index, end: m.index + m[0].length, address: `https://github.com/${m[1]}/${m[2]}/issues/${m[3]}` })
  }
  if (repo) {
    for (const m of text.matchAll(NUMBERED)) {
      // GitHub sends either address on to the other where the number is of the other kind.
      const kind = /^(?:issue|议题)/i.test(m[1]) ? 'issues' : 'pull'
      found.push({ start: m.index, end: m.index + m[0].length, address: `${home(repo)}/${kind}/${m[3]}` })
    }
    for (const m of text.matchAll(HASHED)) {
      if (!isCommitHash(m[1])) continue
      const start = m.index + m[0].length - m[1].length
      found.push({ start, end: start + m[1].length, address: commitAddress(repo, m[1]) })
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end)
  const kept: GitHubRef[] = []
  for (const ref of found) {
    if (kept.length === 0 || ref.start >= kept[kept.length - 1].end) kept.push(ref)
  }
  return kept
}

/** A piece of a Markdown text as its reader hands it over: only what is looked at here. */
export interface MarkdownNode {
  type: string
  value?: string
  url?: string
  title?: string | null
  children?: MarkdownNode[]
}

const linkTo = (address: string, children: MarkdownNode[]): MarkdownNode => ({ type: 'link', url: address, title: null, children })

/**
 * Makes links of the words in a Markdown text that name something on GitHub (`githubRefs`). What
 * is a link already, or code set apart, is left as it is; a hash written as code right after the
 * word for a commit becomes a link to that commit.
 */
export function linkGitHubRefs(tree: MarkdownNode, repo: GitHubRepo | null): void {
  const walk = (node: MarkdownNode): void => {
    if (!node.children || node.type === 'link' || node.type === 'linkReference') return
    const out: MarkdownNode[] = []
    for (const child of node.children) {
      if (child.type === 'text' && typeof child.value === 'string') {
        const text = child.value
        let at = 0
        for (const ref of githubRefs(text, repo)) {
          if (ref.start > at) out.push({ type: 'text', value: text.slice(at, ref.start) })
          out.push(linkTo(ref.address, [{ type: 'text', value: text.slice(ref.start, ref.end) }]))
          at = ref.end
        }
        if (at === 0) out.push(child)
        else if (at < text.length) out.push({ type: 'text', value: text.slice(at) })
        continue
      }
      const before = out.at(-1)
      if (repo && child.type === 'inlineCode' && typeof child.value === 'string' && isCommitHash(child.value) && before?.type === 'text' && BEFORE_HASH.test(before.value ?? '')) {
        out.push(linkTo(commitAddress(repo, child.value), [child]))
        continue
      }
      walk(child)
      out.push(child)
    }
    node.children = out
  }
  walk(tree)
}
