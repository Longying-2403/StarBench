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
  messages: ChatMessage[]
}

export type SessionSummary = Pick<Session, 'id' | 'title' | 'workspace' | 'updatedAt'>

export interface Settings {
  baseURL: string
  model: string
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
  pickWorkspace(): Promise<string | null>
  listSessions(): Promise<SessionSummary[]>
  loadSession(id: string): Promise<Session | null>
  deleteSession(id: string): Promise<void>
  /**
   * Starts a turn. Creates the session when `sessionId` is null. Resolves with the session id.
   * `skill` names a skill the user picked for this message.
   */
  send(sessionId: string | null, workspace: string, text: string, skill?: string): Promise<string>
  stop(sessionId: string): Promise<void>
  respondPermission(id: string, decision: PermissionDecision): Promise<void>
  onEvent(listener: (e: SessionEvent) => void): () => void
}
