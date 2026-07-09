import type { SessionStore } from '../session/SessionStore.js';
import type { MemoryService } from '../memory/MemoryService.js';
import type { EnforcementRule, HarnessHooks } from '../types/index.js';
import type { ToolExecutor } from './ToolExecutor.js';
import type { ConversationState } from './ConversationState.js';
import type { ConversationEventLog } from './ConversationEventLog.js';
import type { AgentStateController } from './AgentStateController.js';
import { DefaultToolExecutor } from './DefaultToolExecutor.js';
import { DefaultConversationState } from './DefaultConversationState.js';
import { DefaultConversationEventLog } from './DefaultConversationEventLog.js';
import { DefaultAgentStateController } from './DefaultAgentStateController.js';
import { ToolEnforcer } from '../guards/ToolEnforcer.js';
import { defaultEnforcementRules } from '../guards/rules.js';
import { HookRunner } from '../hooks/HookRunner.js';
import { MemoryStore } from '../session/stores/MemoryStore.js';

/**
 * Configuration for creating a foundation service bundle.
 */
export interface FoundationConfig {
  sessionStore?: SessionStore;
  defaultAgentId?: string;
  enforcementRules?: EnforcementRule[];
  hooks?: HarnessHooks;
  memoryService?: MemoryService;
}

/**
 * Bundle of all foundation services. Both Runtime and VoiceEngine
 * compose this to share operational logic.
 */
export interface Foundation {
  toolExecutor: ToolExecutor;
  conversationState: ConversationState;
  eventLog: ConversationEventLog;
  agentState: AgentStateController;
}

/**
 * Create a foundation service bundle with default implementations.
 * Services can be individually overridden if needed.
 */
export function createFoundation(config: FoundationConfig = {}): Foundation {
  const sessionStore = config.sessionStore ?? new MemoryStore();
  const defaultAgentId = config.defaultAgentId ?? 'default';
  const enforcer = new ToolEnforcer(config.enforcementRules ?? defaultEnforcementRules);
  const hookRunner = new HookRunner(config.hooks);

  return {
    toolExecutor: new DefaultToolExecutor({
      enforcer,
      hookRunner,
      memoryService: config.memoryService,
    }),
    conversationState: new DefaultConversationState({
      sessionStore,
      defaultAgentId,
    }),
    eventLog: new DefaultConversationEventLog({
      sessionStore,
    }),
    agentState: new DefaultAgentStateController(),
  };
}
