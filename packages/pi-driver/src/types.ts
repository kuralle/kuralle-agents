import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, Model, Models, ThinkingLevel } from '@earendil-works/pi-ai';
import type { LanguageModel } from 'ai';
import type { AnyTool, FlowNode, RunContext } from '@kuralle-agents/core';

export interface PiModelResolutionContext {
  purpose: 'speaking' | 'extraction' | 'structured';
  /** The AI SDK model selected by the Kuralle agent/node. Useful as a routing key. */
  languageModel: LanguageModel;
  node: FlowNode;
  ctx: RunContext;
}

export type PiModelResolver =
  | Model<Api>
  | ((context: PiModelResolutionContext) => Model<Api> | Promise<Model<Api>>);

export interface PiDriverConfig {
  /** Pi model used for speaking turns. A resolver can mirror per-node Kuralle model selection. */
  model: PiModelResolver;
  /** Optional Pi provider stream override; useful for gateways, tests, and custom transports. */
  streamFn?: StreamFn;
  /** Current Pi provider collection. Preferred over the temporary Pi compat registry. */
  models?: Pick<Models, 'streamSimple'>;
  /** Resolve short-lived provider credentials for each Pi request. */
  getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
  thinkingLevel?: 'off' | ThinkingLevel;
  maxSteps?: number;
  toolDefs?: Record<string, AnyTool>;
  /**
   * Typed-flow control substrate. `pi` is the default and uses submit tools for
   * collect and decide nodes as well; `ai-sdk` is the explicit compatibility fallback.
   */
  typedFlows?: 'ai-sdk' | 'pi';
}
