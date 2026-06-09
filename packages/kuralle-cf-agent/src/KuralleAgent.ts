/**
 * KuralleAgent -- Kuralle on Cloudflare Durable Objects.
 *
 * Extends CF's AIChatAgent and works WITH it, not against it:
 *
 *   CF owns:      messages, persistence, WebSocket, resumability
 *   Kuralle owns: agent orchestration (current agent, working memory,
 *                  flow state, handoff history, extraction data)
 *
 * On each chat message:
 *   1. CF calls onChatMessage() with this.messages already populated
 *   2. We build a BridgeSessionStore from CF messages + orchestration state
 *   3. Kuralle Runtime runs the agent pipeline
 *   4. We return an SSE Response in AI SDK format
 *   5. CF's _reply() reads the SSE stream, builds message parts,
 *      calls persistMessages(), broadcasts to clients, handles resumability
 *
 * Kuralle's orchestration state (current agent, working memory, flow state)
 * is stored in a separate lightweight SQLite table via OrchestrationStore.
 */

import { AIChatAgent } from '@cloudflare/ai-chat';
import { createRuntime, isWakeJob, wakeJob, type HarnessConfig, type Runtime } from '@kuralle-agents/core';
import type {
  PersistentMemoryStore,
  UserInputContent,
  SignalDelivery,
  ScheduledJob,
  Scheduler,
  WakeJobPayload,
} from '@kuralle-agents/core';
import type { HarnessHooks, HarnessStreamPart } from '@kuralle-agents/core';
import type { StreamTextOnFinishCallback, ToolSet, UIMessage } from 'ai';
import type { OnChatMessageOptions } from '@cloudflare/ai-chat';
import { BridgeSessionStore } from './BridgeSessionStore.js';
import { OrchestrationStore } from './OrchestrationStore.js';
import { SqlPersistentMemoryStore } from './SqlPersistentMemoryStore.js';
import { createSSEResponse } from './StreamAdapter.js';
import type { StreamAdapterConfig, SqlExecutor } from './types.js';
import { DEFAULT_STREAM_CONFIG } from './types.js';
import { durableAgentSurface } from './durable-agent-surface.js';
import { lastUserInputFromMessages } from './cfMessageInput.js';

/**
 * Abstract base class for running Kuralle agents on Cloudflare.
 *
 * @example
 * ```typescript
 * import { KuralleAgent } from '@kuralle-agents/cf-agent';
 * import { openai } from '@ai-sdk/openai';
 *
 * class MyAgent extends KuralleAgent<Env> {
 *   protected getAgents(): HarnessConfig['agents'] {
 *     return [{
 *       id: 'assistant',
 *       name: 'Assistant',
 *       model: openai('gpt-4o', { apiKey: this.env.OPENAI_API_KEY }),
 *       instructions: 'You are a helpful assistant.',
 *     }];
 *   }
 *
 *   protected getDefaultAgentId() { return 'assistant'; }
 * }
 * ```
 */
export abstract class KuralleAgent<
  Env = unknown,
  State = unknown,
> extends AIChatAgent<Env, State> {
  private runtime: Runtime | null = null;

  /**
   * Required: Define the agents for this runtime.
   */
  protected abstract getAgents(): HarnessConfig['agents'];

  /**
   * Required: Which agent handles the first message.
   */
  protected abstract getDefaultAgentId(): string;

  /**
   * Optional: Additional runtime config (hooks, model, processors, etc.).
   * Merged with agents + defaultAgentId + sessionStore.
   */
  protected getRuntimeConfig(): Partial<HarnessConfig> {
    return {};
  }

  /**
   * Optional: Configure which Kuralle events become data parts in the stream.
   */
  protected getStreamConfig(): Partial<StreamAdapterConfig> {
    return {};
  }

  /**
   * Optional: durable working-memory blocks backed by DO SQLite.
   * When returned, wired into `HarnessConfig.defaultWorkingMemoryStore`.
   */
  protected getWorkingMemoryStore(): PersistentMemoryStore | undefined {
    return new SqlPersistentMemoryStore(this.getSql());
  }

  /**
   * Get the SQL executor for the Durable Object.
   * CF's AIChatAgent exposes this.sql as a tagged template function.
   */
  private getSql(): SqlExecutor {
    return durableAgentSurface<Env, State>(this).sql.bind(this);
  }

  /**
   * Get the Durable Object ID as the session identifier.
   */
  private getSessionId(): string {
    return durableAgentSurface<Env, State>(this).ctx.id.toString();
  }

  /**
   * The hex Durable Object id for this instance. Subclasses use it to mint
   * out-of-band callbacks (e.g. a payment link) that route back to this exact DO
   * via `namespace.idFromString(...)`, then resume it through `resumeWithSignal`.
   */
  protected getDurableObjectId(): string {
    return this.getSessionId();
  }

  /**
   * Called by CF when a chat message arrives.
   *
   * CF has already:
   *   1. Received the WebSocket message from the client
   *   2. Parsed and validated it
   *   3. Persisted the user message to cf_ai_chat_agent_messages
   *   4. Populated this.messages with the full conversation history
   *
   * We:
   *   1. Create a BridgeSessionStore (CF messages + orchestration state)
   *   2. Build and run Kuralle Runtime
   *   3. Return an SSE Response
   *
   * CF then:
   *   1. Reads the SSE stream via _reply()
   *   2. Builds assistant message parts via applyChunkToParts()
   *   3. Persists the assistant message
   *   4. Broadcasts to all connected clients
   *   5. Handles stream resumability
   */
  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions,
  ): Promise<Response> {
    // Extract the latest user input from CF's messages
    const lastUserMessage = this.getLastUserInput();
    if (!lastUserMessage) {
      return new Response('No user message', { status: 400 });
    }

    const sessionId = this.getSessionId();
    this.runtime = this.buildRuntime();

    const handle = this.runtime.run({
      input: lastUserMessage,
      sessionId,
      userId: (options?.body as { userId?: string } | undefined)?.userId,
      abortSignal: options?.abortSignal,
    });

    const streamConfig: StreamAdapterConfig = {
      ...DEFAULT_STREAM_CONFIG,
      ...this.getStreamConfig(),
    };

    async function* parts(): AsyncGenerator<HarnessStreamPart> {
      for await (const part of handle.events) {
        yield part;
      }
    }

    return createSSEResponse(parts(), streamConfig);
  }

  /**
   * Build a Kuralle runtime for this DO (fresh per request to pick up latest
   * config). Bridges CF messages + DO-backed orchestration/working-memory state.
   * Shared by the chat path and the durable resume path.
   */
  private buildRuntime(): Runtime {
    const sessionId = this.getSessionId();
    const defaultAgentId = this.getDefaultAgentId();
    const sessionStore = new BridgeSessionStore({
      sqlExecutor: this.getSql(),
      cfMessages: this.messages,
      sessionId,
      defaultAgentId,
    });
    const extraConfig = this.getRuntimeConfig();
    const workingMemoryStore = this.getWorkingMemoryStore();
    return createRuntime({
      ...extraConfig,
      agents: this.getAgents(),
      defaultAgentId,
      sessionStore,
      ...(workingMemoryStore && !extraConfig.defaultWorkingMemoryStore
        ? { defaultWorkingMemoryStore: workingMemoryStore }
        : {}),
    });
  }

  /**
   * Resume a suspended run by delivering a durable signal — the server-side
   * counterpart to a human/out-of-band event (e.g. a paid checkout link being
   * hit). Drives the resumed turn to completion, then persists **and broadcasts**
   * the resumed assistant reply through CF's machinery, so a live client sees it
   * and a reconnecting client replays it from history.
   *
   * Idempotent at the durable layer: delivering the same `signal.signalId` twice
   * is deduplicated by the effect log, so a double-clicked link is safe.
   *
   * @returns the assistant text produced by the resumed turn (may be empty).
   */
  protected async resumeWithSignal(signal: SignalDelivery): Promise<{ text: string }> {
    const sessionId = this.getSessionId();
    const runtime = this.buildRuntime();
    const handle = runtime.run({ sessionId, signalDelivery: signal });

    let text = '';
    for await (const part of handle.events) {
      if (part.type === 'text-delta') text += part.delta;
    }
    await handle;

    if (text.trim()) {
      const assistantMessage: UIMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        parts: [{ type: 'text', text }],
      };
      await this.persistMessages([...this.messages, assistantMessage]);
    }
    return { text };
  }

  /**
   * Extract the last user turn from CF's messages as runtime input (multimodal).
   * See `lastUserInputFromMessages`.
   */
  private getLastUserInput(): UserInputContent | null {
    return lastUserInputFromMessages(this.messages);
  }

  /**
   * Delete orchestration rows older than `maxAgeMs`. Returns the number of
   * rows removed.
   *
   * No automatic scheduling — callers opt in from their own `alarm()` or an
   * HTTP endpoint. This keeps retention policy explicit rather than hiding
   * it behind a probabilistic tick that could silently destroy state.
   *
   * Typical usage from a subclass `alarm()`:
   * ```ts
   * async alarm() {
   *   await this.cleanupOrchestrationRows(30 * 24 * 60 * 60 * 1000); // 30 days
   *   // ... other alarm work ...
   * }
   * ```
   */
  protected async cleanupOrchestrationRows(maxAgeMs: number): Promise<number> {
    const store = new OrchestrationStore(this.getSql());
    return store.cleanup(maxAgeMs);
  }

  /**
   * Durable scheduler backed by the agents SDK's DO-alarm scheduling
   * (`this.schedule`). Jobs survive isolate restarts and fire in this exact
   * DO via `runScheduledKuralleJob`. Satisfies the core `Scheduler` contract,
   * so engagement drips/broadcasts and runtime wake turns can share it.
   */
  protected wakeScheduler(): Scheduler {
    return {
      enqueue: async (job: ScheduledJob, opts?: { delayMs?: number }) => {
        const delaySeconds = Math.max(0, Math.ceil((opts?.delayMs ?? 0) / 1000));
        const schedule = await this.schedule(
          delaySeconds,
          'runScheduledKuralleJob' as keyof this,
          job,
        );
        return schedule.id;
      },
      cancel: async (jobId: string) => {
        await this.cancelSchedule(jobId);
      },
    };
  }

  /**
   * Schedule a proactive wake turn for this DO's conversation (cart
   * abandonment nudge, "check back in an hour", delivery follow-up).
   * Returns the schedule id (cancellable via `wakeScheduler().cancel`).
   */
  protected async scheduleWake(
    delayMs: number,
    wake: Omit<WakeJobPayload, 'sessionId'>,
  ): Promise<string> {
    return this.wakeScheduler().enqueue(
      wakeJob({ ...wake, sessionId: this.getSessionId() }),
      { delayMs },
    );
  }

  /**
   * DO-alarm callback for scheduled jobs. Wake jobs run an agent-initiated
   * turn and persist + broadcast the assistant reply through CF's machinery
   * (same path as `resumeWithSignal`); other job kinds go to
   * `onScheduledJob` for subclasses to handle.
   */
  async runScheduledKuralleJob(job: ScheduledJob): Promise<void> {
    if (!isWakeJob(job)) {
      await this.onScheduledJob(job);
      return;
    }

    const { reason, payload } = job.payload as unknown as WakeJobPayload;
    const runtime = this.buildRuntime();
    const handle = runtime.run({
      sessionId: this.getSessionId(),
      wake: { reason, payload },
    });

    let text = '';
    for await (const part of handle.events) {
      if (part.type === 'text-delta') text += part.delta;
    }
    await handle;

    if (text.trim()) {
      const assistantMessage: UIMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        parts: [{ type: 'text', text }],
      };
      await this.persistMessages([...this.messages, assistantMessage]);
    }
  }

  /**
   * Override to handle non-wake scheduled jobs (engagement drips, cleanup…).
   * Default: no-op with a warning, so a mis-routed job is visible.
   */
  protected async onScheduledJob(job: ScheduledJob): Promise<void> {
    console.warn(`[KuralleAgent] Unhandled scheduled job kind: ${job.kind}`);
  }

  /**
   * HTTP endpoint handler.
   * Adds Kuralle-specific endpoints on top of CF's defaults.
   */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Durable resume: deliver a signal to a suspended run (e.g. a paid checkout
    // link). Body: { signalId: string, name: string, payload?: unknown }.
    if (request.method === 'POST' && url.pathname.endsWith('/resume')) {
      const body = (await request.json().catch(() => null)) as SignalDelivery | null;
      if (!body || typeof body.signalId !== 'string' || typeof body.name !== 'string') {
        return Response.json({ error: 'signalId and name are required' }, { status: 400 });
      }
      const { text } = await this.resumeWithSignal(body);
      return Response.json({ ok: true, text });
    }

    if (url.pathname.endsWith('/orchestration-state')) {
      const store = new OrchestrationStore(this.getSql());
      // OrchestrationStore is now keyed by sessionId (was a single `'default'`
      // sentinel). For the chat path, sessionId === DO id; for voice each
      // call mints its own. `?id=<sessionId>` query param lets callers query
      // a specific call's orchestration.
      const queryId = url.searchParams.get('id');
      const id = queryId || this.getSessionId();
      const state = await store.get(id);
      return Response.json({
        sessionId: id,
        state: state ?? null,
      });
    }

    return super.onRequest(request);
  }
}
