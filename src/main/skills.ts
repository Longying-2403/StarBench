// Skills: folders holding a SKILL.md that teaches the model how to do one kind
// of task. The model always sees each skill's name and description, and reads
// the full instructions only when a task calls for them.
// Nothing in this file depends on Electron.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SkillInfo } from '../shared/types.ts'
import type { ToolSpec } from './tools.ts'

const SKILL_FILE = 'SKILL.md'
const SKILL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/
const MAX_FILE_BYTES = 1_000_000
const MAX_LISTED_FILES = 50
/** Descriptions are sent with every request, so a runaway one is cut short. */
const MAX_DESCRIPTION_CHARS = 600

export interface ParsedSkill {
  name?: string
  description?: string
  /**
   * Only the person picks it, as a command: it is not in the list the model is given, and the model
   * cannot load it. Written `user-only: true`; Claude Code's `disable-model-invocation: true` is
   * read the same way.
   */
  userOnly?: boolean
  /** The instructions: everything after the front matter. */
  body: string
}

/**
 * Splits a SKILL.md into its front matter fields and body. Understands the
 * small YAML subset skills use: `key: value`, quoted values, indented
 * continuation lines and `>` / `|` block scalars.
 */
export function parseSkill(source: string): ParsedSkill {
  const text = source.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text)
  if (!match) return { body: text.trim() }

  const meta: Record<string, string> = {}
  let key: string | null = null
  /** Line joiner for the value being read: "\n" inside a `|` block, " " otherwise. */
  let joiner = ' '
  for (const line of match[1].split('\n')) {
    const field = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line)
    if (field) {
      key = field[1]
      const value = field[2].trim()
      if (/^[>|][+-]?$/.test(value)) {
        joiner = value.startsWith('|') ? '\n' : ' '
        meta[key] = ''
      } else {
        joiner = ' '
        meta[key] = value.replace(/^(["'])(.*)\1$/, '$2')
      }
    } else if (key && /^\s+\S/.test(line)) {
      meta[key] = meta[key] ? `${meta[key]}${joiner}${line.trim()}` : line.trim()
    }
  }
  const userOnly = [meta['user-only'], meta['disable-model-invocation']].some((value) => value?.toLowerCase() === 'true')
  return { name: meta.name || undefined, description: meta.description || undefined, ...(userOnly ? { userOnly: true } : {}), body: text.slice(match[0].length).trim() }
}

interface Root {
  dir: string
  source: string
}

interface LocatedSkill extends SkillInfo {
  dir: string
}

/** The source of the skills that come with the app, as the app's own tools are told from plugins' by it. */
export const BUILTIN_SKILLS = 'builtin'

/** Finds skills in the user's skills folder, in folders contributed by plugins, and among those that come with the app. */
export class SkillStore {
  private roots: Root[]
  /** Looked through last: a skill of the same name the user or a plugin brings takes the place of the app's. */
  private builtin?: Root

  /**
   * @param userDir - the user's own skills folder; its skills win over plugin skills of the same name.
   * @param builtinDir - the skills that come with the app, which every other skill of the same name wins over.
   */
  constructor(userDir: string, builtinDir?: string) {
    this.roots = [{ dir: userDir, source: 'user' }]
    if (builtinDir) this.builtin = { dir: builtinDir, source: BUILTIN_SKILLS }
  }

  get userDir(): string {
    return this.roots[0].dir
  }

  /** Adds a folder of skills, e.g. one shipped by a plugin. Returns the function that removes it. */
  addRoot(dir: string, source: string): () => void {
    const root: Root = { dir, source }
    this.roots.push(root)
    return () => {
      this.roots = this.roots.filter((r) => r !== root)
    }
  }

  /** Reads the folders on every call, so a skill dropped in while the app runs shows up at once. */
  async list(): Promise<SkillInfo[]> {
    return (await this.locate()).map(({ name, description, source, userOnly }) => ({ name, description, source, ...(userOnly ? { userOnly: true } : {}) }))
  }

  /** The text handed to the model when a skill is loaded: where it lives, what else it ships, its instructions. */
  async load(name: string): Promise<string> {
    const skill = await this.find(name)
    const body = parseSkill(await fs.readFile(path.join(skill.dir, SKILL_FILE), 'utf8')).body
    const files = await listFiles(skill.dir)
    return [
      `Skill: ${skill.name}`,
      `Directory: ${skill.dir}`,
      ...(files.length
        ? [`Other files (read with load_skill's "file" argument, or run by absolute path): ${files.join(', ')}`]
        : []),
      '',
      body || '(This skill has no instructions.)'
    ].join('\n')
  }

  /** Reads a supporting file from inside a skill's folder. */
  async readFile(name: string, file: string): Promise<string> {
    const skill = await this.find(name)
    const full = path.resolve(skill.dir, file)
    const relative = path.relative(skill.dir, full)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`File is outside the skill folder: ${file}`)
    }
    // Followed through links as well, on both sides: a link in a skill folder may lead anywhere.
    const [root, real] = await Promise.all([fs.realpath(skill.dir), fs.realpath(full)])
    const realRelative = path.relative(root, real)
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      throw new Error(`File is outside the skill folder: ${file}`)
    }
    const stat = await fs.stat(full)
    if (stat.size > MAX_FILE_BYTES) throw new Error(`File is too large to read (${stat.size} bytes)`)
    return fs.readFile(full, 'utf8')
  }

  private async find(name: string): Promise<LocatedSkill> {
    const skills = await this.locate()
    const skill = skills.find((s) => s.name === name)
    if (!skill) {
      const known = skills.map((s) => s.name).join(', ') || 'none'
      throw new Error(`Unknown skill "${name}". Available skills: ${known}`)
    }
    return skill
  }

  private async locate(): Promise<LocatedSkill[]> {
    const found = new Map<string, LocatedSkill>()
    for (const root of this.builtin ? [...this.roots, this.builtin] : this.roots) {
      const entries = await fs.readdir(root.dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory()) continue
        const dir = path.join(root.dir, entry.name)
        const text = await fs.readFile(path.join(dir, SKILL_FILE), 'utf8').catch(() => null)
        if (text === null) continue
        const parsed = parseSkill(text)
        // A front matter name the model could not call by falls back to the folder name.
        const name = parsed.name && SKILL_NAME.test(parsed.name) ? parsed.name : entry.name
        if (!SKILL_NAME.test(name) || found.has(name)) continue
        const description = (parsed.description ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION_CHARS)
        found.set(name, { name, description, source: root.source, dir, ...(parsed.userOnly ? { userOnly: true } : {}) })
      }
    }
    return [...found.values()]
  }
}

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const files: string[] = []
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (files.length >= MAX_LISTED_FILES) break
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      files.push(...(await listFiles(path.join(dir, entry.name), relative)))
    } else if (relative !== SKILL_FILE) {
      files.push(relative)
    }
  }
  return files.slice(0, MAX_LISTED_FILES)
}

/**
 * The section of the system prompt that tells the model which skills exist. Empty when there are
 * none. Those only the person picks (commands, `userOnly`) are not among them.
 */
export function skillsPrompt(all: SkillInfo[]): string {
  const skills = all.filter((s) => !s.userOnly)
  if (skills.length === 0) return ''
  return [
    'Skills:',
    'Skills are instructions written for specific kinds of tasks. When a request matches a skill\'s description,',
    'call load_skill with its name before starting the work and follow what it returns.',
    ...skills.map((s) => `- ${s.name}: ${s.description || '(no description)'}`)
  ].join('\n')
}

/** Wraps a loaded skill for a user message where the user picked the skill themselves. */
export function selectedSkillPrompt(name: string, loaded: string): string {
  return `The user selected the "${name}" skill for this request. Follow its instructions.\n\n<skill>\n${loaded}\n</skill>`
}

/** The tool through which the model reads a skill. */
export function loadSkillTool(store: SkillStore): ToolSpec {
  return {
    name: 'load_skill',
    description:
      'Load the full instructions of a skill listed under "Skills" in the system prompt. Pass "file" to read one of the skill\'s supporting files instead.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the skill' },
        file: { type: 'string', description: 'Path of a supporting file, relative to the skill directory' }
      },
      required: ['name']
    },
    needsPermission: false,
    async run(args) {
      if (typeof args.name !== 'string') throw new Error('Missing string argument "name"')
      // A command is the person's to pick: what it says is meant for when they ask for it.
      if ((await store.list()).some((s) => s.name === args.name && s.userOnly)) throw new Error(`"${args.name}" is a command only the user picks; it cannot be loaded.`)
      return typeof args.file === 'string' && args.file
        ? store.readFile(args.name, args.file)
        : store.load(args.name)
    }
  }
}
