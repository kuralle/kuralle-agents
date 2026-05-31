import type { AgentDefinition, Foundation } from '@kuralle-agents/core/foundation';
import type { Flow, ToolSet } from '@kuralle-agents/core/types';
import type { Hooks } from '@kuralle-agents/core';
import type { LanguageModel } from 'ai';
import type { LivePromptAssembler } from '@kuralle-agents/core/capabilities';
import type { MemoryService } from '@kuralle-agents/core/memory';
import type { RealtimeAudioClient } from '@kuralle-agents/core/realtime';

/**
 * Voice tools use the standard AI SDK ToolSet type.
 * Define tools using `tool()` from `ai` with `inputSchema` and `execute`.
 *
 * All voice tools MUST have an `execute` function. Schema-only tools
 * (tools without execute) are not supported in voice agents.
 */
export type VoiceToolSet = ToolSet;

/** @deprecated Use `ToolSet[string]` or define tools with `tool()` from `ai`. */
export type VoiceToolDef = ToolSet[string];

/**
 * Voice agent configuration — supports both flat tool agents (v1) and
 * flow-aware agents (v2) when `flow` is provided.
 */
export interface VoiceAgentConfig extends AgentDefinition {
  /** Agent-level instructions (preferred over legacy `prompt`). */
  instructions?: string;
  tools?: ToolSet;
  /** Gemini Live voice preset. */
  voice?: string;
  /** Optional v2 flow. When set, VoiceEngine wires flow-aware routing. */
  flow?: Flow;
  /** The initial node ID when `flow` is set. Defaults to the first node in the flow. */
  initialNode?: string;
}

/**
 * Minimal call-worker contract. VoiceEngine holds call workers through this
 * interface; the only implementation today is `RealtimeCallWorker`.
 */
export interface WorkerLike {
  readonly callId: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Gemini model/API configuration. */
export interface GeminiConfig {
  apiKey: string;
  model?: string;
}

/** Top-level VoiceEngine configuration. */
export interface VoiceEngineConfig {
  foundation?: Foundation;
  agents: VoiceAgentConfig[];
  defaultAgentId: string;
  /** Default language model for agents that do not specify one. */
  defaultModel?: LanguageModel;
  /**
   * Gemini API configuration. Required when using the default Gemini provider.
   * Optional when a custom `createModelClient` factory is provided.
   */
  gemini?: GeminiConfig;
  /**
   * Custom factory for creating a RealtimeAudioClient per call.
   * When provided, this factory is used instead of creating a GeminiLiveSession.
   * This is the provider abstraction point — use it to plug in OpenAI Realtime,
   * a custom WebSocket client, or any other provider.
   *
   * Example (OpenAI):
   * ```typescript
   * createModelClient: (agent) => new OpenAIRealtimeClient({ apiKey: '...' })
   * ```
   */
  createModelClient?: (agent: VoiceAgentConfig) => RealtimeAudioClient;
  /**
   * Optional LivePromptAssembler (port) for building audio-optimized prompts.
   * Used by VoiceEngine when assembling provider-native realtime prompts.
   */
  promptAssembler?: LivePromptAssembler;
  /**
   * Optional MemoryService for cross-session long-term memory.
   * When provided, the authority handles memory preloading and ingestion.
   */
  memoryService?: MemoryService;
  /**
   * Hook callbacks for lifecycle events (onStart, onEnd, onToolResult, etc.).
   * Passed to VoiceEngine for hook parity with the text Runtime.
   */
  hooks?: Hooks;
  /**
   * Controls automatic memory ingestion behavior.
   * - 'onEnd': Ingest after session close (default when memoryService is set)
   * - 'manual': Developer must call memoryService.addSessionToMemory() explicitly
   * - 'hook': Fires onMemoryIngest hook
   */
  memoryIngestion?: 'onEnd' | 'manual' | 'hook';
  /**
   * Optional dedicated text model used to verify extraction-node data in
   * realtime sessions. When omitted, the core authority stays in conservative
   * fallback mode rather than claiming full extraction parity.
   */
  extractionModel?: LanguageModel;
}

/** Transport session abstraction for audio I/O. */
export interface TransportSession {
  /** Send audio frames to the client. */
  sendAudio(data: Uint8Array): void;
  /** Receive audio frames from the client. */
  onAudio(handler: (data: Uint8Array) => void): void;
  /** Called when the session ends. */
  onClose(handler: () => void): void;
  /** Close the transport. */
  close(): void;
}

/** Parameters for accepting a new call. */
export interface AcceptCallParams {
  callId: string;
  sessionId?: string;
  userId?: string;
  transport: TransportSession;
  agentId?: string;
}

/**
 * Realtime events emitted by the Gemini Live session.
 */
export type RealtimeEvent =
  | { type: 'audio'; data: Uint8Array }
  | { type: 'transcript'; text: string; role: 'user' | 'assistant' }
  | { type: 'tool-call'; id: string; name: string; args: unknown }
  | { type: 'tool-result'; id: string; name: string; result: unknown }
  | { type: 'interrupted' }
  | { type: 'turn-complete' }
  | { type: 'session-resumed'; newHandle: string }
  | { type: 'error'; error: string };
