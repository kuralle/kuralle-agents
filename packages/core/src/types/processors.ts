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
  /** Absent ⇒ `turn` (buffered, safe). Streaming is an explicit opt-in by the gate author. */
  streamGranularity?: 'sentence' | 'turn';
  process: (args: {
    text: string;
    messages: ModelMessage[];
    context: ProcessorContext;
  }) => Promise<OutputProcessorResult> | OutputProcessorResult;
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
