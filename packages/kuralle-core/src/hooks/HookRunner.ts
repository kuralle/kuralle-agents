import type {
  HarnessHooks,
  RunContext,
  StepResult,
  ToolCallRecord,
  HarnessStreamPart,
  Session,
  TurnUsage,
  ConversationOutcomeRecord,
  TurnEndHookResult,
  TurnSummary,
} from '../types/index.js';
import type { SessionEndMetadata } from '../types/telemetry.js';
import type { ModelMessage } from 'ai';

type HookErrorHandler = (hookName: string, error: Error) => void;
type HookHandler = (...args: unknown[]) => Promise<void>;

const defaultErrorHandler: HookErrorHandler = (hookName, error) => {
  console.error(`[HookRunner] Hook "${hookName}" failed:`, error.message);
};

export class HookRunner {
  private hooks: HarnessHooks;
  private errorHandler: HookErrorHandler;

  constructor(hooks: HarnessHooks = {}, errorHandler?: HookErrorHandler) {
    this.hooks = hooks;
    this.errorHandler = errorHandler ?? defaultErrorHandler;
  }

  /** Check if a specific hook is configured. */
  has(hookName: string): boolean {
    return Boolean((this.hooks as Record<string, unknown>)[hookName]);
  }

  async run<K extends keyof HarnessHooks>(
    hookName: K,
    ...args: NonNullable<HarnessHooks[K]> extends (...args: infer P) => unknown ? P : never
  ): Promise<void> {
    const hook = this.hooks[hookName];
    if (!hook) return;

    try {
      await (hook as (...args: unknown[]) => Promise<void>)(...args);
    } catch (error) {
      this.errorHandler(String(hookName), error as Error);
    }
  }

  async onStart(context: RunContext): Promise<void> {
    await this.run('onStart', context);
  }

  async onEnd(context: RunContext, result: { success: boolean; error?: Error }): Promise<void> {
    await this.run('onEnd', context, result);
  }

  async onStepStart(context: RunContext, step: number): Promise<void> {
    await this.run('onStepStart', context, step);
  }

  async onStepEnd(context: RunContext, step: number, result: StepResult): Promise<void> {
    await this.run('onStepEnd', context, step, result);
  }

  async onTokensUpdate(context: RunContext, turn: TurnUsage): Promise<void> {
    await this.run('onTokensUpdate', context, turn);
  }

  async onToolCall(context: RunContext, call: ToolCallRecord): Promise<void> {
    await this.run('onToolCall', context, call);
  }

  async onToolResult(context: RunContext, call: ToolCallRecord): Promise<void> {
    await this.run('onToolResult', context, call);
  }

  async onToolError(context: RunContext, call: ToolCallRecord, error: Error): Promise<void> {
    await this.run('onToolError', context, call, error);
  }

  async onTurnEnd(context: RunContext, summary: TurnSummary): Promise<TurnEndHookResult | void> {
    const hook = this.hooks.onTurnEnd;
    if (!hook) return;

    try {
      return await hook(context, summary);
    } catch (error) {
      this.errorHandler('onTurnEnd', error as Error);
    }
  }

  async onAgentStart(context: RunContext, agentId: string): Promise<void> {
    await this.run('onAgentStart', context, agentId);
  }

  async onAgentEnd(context: RunContext, agentId: string): Promise<void> {
    await this.run('onAgentEnd', context, agentId);
  }

  async onHandoff(context: RunContext, from: string, to: string, reason: string): Promise<void> {
    await this.run('onHandoff', context, from, to, reason);
  }

  async onError(context: RunContext, error: Error): Promise<void> {
    await this.run('onError', context, error);
  }

  async onMessage(context: RunContext, message: ModelMessage): Promise<void> {
    await this.run('onMessage', context, message);
  }

  async onStreamPart(context: RunContext, part: HarnessStreamPart): Promise<void> {
    await this.run('onStreamPart', context, part);
  }

  async onSessionEnd(session: Session, metadata: SessionEndMetadata): Promise<void> {
    await this.run('onSessionEnd', session, metadata);
  }

  async onConversationEnd(session: Session, outcome: ConversationOutcomeRecord): Promise<void> {
    await this.run('onConversationEnd', session, outcome);
  }

  merge(additionalHooks: HarnessHooks): void {
    const hooks = this.hooks as Record<string, unknown>;
    for (const [key, hook] of Object.entries(additionalHooks)) {
      const existing = hooks[key] as HookHandler | undefined;
      if (!hook) continue;

      if (existing) {
        hooks[key] = (async (...args: unknown[]) => {
          await existing(...args);
          await (hook as HookHandler)(...args);
        }) as HookHandler;
      } else {
        hooks[key] = hook as HookHandler;
      }
    }
  }

  setHooks(hooks: HarnessHooks): void {
    this.hooks = hooks;
  }

  getHooks(): HarnessHooks {
    return { ...this.hooks };
  }
}

export function createHookRunner(
  hooks?: HarnessHooks,
  errorHandler?: HookErrorHandler
): HookRunner {
  return new HookRunner(hooks, errorHandler);
}
