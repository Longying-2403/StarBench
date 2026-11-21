// Types shared between the main process, the preload bridge and the renderer.

export interface ToolCall {
  id: string
  name: string
  /** Raw JSON string of the arguments, exactly as the model produced it. */
  arguments: string
}

/** One message of the conversation, in the shape the chat completions API expects. */
export type ChatMessage =
  | { role: 'user'; content: string }
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
  pickWorkspace(): Promise<string | null>
  listSessions(): Promise<SessionSummary[]>
  loadSession(id: string): Promise<Session | null>
  deleteSession(id: string): Promise<void>
  /** Starts a turn. Creates the session when `sessionId` is null. Resolves with the session id. */
  send(sessionId: string | null, workspace: string, text: string): Promise<string>
  stop(sessionId: string): Promise<void>
  respondPermission(id: string, decision: PermissionDecision): Promise<void>
  onEvent(listener: (e: SessionEvent) => void): () => void
}
