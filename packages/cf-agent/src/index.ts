/**
 * @kuralle-agents/cf-agent
 *
 * Run Kuralle agents on Cloudflare Durable Objects.
 *
 * Extends CF's AIChatAgent -- CF owns messages, persistence, WebSocket,
 * and stream resumability. Kuralle owns agent orchestration.
 *
 * @example
 * ```typescript
 * import { KuralleAgent } from '@kuralle-agents/cf-agent';
 *
 * class MyAgent extends KuralleAgent<Env> {
 *   protected getAgents() {
 *     return [{
 *       id: 'support',
 *       name: 'Support',
 *       model: openai('gpt-4o', { apiKey: this.env.OPENAI_API_KEY }),
 *       instructions: 'You are a helpful support agent.',
 *     }];
 *   }
 *   protected getDefaultAgentId() { return 'support'; }
 * }
 * ```
 */

export { KuralleAgent, KuralleAgent as CfChatAgent } from './KuralleAgent.js';
export type { ResolvedRuntimeDefinition } from './KuralleAgent.js';
export { KuralleThreadAgent } from './KuralleThreadAgent.js';
export {
  durableObjectArtifactWorkspaceProvider,
  fileSystemArtifactWorkspaceProvider,
  type DurableObjectArtifactWorkspaceOptions,
  type FileSystemArtifactWorkspaceOptions,
} from './ArtifactWorkspaceProvider.js';
export { SqlThreadPinStore } from './SqlThreadPinStore.js';
export { BridgeSessionStore } from './BridgeSessionStore.js';
export { OrchestrationStore } from './OrchestrationStore.js';
export { SqlPersistentMemoryStore } from './SqlPersistentMemoryStore.js';
export { SqlExtractedValueStore } from './SqlExtractedValueStore.js';
export { SqlTraceStore } from './SqlTraceStore.js';
export { SqlRunStore } from './SqlRunStore.js';
export { createSqlExecutor } from './sqlExecutor.js';
export { lastUserInputFromMessages } from './cfMessageInput.js';
export {
  AgentScheduleCoalesceScheduler,
  QueuedTurnRunner,
  RuntimeTurnRunner,
  SqlConsentStore,
  SqlInboundLedger,
  SqlOwnershipStore,
  SqlWindowStore,
  createDurableObjectInboundRuntime,
  eventSeqFromSql,
} from './inbound-runtime.js';

export type {
  DurableSqlStorage,
  DurableSqlValue,
  OrchestrationState,
  SqlExecutor,
} from './types.js';

export type {
  DurableObjectInboundRuntimeOptions,
  ScheduleHost,
} from './inbound-runtime.js';


// Re-export core types for convenience
export type {
  HarnessConfig,
  StreamPart,
  Session,
} from '@kuralle-agents/core';
