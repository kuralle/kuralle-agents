import type { ModelMessage } from 'ai';
import type { Session, AgentContext, ToolCallRecord } from './session.js';

export type ProcessorAction = 'allow' | 'modify' | 'block';

export interface FlowPromptContext {
  collectedData: Record<string, unknown>;
}

export interface ProcessorContext {
  session?: Session;
  agentId?: string;
  flowContext?: FlowPromptContext;
  toolCallHistory?: ToolCallRecord[];
  abortSignal?: AbortSignal;
}

export interface InputProcessorResult {
  action: ProcessorAction;
  input?: string;
  reason?: string;
  message?: string;
}

export interface OutputProcessorResult {
  action: ProcessorAction;
  text?: string;
  reason?: string;
  message?: string;
}

export interface InputProcessor {
  id: string;
  name?: string;
  description?: string;
  process: (args: {
    input: string;
    messages: ModelMessage[];
    context: ProcessorContext;
  }) => Promise<InputProcessorResult> | InputProcessorResult;
}

export interface OutputProcessor {
  id: string;
  name?: string;
  description?: string;
  process: (args: {
    text: string;
    messages: ModelMessage[];
    context: ProcessorContext;
  }) => Promise<OutputProcessorResult> | OutputProcessorResult;
}

export interface HandoffInputData {
  messages: ModelMessage[];
  workingMemory: Record<string, unknown>;
  sourceAgentId: string;
  targetAgentId: string;
  reason?: string;
}

export interface HandoffInputResult {
  messages: ModelMessage[];
  workingMemory: Record<string, unknown>;
}

export type HandoffInputFilter = (
  data: HandoffInputData,
) => Promise<HandoffInputResult> | HandoffInputResult;

export interface AgentRoute {
  agentId: string;
  description: string;
  condition?: RouteCondition;
  inputFilter?: HandoffInputFilter;
}

export type RouteCondition = (
  input: string,
  context: AgentContext,
) => Promise<boolean>;

export interface AgentCapabilityDescriptor {
  summary: string;
  keywords: string[];
  handlesIntents?: string[];
  doesNotHandle?: string[];
}

export type AgentStreamPart =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; toolName: string; args: unknown; toolCallId?: string }
  | { type: 'tool-result'; toolName: string; result: unknown; toolCallId?: string }
  | { type: 'tool-error'; toolName: string; error: string; toolCallId?: string }
  | { type: 'handoff'; targetAgent: string; reason?: string }
  | { type: 'node-enter'; nodeName: string }
  | { type: 'node-exit'; nodeName: string }
  | { type: 'flow-transition'; from: string; to: string }
  | { type: 'flow-end'; reason: string }
  | { type: 'custom'; name: string; data: unknown; timestamp?: Date }
  | { type: 'turn-end'; metadata?: Record<string, unknown> }
  | { type: 'error'; error: string };
