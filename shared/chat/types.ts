import type { ChatRuntimeEvent } from '../chat-runtime-events';

/** Metadata for locally-attached files (not from Gateway) */
export interface AttachedFileMeta {
  fileName: string;
  mimeType: string;
  fileSize: number;
  preview: string | null;
  previewStatus?: 'unavailable';
  filePath?: string;
  source?: 'user-upload' | 'tool-result' | 'message-ref' | 'gateway-media';
  /**
   * For Gateway-injected outgoing media (assistant-media). The Gateway emits
   * an `image` content block with a relative URL like
   * `/api/chat/media/outgoing/<sessionKey>/<attachmentId>/full`. The renderer
   * cannot reach Gateway HTTP directly (CORS / env drift), so this URL is
   * resolved through the Main-process proxy in `media:getThumbnails`, which
   * looks up `~/.openclaw/media/outgoing/records/<attachmentId>.json` and
   * loads the original file off disk.
   */
  gatewayUrl?: string;
}

/** Raw message from OpenClaw chat.history */
export interface RawMessage {
  role: 'user' | 'assistant' | 'system' | 'toolresult';
  content: unknown; // string | ContentBlock[]
  timestamp?: number;
  id?: string;
  model?: string;
  modelRef?: string;
  provider?: string;
  usage?: {
    [key: string]: unknown;
    input?: number | string;
    output?: number | string;
    read?: number | string;
    write?: number | string;
    total?: number | string;
    cacheRead?: number | string;
    cacheWrite?: number | string;
    readTokens?: number | string;
    writeTokens?: number | string;
    promptTokens?: number | string;
    completionTokens?: number | string;
    totalTokens?: number | string;
    input_tokens?: number | string;
    output_tokens?: number | string;
    read_tokens?: number | string;
    write_tokens?: number | string;
    total_tokens?: number | string;
    cache_read?: number | string;
    cache_write?: number | string;
    readTokenCount?: number | string;
    writeTokenCount?: number | string;
    read_token_count?: number | string;
    write_token_count?: number | string;
    prompt_tokens?: number | string;
    completion_tokens?: number | string;
    cache_read_tokens?: number | string;
    cache_write_tokens?: number | string;
    cacheReadInputTokens?: number | string;
    cacheCreationInputTokens?: number | string;
    cache_read_input_tokens?: number | string;
    cache_creation_input_tokens?: number | string;
    contextTokens?: number | string;
    context_tokens?: number | string;
    contextWindow?: number | string;
    context_window?: number | string;
    maxTokens?: number | string;
    max_tokens?: number | string;
    cost?: {
      [key: string]: unknown;
      total?: number | string;
      totalCost?: number | string;
      total_cost?: number | string;
    };
  };
  cost?: {
    [key: string]: unknown;
    total?: number | string;
    totalCost?: number | string;
    total_cost?: number | string;
  };
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
  stopReason?: string;
  stop_reason?: string;
  errorMessage?: string;
  error_message?: string;
  /** Local-only: file metadata for user-uploaded attachments (not sent to/from Gateway) */
  _attachedFiles?: AttachedFileMeta[];
}

/** Content block inside a message */
export interface ContentBlock {
  type: 'text' | 'image' | 'thinking' | 'tool_use' | 'tool_result' | 'toolCall' | 'toolResult';
  text?: string;
  thinking?: string;
  source?: { type: string; media_type?: string; data?: string; url?: string };
  /** Flat image format from Gateway tool results (no source wrapper) */
  data?: string;
  mimeType?: string;
  /**
   * Flat URL on an `image` block. Gateway-injected assistant-media messages
   * use this shape: `{ type:'image', url:'/api/chat/media/outgoing/...', mimeType, width, height, alt, openUrl }`.
   * Neither nested `source.url` nor flat `data` is set in that case; the
   * renderer must read `block.url` directly to surface the artifact.
   */
  url?: string;
  /** Optional companion of `url` — points at a higher-resolution variant. */
  openUrl?: string;
  /** Pixel width of the original image, used for layout hints. */
  width?: number;
  /** Pixel height of the original image, used for layout hints. */
  height?: number;
  /** Human-readable filename / alt text emitted by the Gateway. */
  alt?: string;
  id?: string;
  name?: string;
  input?: unknown;
  arguments?: unknown;
  content?: unknown;
}

/** Session from sessions.list */
export interface ChatSession {
  key: string;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  thinkingLevel?: string;
  thinkingDefault?: string;
  thinkingOptions?: ChatThinkingOption[];
  thinkingLevels?: ChatThinkingOption[];
  model?: string;
  modelProvider?: string;
  updatedAt?: number;
  status?: string;
  hasActiveRun?: boolean;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  contextTokens?: number;
  contextBudgetStatus?: string;
  compactionCount?: number;
}

export interface ChatSessionDefaults {
  contextTokens?: number;
  model?: string;
  modelProvider?: string;
  thinkingDefault?: string;
  thinkingOptions?: ChatThinkingOption[];
  thinkingLevels?: ChatThinkingOption[];
}

export interface ChatThinkingOption {
  id: string;
  label: string;
}

export interface ToolStatus {
  id?: string;
  toolCallId?: string;
  name: string;
  status: 'running' | 'completed' | 'error';
  durationMs?: number;
  summary?: string;
  updatedAt: number;
}

export interface ChatRuntimeRunState {
  runId: string;
  sessionKey?: string;
  status: 'running' | 'completed' | 'error' | 'aborted';
  startedAt?: number;
  endedAt?: number;
  assistantText: string;
  thinkingText: string;
  events: ChatRuntimeEvent[];
}

export interface ChatState {
  // Messages
  messages: RawMessage[];
  loading: boolean;
  loadingMoreHistory: boolean;
  hasMoreHistory: boolean;
  error: string | null;
  runError: string | null;
  /** Per-session runError text dismissed by the user (sessionKey -> error message). */
  dismissedRunErrors: Record<string, string>;

  // Streaming
  sending: boolean;
  activeRunId: string | null;
  streamingText: string;
  streamingMessage: unknown | null;
  streamingTools: ToolStatus[];
  pendingFinal: boolean;
  lastUserMessageAt: number | null;
  /** Images collected from tool results, attached to the next assistant message */
  pendingToolImages: AttachedFileMeta[];
  runtimeRuns: Record<string, ChatRuntimeRunState>;

  // Sessions
  sessions: ChatSession[];
  sessionDefaults: ChatSessionDefaults;
  currentSessionKey: string;
  currentAgentId: string;
  /** First user message text per session key, used as display label */
  sessionLabels: Record<string, string>;
  /** Last message timestamp (ms) per session key, used for sorting */
  sessionLastActivity: Record<string, number>;

  // Thinking
  thinkingLevel: string | null;

  // Actions
  loadSessions: () => Promise<void>;
  switchSession: (key: string) => void;
  newSession: () => void;
  deleteSession: (key: string) => Promise<void>;
  renameSession: (key: string, label: string) => Promise<void>;
  cleanupEmptySession: () => void;
  loadHistory: (quiet?: boolean) => Promise<void>;
  loadMoreHistory: () => Promise<void>;
  sendMessage: (
    text: string,
    attachments?: Array<{
      fileName: string;
      mimeType: string;
      fileSize: number;
      stagedPath: string;
      preview: string | null;
    }>,
    targetAgentId?: string | null,
  ) => Promise<void>;
  abortRun: () => Promise<void>;
  handleChatEvent: (event: Record<string, unknown>) => void;
  handleRuntimeEvent: (event: ChatRuntimeEvent) => void;
  refresh: () => Promise<void>;
  clearError: () => void;
}

export const DEFAULT_CANONICAL_PREFIX = 'agent:main';
export const DEFAULT_SESSION_KEY = `${DEFAULT_CANONICAL_PREFIX}:main`;
