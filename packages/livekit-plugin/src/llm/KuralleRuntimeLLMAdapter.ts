import type { HarnessStreamPart, TurnHandle, HarnessConfig } from '@kuralle-agents/core';
import { createRuntime, Runtime } from '@kuralle-agents/core';
import { DEFAULT_API_CONNECT_OPTIONS, llm, type APIConnectOptions } from '@livekit/agents';
import type { VoiceMetricsSink } from '../metrics/types.js';
import { emitKuralleMetric } from '../metrics/bridge.js';

export type KuralleRuntimeRunOptions = {
  input: string;
  sessionId?: string;
  userId?: string;
  abortSignal?: AbortSignal;
};

export interface KuralleRuntimeLike {
  run(options: KuralleRuntimeRunOptions): TurnHandle;
  abortSession?(sessionId: string, reason?: string): void;
}

type KuralleRuntimeBinding = Runtime | KuralleRuntimeLike;

export interface KuralleRuntimeLLMAdapterOptions {
  runtime: Runtime | HarnessConfig | KuralleRuntimeLike;
  sessionId?: string;
  userId?: string;
  prompt?: string;
  onKuralleHandoff?: (from: string, to: string) => void | Promise<void>;
  onMetrics?: VoiceMetricsSink;
}

function cloneConfigWithInjectedPrompt(config: HarnessConfig, prompt?: string): HarnessConfig {
  if (!prompt?.trim()) {
    return config;
  }

  return {
    ...config,
    agents: config.agents.map((agent) => {
      const instructions = agent.instructions;
      if (typeof instructions !== 'string') {
        return agent;
      }

      return {
        ...agent,
        instructions: `${prompt.trim()}\n\n${instructions}`,
      };
    }),
  };
}

function isKuralleRuntimeLike(runtime: unknown): runtime is KuralleRuntimeLike {
  return (
    typeof runtime === 'object' &&
    runtime !== null &&
    typeof (runtime as KuralleRuntimeLike).run === 'function' &&
    !(runtime instanceof Runtime)
  );
}

function resolveRuntime(
  runtime: Runtime | HarnessConfig | KuralleRuntimeLike,
  prompt?: string,
): KuralleRuntimeBinding {
  if (runtime instanceof Runtime) {
    return runtime;
  }
  if (isKuralleRuntimeLike(runtime)) {
    return runtime;
  }
  return createRuntime(cloneConfigWithInjectedPrompt(runtime, prompt));
}

export class KuralleRuntimeLLMAdapter extends llm.LLM {
  #runtime: KuralleRuntimeBinding;
  #sessionId: string;
  #userId?: string;
  #onKuralleHandoff?: (from: string, to: string) => void | Promise<void>;
  #onMetrics?: VoiceMetricsSink;

  constructor(opts: KuralleRuntimeLLMAdapterOptions) {
    super();

    this.#runtime = resolveRuntime(opts.runtime, opts.prompt);
    this.#sessionId = opts.sessionId ?? `livekit-${crypto.randomUUID()}`;
    this.#userId = opts.userId;
    this.#onKuralleHandoff = opts.onKuralleHandoff;
    this.#onMetrics = opts.onMetrics;
  }

  label(): string {
    return 'kuralle.runtime.llm';
  }

  get model(): string {
    return 'kuralle-runtime';
  }

  setSessionContext(args: { sessionId?: string; userId?: string }): void {
    if (args.sessionId) {
      this.#sessionId = args.sessionId;
    }

    if (args.userId !== undefined) {
      this.#userId = args.userId;
    }
  }

  chat({
    chatCtx,
    connOptions = DEFAULT_API_CONNECT_OPTIONS,
  }: {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContext;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: llm.ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): KuralleRuntimeLLMStream {
    return new KuralleRuntimeLLMStream(this, {
      chatCtx,
      connOptions,
      runtime: this.#runtime,
      sessionId: this.#sessionId,
      userId: this.#userId,
      onKuralleHandoff: this.#onKuralleHandoff,
      onMetrics: this.#onMetrics,
    });
  }
}

interface KuralleRuntimeLLMStreamOptions {
  chatCtx: llm.ChatContext;
  connOptions: APIConnectOptions;
  runtime: KuralleRuntimeBinding;
  sessionId: string;
  userId?: string;
  onKuralleHandoff?: (from: string, to: string) => void | Promise<void>;
  onMetrics?: VoiceMetricsSink;
}

export class KuralleRuntimeLLMStream extends llm.LLMStream {
  #opts: KuralleRuntimeLLMStreamOptions;

  constructor(parent: KuralleRuntimeLLMAdapter, opts: KuralleRuntimeLLMStreamOptions) {
    super(parent, {
      chatCtx: opts.chatCtx,
      connOptions: opts.connOptions,
    });
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    const input = extractRuntimeInput(this.chatCtx);
    if (!input) {
      console.warn(
        '[KuralleRuntimeLLMAdapter] No extractable input from ChatContext. ' +
        'The LLM stream will complete without emitting chunks.',
      );
      return;
    }

    const streamStartTime = performance.now();
    const metricsSink = this.#opts.onMetrics;
    const metricsSessionId = this.#opts.sessionId;

    const handle: TurnHandle = this.#opts.runtime.run({
      input,
      sessionId: this.#opts.sessionId,
      userId: this.#opts.userId,
      abortSignal: this.abortController.signal,
    });

    let chunkIndex = 0;
    let runtimeTtftRecorded = false;
    const canceledTurnIds = new Set<string>();

    const recordTtftOnce = () => {
      if (runtimeTtftRecorded || !metricsSink) return;
      runtimeTtftRecorded = true;
      emitKuralleMetric(metricsSink, {
        type: 'aria_runtime_ttft',
        sessionId: metricsSessionId,
        data: { ttftMs: Math.round(performance.now() - streamStartTime) },
      });
    };

    try {
      for await (const part of handle.events) {
        if (this.abortController.signal.aborted) {
          this.#opts.runtime.abortSession?.(this.#opts.sessionId, 'livekit-llm-abort');
          return;
        }

        if (part.type === 'handoff' && this.#opts.onKuralleHandoff) {
          try {
            await Promise.resolve(
              this.#opts.onKuralleHandoff(part.targetAgent, part.reason ?? part.targetAgent),
            );
          } catch (err) {
            console.error('[KuralleRuntimeLLMAdapter] onKuralleHandoff callback threw:', err instanceof Error ? err.message : String(err));
          }
          continue;
        }

        if (part.type === 'error') {
          throw new Error(part.error);
        }

        if (part.type === 'text-cancel') {
          canceledTurnIds.add(part.id);
          continue;
        }

        if (part.type === 'text-start' || part.type === 'text-end') {
          continue;
        }

        if (part.type !== 'text-delta') {
          continue;
        }

        if (canceledTurnIds.has(part.id)) {
          continue;
        }

        recordTtftOnce();
        this.queue.put({
          id: `kuralle-${chunkIndex++}`,
          delta: {
            role: 'assistant',
            content: part.delta,
          },
        });
      }
    } finally {
      if (this.abortController.signal.aborted) {
        this.#opts.runtime.abortSession?.(this.#opts.sessionId, 'livekit-llm-abort');
      }

      if (metricsSink) {
        emitKuralleMetric(metricsSink, {
          type: 'aria_runtime_end',
          sessionId: metricsSessionId,
          data: {
            durationMs: Math.round(performance.now() - streamStartTime),
            chunks: chunkIndex,
            aborted: this.abortController.signal.aborted,
          },
        });
      }
    }
  }
}

const LIVEKIT_INSTRUCTIONS_MESSAGE_ID = 'lk.agent_task.instructions';

function extractRuntimeInput(chatCtx: llm.ChatContext): string | null {
  return (
    extractLatestMessageByRole(chatCtx, 'user') ??
    extractLiveKitInstructionsMessage(chatCtx) ??
    extractLatestMessageByRole(chatCtx, 'system') ??
    extractLatestMessageByRole(chatCtx, 'developer')
  );
}

function isChatMessage(item: llm.ChatItem): item is llm.ChatMessage {
  return item != null && item.type === 'message';
}

function extractLiveKitInstructionsMessage(chatCtx: llm.ChatContext): string | null {
  for (let index = chatCtx.items.length - 1; index >= 0; index -= 1) {
    const item = chatCtx.items[index];
    if (!isChatMessage(item) || item.id !== LIVEKIT_INSTRUCTIONS_MESSAGE_ID) {
      continue;
    }

    const text = extractMessageText(item);
    if (text) {
      return text;
    }
  }

  return null;
}

function extractLatestMessageByRole(
  chatCtx: llm.ChatContext,
  role: 'user' | 'system' | 'developer',
): string | null {
  for (let index = chatCtx.items.length - 1; index >= 0; index -= 1) {
    const item = chatCtx.items[index];
    if (!isChatMessage(item) || item.role !== role) {
      continue;
    }

    const text = extractMessageText(item);
    if (text) {
      return text;
    }
  }

  return null;
}

function extractMessageText(item: llm.ChatMessage): string | null {
  // ChatMessage.textContent is a getter that joins string content parts.
  // Check it first for proper ChatMessage instances.
  const textContent = item.textContent;
  if (typeof textContent === 'string' && textContent.trim()) {
    return textContent.trim();
  }

  // Fallback: content is ChatContent[] (string | ImageContent | AudioContent).
  // The runtime value may also be a plain string when constructed from test
  // mocks or older SDK versions, so we read it as unknown first.
  const content: unknown = item.content;
  if (typeof content === 'string' && content.trim()) {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const text = (content as unknown[])
      .filter((part): part is string => typeof part === 'string')
      .join('')
      .trim();
    if (text) {
      return text;
    }
  }

  return null;
}
