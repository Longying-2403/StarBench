// Types shared between the main process, the preload bridge and the renderer.

export interface ToolCall {
  id: string
  name: string
  /** Raw JSON string of the arguments, exactly as the model produced it. */
  arguments: string
}

/** One message of the conversation, in the shape the chat completions API expects. */
export type ChatMessage =
  | {
      role: 'user'
      content: string
      /**
       * A skill the user picked for this message. `prompt` is the skill text exactly as it was
       * sent to the model, kept so later requests replay the same conversation.
       */
      skill?: { name: string; prompt: string }
    }
  | {
      role: 'assistant'
      content: string
      reasoning_content?: string
      tool_calls?: ToolCall[]
    }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface Session {
  id: string
  title: string
  workspace: string
  updatedAt: number
  /** Put away: kept, but out of the main list. */
  archived?: boolean
  messages: ChatMessage[]
}

export type SessionSummary = Pick<Session, 'id' | 'title' | 'workspace' | 'updatedAt' | 'archived'>

/**
 * How hard the model thinks before it answers. `default` sends nothing and leaves the choice to
 * the service; `none` turns thinking off. The others are values of the API's `reasoning_effort`.
 */
export const REASONING_EFFORTS = ['default', 'none', 'low', 'high', 'max'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]
export const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  (REASONING_EFFORTS as readonly unknown[]).includes(value)

/** What the model service reports about the configured model. Services differ, so everything is optional. */
export interface ModelInfo {
  /** Readable name with the version, e.g. "DeepSeek-V4.1-Flash". */
  name?: string
  /** The thinking levels the model accepts. */
  efforts?: Exclude<ReasoningEffort, 'default'>[]
  /** The level the service uses when none is sent. */
  defaultEffort?: Exclude<ReasoningEffort, 'default'>
}

export interface Settings {
  baseURL: string
  model: string
  reasoningEffort: ReasoningEffort
  /** The key itself never leaves the main process. */
  hasApiKey: boolean
}

export interface SettingsInput {
  baseURL: string
  model: string
  /** Omit to keep the stored key; empty string clears it. */
  apiKey?: string
}

export interface PluginInfo {
  /** Folder name under the plugins directory. */
  id: string
  name: string
  version: string
  description: string
  enabled: boolean
  /** `waiting`: enabled, but a service it injects is not available yet. */
  status: 'disabled' | 'active' | 'waiting' | 'error'
  error?: string
  /** Names of the tools it currently provides. */
  tools: string[]
  /** Names of the skills it currently provides. */
  skills: string[]
}

export interface McpServerStatus {
  name: string
  transport: 'stdio' | 'http'
  state: 'disabled' | 'connecting' | 'connected' | 'error'
  error?: string
  /** Names of its tools as the model sees them (`mcp__server__tool`). */
  tools: string[]
}

export interface SkillInfo {
  name: string
  description: string
  /** "user" for the user's own skills folder, otherwise the id of the plugin that ships it. */
  source: string
}

export type PermissionDecision = 'allow' | 'always' | 'deny'

export type AgentEvent =
  | { type: 'reasoning_delta'; text: string }
  | { type: 'text_delta'; text: string }
  /** The model finished one assistant message (text and/or tool calls). */
  | { type: 'assistant_done' }
  | { type: 'tool_start'; call: ToolCall }
  | { type: 'tool_result'; id: string; output: string }
  | { type: 'permission_request'; id: string; call: ToolCall }
  | { type: 'turn_end' }
  | { type: 'error'; message: string }

export interface SessionEvent {
  sessionId: string
  event: AgentEvent
}

export interface HarnessApi {
  getSettings(): Promise<Settings>
  saveSettings(input: SettingsInput): Promise<Settings>
  /** Applies from the next message on. Resolves with the updated settings. */
  setReasoningEffort(effort: ReasoningEffort): Promise<Settings>
  /** Asks the model service about the configured model. Null when it has nothing to say or cannot be reached. */
  getModelInfo(): Promise<ModelInfo | null>
  listPlugins(): Promise<PluginInfo[]>
  /** Resolves with the refreshed list. */
  setPluginEnabled(id: string, enabled: boolean): Promise<PluginInfo[]>
  openPluginsFolder(): Promise<void>
  listSkills(): Promise<SkillInfo[]>
  openSkillsFolder(): Promise<void>
  /** The text of mcp.json and the state of each server in it. `error` is set when the file could not be loaded. */
  getMcp(): Promise<{ config: string; servers: McpServerStatus[]; error?: string }>
  /** Validates and saves the text, then reconnects. Rejects with a readable message when it is invalid. */
  saveMcp(config: string): Promise<McpServerStatus[]>
  reconnectMcp(): Promise<McpServerStatus[]>
  mcpStatus(): Promise<McpServerStatus[]>
  /** Opens the system folder dialog. Resolves with null when it is cancelled. */
  pickWorkspace(): Promise<string | null>
  /** Folders used before that still exist, most recent first. */
  listWorkspaces(): Promise<string[]>
  listSessions(): Promise<SessionSummary[]>
  loadSession(id: string): Promise<Session | null>
  deleteSession(id: string): Promise<void>
  renameSession(id: string, title: string): Promise<void>
  /** Archived sessions stay on disk and can be brought back. */
  setSessionArchived(id: string, archived: boolean): Promise<void>
  /**
   * Starts a turn. Creates the session when `sessionId` is null. Resolves with the session id.
   * `skill` names a skill the user picked for this message.
   */
  send(sessionId: string | null, workspace: string, text: string, skill?: string): Promise<string>
  stop(sessionId: string): Promise<void>
  respondPermission(id: string, decision: PermissionDecision): Promise<void>
  onEvent(listener: (e: SessionEvent) => void): () => void
}
