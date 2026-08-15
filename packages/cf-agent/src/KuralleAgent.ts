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
import {
  createRuntime,
  isWakeJob,
  isSweepJob,
  sweepJob,
  recoverOrphanedRuns,
  sweepDeadlines,
  DEFAULT_SWEEP_INTERVAL_MS,
  wakeJob,
  type DeploymentTraceContext,
  type FlowDefinitionsStore,
  type HarnessConfig,
  type Policy,
  type Runtime,
} from '@kuralle-agents/core';
import type {
  HitlInterrupt,
  InterruptRequest,
  PersistentMemoryStore,
  UserInputContent,
  SignalActor,
  SignalDelivery,
  ScheduledJob,
  Scheduler,
  WakeJobPayload,
} from '@kuralle-agents/core';
import type { StreamPart } from '@kuralle-agents/core';
import { harnessToUIMessageStream } from '@kuralle-agents/core';
import type { StreamTextOnFinishCallback, ToolSet, UIMessage } from 'ai';
import type { OnChatMessageOptions } from '@cloudflare/ai-chat';
import { BridgeSessionStore } from './BridgeSessionStore.js';
import { OrchestrationStore } from './OrchestrationStore.js';
import { SqlPersistentMemoryStore } from './SqlPersistentMemoryStore.js';
import { SqlRunStore } from './SqlRunStore.js';
import { createUIMessageStreamResponse } from 'ai';
import type { DurableSqlStorage, SqlExecutor } from './types.js';
import { durableAgentSurface } from './durable-agent-surface.js';
import { lastUserInputFromMessages } from './cfMessageInput.js';
import { SqlFlowDefinitionsStore } from './SqlFlowDefinitionsStore.js';
import { dispatchStoredFlowsRequest } from './storedFlowsHttp.js';

export interface ResolvedRuntimeDefinition {
  agents: HarnessConfig['agents'];
  defaultAgentId: string;
  config?: Partial<HarnessConfig>;
  deployment?: DeploymentTraceContext;
}

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
  /** Last approval surfaced by the completion-oriented HTTP chat facade. */
  private lastHttpInterrupt: HitlInterrupt | undefined;

  private ensureHttpInterruptTable(): void {
    this.getSql()`CREATE TABLE IF NOT EXISTS kuralle_http_interrupts (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`;
  }

  private recordHttpInterrupt(interrupt: HitlInterrupt): void {
    this.lastHttpInterrupt = interrupt;
    this.ensureHttpInterruptTable();
    this.getSql()`INSERT INTO kuralle_http_interrupts (id, payload, updated_at)
      VALUES (${'pending'}, ${JSON.stringify(interrupt)}, ${Date.now()})
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`;
  }

  private getHttpInterrupt(): HitlInterrupt | undefined {
    if (this.lastHttpInterrupt) return this.lastHttpInterrupt;
    this.ensureHttpInterruptTable();
    const row = this.getSql()<{ payload: string }>`SELECT payload FROM kuralle_http_interrupts
      WHERE id = ${'pending'} LIMIT 1`[0];
    if (!row) return undefined;
    try {
      return JSON.parse(row.payload) as HitlInterrupt;
    } catch {
      this.clearHttpInterrupt();
      return undefined;
    }
  }

  private async resolvePendingApproval(): Promise<HitlInterrupt | undefined> {
    const journaled = this.getHttpInterrupt();
    if (journaled) return journaled;

    // The Agents SDK may consume the SSE stream in a separate internal request,
    // so an instance field is not a reliable hand-off to the completion-oriented
    // HTTP facade. The durable run journal is authoritative across that boundary.
    const sessionId = this.getSessionId();
    const runStore = await this.durableRunStore();
    let waiting: InterruptRequest | undefined;
    for await (const ref of runStore.listRuns({ status: 'paused' })) {
      if (ref.waitingFor?.kind === 'approval') {
        waiting = ref.waitingFor;
        break;
      }
    }
    if (!waiting) {
      const state = await new OrchestrationStore(this.getSql()).get(sessionId);
      const run = state?.durableRuns?.[sessionId]?.runState
        ?? Object.values(state?.durableRuns ?? {}).find((candidate) => candidate.runState.status === 'paused')?.runState;
      waiting = run?.status === 'paused' ? run.waitingFor : undefined;
    }
    if (!waiting || waiting.kind !== 'approval') return undefined;

    const interrupt: HitlInterrupt = {
      requestId: waiting.requestId,
      kind: waiting.kind,
      signalName: waiting.signalName,
      ...(waiting.operation ? {
        operation: {
          toolCallId: waiting.operation.toolCallId,
          toolName: waiting.operation.toolName,
          args: waiting.operation.args,
          argsHash: waiting.operation.argsHash,
        },
      } : {}),
      display: waiting.display,
      responseSchema: waiting.responseSchema,
      deadline: waiting.deadline,
      allowedDecisions: waiting.allowedDecisions,
      createdAt: waiting.createdAt,
    };
    this.recordHttpInterrupt(interrupt);
    return interrupt;
  }

  private clearHttpInterrupt(): void {
    this.lastHttpInterrupt = undefined;
    this.ensureHttpInterruptTable();
    this.getSql()`DELETE FROM kuralle_http_interrupts WHERE id = ${'pending'}`;
  }

  /**
   * Required: Define the agents for this runtime.
   */
  protected abstract getAgents(): HarnessConfig['agents'];

  /**
   * Required: Which agent handles the first message.
   */
  protected abstract getDefaultAgentId(): string;

  /** Async seam used by revision-pinned production hosts. */
  protected async resolveRuntimeDefinition(): Promise<ResolvedRuntimeDefinition> {
    return {
      agents: this.getAgents(),
      defaultAgentId: this.getDefaultAgentId(),
    };
  }

  /**
   * Optional: Additional runtime config (hooks, model, processors, etc.).
   * Merged with agents + defaultAgentId + sessionStore.
   */
  protected getRuntimeConfig(): Partial<HarnessConfig> {
    return {};
  }

  /**
   * Policy for `GET/POST/DELETE /api/stored/flows`. Decisions are requested as
   * `stored-flows:read` and `stored-flows:write`.
   *
   * Omitted: default-allow, matching the authless hono-server dev router.
   * Production DOs must override this. `authorId` on the request is metadata,
   * never a grant. `ask` is treated as deny — this surface has no HITL path.
   */
  protected getStoredFlowsPolicy(): Policy | undefined {
    return undefined;
  }

  /**
   * Called after a successful stored-flows POST or DELETE. Thread agents bump
   * the pin-key cache generation so the next turn re-binds.
   */
  protected onStoredFlowsMutated(): void {}

  protected getFlowDefinitionsStore(): FlowDefinitionsStore {
    return new SqlFlowDefinitionsStore(this.getSql());
  }

  /**
   * Optional: durable working-memory blocks backed by DO SQLite.
   * When returned, wired into `HarnessConfig.defaultWorkingMemoryStore`.
   */
  protected getWorkingMemoryStore(): PersistentMemoryStore | undefined {
    return new SqlPersistentMemoryStore(this.getSql());
  }

  /**
   * Who a `/resume` decision is attributed to in the durable audit log.
   *
   * Derive this from your own authentication — a signed header, a session lookup, Access
   * JWT claims. It deliberately does NOT read the request body: a client that could name
   * its own actor could approve as anyone.
   *
   * Left unimplemented, decisions are attributed to the service itself
   * (`cloudflare-resume`) — honest, but the audit log cannot then say which human decided.
   */
  protected async resolveSignalActor(_request: Request): Promise<SignalActor | undefined> {
    return undefined;
  }

  private async durableRunStore(): Promise<SqlRunStore> {
    const sql = this.getSql();
    const store = new SqlRunStore(sql);
    const orch = await new OrchestrationStore(sql).get(this.getSessionId());
    if (orch?.durableRuns) {
      await store.importLegacyRuns(orch.durableRuns);
    }
    return store;
  }

  private getSql(): SqlExecutor {
    return durableAgentSurface<Env, State>(this).sql.bind(this);
  }

  /**
   * The DO's SQL executor, for subclasses that need to read/write Kuralle session
   * state out-of-band (e.g. a payment-confirmation webhook handler that runs
   * outside a chat turn). Pair with `BridgeSessionStore` + `getDurableObjectId()`.
   */
  protected getSqlExecutor(): SqlExecutor {
    return this.getSql();
  }

  /**
   * The native Durable Object SQLite handle. Pass this directly to
   * `sqlFileSystem()` to give each agent instance a durable workspace without
   * reaching through undocumented Agents SDK internals in application code.
   */
  protected getSqlStorage(): DurableSqlStorage {
    return durableAgentSurface<Env, State>(this).ctx.storage.sql;
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
    const built = await this.buildRuntime();
    this.runtime = built.runtime;

    const handle = this.runtime.run({
      input: lastUserMessage,
      sessionId,
      userId: (options?.body as { userId?: string } | undefined)?.userId,
      abortSignal: options?.abortSignal,
      deployment: built.deployment,
    });

    const owner = this;
    async function* parts(): AsyncGenerator<StreamPart> {
      for await (const part of handle.events) {
        if (part.type === 'paused' && part.payload.interrupt.kind === 'approval') {
          owner.recordHttpInterrupt(part.payload.interrupt);
        }
        yield part;
      }
    }

    // One mapping, owned by core. Cloudflare's AIChatAgent parser tolerates the
    // full format — `text-*` frames resolve by type and ignore `id`, `data-*` is
    // handled generically, and unrecognised frames are skipped — so there is no
    // format to adapt around, only a second implementation to delete.
    return createUIMessageStreamResponse({
      stream: harnessToUIMessageStream(parts(), { sessionId }),
    });
  }

  /**
   * Build a Kuralle runtime for this DO. Revision-pinned subclasses resolve the
   * same immutable definition on every request; source-defined subclasses may
   * return their current deployed definition. Bridges CF messages + durable state.
   * Shared by the chat path and the durable resume path.
   */
  private async buildRuntime(): Promise<{ runtime: Runtime; deployment?: DeploymentTraceContext }> {
    const sessionId = this.getSessionId();
    const definition = await this.resolveRuntimeDefinition();
    const defaultAgentId = definition.defaultAgentId;
    const sessionStore = new BridgeSessionStore({
      sqlExecutor: this.getSql(),
      cfMessages: this.messages,
      sessionId,
      defaultAgentId,
    });
    const extraConfig = this.getRuntimeConfig();
    const runtimeConfig = { ...extraConfig, ...definition.config };
    const workingMemoryStore = this.getWorkingMemoryStore();
    const runStore = runtimeConfig.runStore ?? await this.durableRunStore();
    const flowDefinitionsStore =
      runtimeConfig.flowDefinitionsStore ?? this.getFlowDefinitionsStore();
    const runtime = createRuntime({
      ...runtimeConfig,
      agents: definition.agents,
      defaultAgentId,
      sessionStore,
      runStore,
      flowDefinitionsStore,
      ...(workingMemoryStore && !runtimeConfig.defaultWorkingMemoryStore
        ? { defaultWorkingMemoryStore: workingMemoryStore }
        : {}),
    });
    await runtime.loadDynamicFlows({ agentId: defaultAgentId });
    return {
      runtime,
      deployment: definition.deployment,
    };
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
    const built = await this.buildRuntime();
    const handle = built.runtime.run({
      sessionId,
      signalDelivery: signal,
      deployment: built.deployment,
    });

    let text = '';
    for await (const part of handle.events) {
      if (part.type === 'text-delta') text += part.payload.delta;
    }
    const result = await handle;
    // Resumed drivers may return final text without replaying it as deltas.
    // Prefer streamed text when present, otherwise preserve the authoritative
    // TurnResult so HTTP and reconnecting chat clients do not receive silence.
    if (!text.trim()) text = result.text;
    this.clearHttpInterrupt();

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
    const built = await this.buildRuntime();
    const handle = built.runtime.run({
      sessionId: this.getSessionId(),
      wake: { reason, payload },
      deployment: built.deployment,
    });

    let text = '';
    for await (const part of handle.events) {
      if (part.type === 'text-delta') text += part.payload.delta;
    }
    const result = await handle;
    if (!text.trim()) text = result.text;

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
   * Enqueue the first store-sweep tick on this DO's alarm scheduler.
   * Exactly one sweeper per store — this DO's SqlRunStore is that store.
   */
  protected async startRunSweeper(intervalMs = DEFAULT_SWEEP_INTERVAL_MS): Promise<string> {
    return this.wakeScheduler().enqueue(sweepJob({ intervalMs }), { delayMs: intervalMs });
  }

  /**
   * Override to handle non-wake scheduled jobs (engagement drips, cleanup…).
   * Sweep jobs run both `recoverOrphanedRuns` and `sweepDeadlines`, then
   * re-enqueue at the job's interval. Default for other kinds: no-op with a
   * warning, so a mis-routed job is visible.
   */
  protected async onScheduledJob(job: ScheduledJob): Promise<void> {
    if (isSweepJob(job)) {
      const built = await this.buildRuntime();
      await recoverOrphanedRuns(built.runtime);
      await sweepDeadlines(built.runtime);
      const intervalMs =
        typeof job.payload.intervalMs === 'number' && job.payload.intervalMs > 0
          ? job.payload.intervalMs
          : DEFAULT_SWEEP_INTERVAL_MS;
      await this.wakeScheduler().enqueue(sweepJob({ intervalMs }), { delayMs: intervalMs });
      return;
    }
    console.warn(`[KuralleAgent] Unhandled scheduled job kind: ${job.kind}`);
  }

  /**
   * HTTP endpoint handler.
   * Adds Kuralle-specific endpoints on top of CF's defaults.
   */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    const storedFlows = await dispatchStoredFlowsRequest({
      request,
      store: this.getFlowDefinitionsStore(),
      runtimeForWrite: async () => {
        const built = await this.buildRuntime();
        return { runtime: built.runtime, agentId: built.runtime.getDefaultAgentId() };
      },
      storedFlowsPolicy: this.getStoredFlowsPolicy(),
      onMutated: () => this.onStoredFlowsMutated(),
    });
    if (storedFlows) return storedFlows;

    // HTTP counterpart to the native Agents WebSocket chat protocol. This is
    // intentionally completion-oriented JSON: browser clients should use
    // useAgentChat for resumable streams, while CLIs, webhooks, and server-side
    // Next.js routes can take a durable turn without implementing the WS wire format.
    if (request.method === 'POST' && url.pathname.endsWith('/chat')) {
      const body = (await request.json().catch(() => null)) as { message?: unknown } | null;
      if (!body || typeof body.message !== 'string' || !body.message.trim()) {
        return Response.json({ error: 'message is required' }, { status: 400 });
      }
      if (body.message.length > 64_000) {
        return Response.json({ error: 'message exceeds 64000 characters' }, { status: 413 });
      }

      const outstandingApproval = await this.resolvePendingApproval();
      if (outstandingApproval) {
        return Response.json({
          sessionId: this.getSessionId(),
          response: '',
          status: 'approval-required',
          messageCount: this.messages.length,
          pendingApproval: {
            requestId: outstandingApproval.requestId,
            title: outstandingApproval.display.title,
            description: outstandingApproval.display.description,
          },
        });
      }

      const userMessage: UIMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        parts: [{ type: 'text', text: body.message.trim() }],
      };
      const previousAssistantId = [...this.messages]
        .reverse()
        .find((message) => message.role === 'assistant')?.id;
      this.lastHttpInterrupt = undefined;
      const result = await this.saveMessages((messages) => [...messages, userMessage]);
      const pendingApproval = await this.resolvePendingApproval();
      const assistant = [...this.messages]
        .reverse()
        .find((message) => message.role === 'assistant' && message.id !== previousAssistantId);
      const text = assistant?.parts
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('') ?? '';

      return Response.json({
        sessionId: this.getSessionId(),
        response: text,
        status: pendingApproval ? 'approval-required' : result.status,
        requestId: result.requestId,
        messageCount: this.messages.length,
        ...(pendingApproval ? {
          pendingApproval: {
            requestId: pendingApproval.requestId,
            title: pendingApproval.display.title,
            description: pendingApproval.display.description,
          },
        } : {}),
        ...(result.error ? { error: result.error } : {}),
      }, { status: result.status === 'error' ? 502 : 200 });
    }

    // Durable resume: deliver a signal to a suspended run (e.g. a paid checkout
    // link). Body: { signalId, requestId, name, decision?, reason?, payload? }.
    if (request.method === 'POST' && url.pathname.endsWith('/resume')) {
      const body = (await request.json().catch(() => null)) as SignalDelivery | null;
      if (
        !body ||
        typeof body.signalId !== 'string' ||
        typeof body.requestId !== 'string' ||
        typeof body.name !== 'string'
      ) {
        return Response.json(
          { error: 'signalId, requestId, and name are required' },
          { status: 400 },
        );
      }
      if (body.name === '__approval' || body.decision !== undefined) {
        const pendingApproval = await this.resolvePendingApproval();
        if (!pendingApproval) {
          return Response.json(
            { error: 'No approval is pending for this session.' },
            { status: 409 },
          );
        }
        if (body.requestId !== pendingApproval.requestId) {
          return Response.json(
            { error: 'requestId does not match the pending approval.' },
            { status: 409 },
          );
        }
      }
      // Never from the body — a client that names its own actor can approve as anyone.
      // Override `resolveSignalActor` to attribute a decision to the real human.
      const { text } = await this.resumeWithSignal({
        ...body,
        actor: (await this.resolveSignalActor(request)) ?? {
          id: 'cloudflare-resume',
          type: 'service',
        },
      });
      // Keep `text` for existing callers and mirror the completion-oriented
      // `/chat` shape so generic HTTP clients can render either endpoint.
      return Response.json({ ok: true, text, response: text, status: 'completed' });
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
