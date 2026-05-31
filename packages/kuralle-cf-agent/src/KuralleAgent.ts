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
import { createRuntime, type HarnessConfig, type Runtime } from '@kuralle-agents/core';
import type { HarnessHooks, HarnessStreamPart } from '@kuralle-agents/core';
import type { StreamTextOnFinishCallback, ToolSet, UIMessage } from 'ai';
import type { OnChatMessageOptions } from '@cloudflare/ai-chat';
import { BridgeSessionStore } from './BridgeSessionStore.js';
import { OrchestrationStore } from './OrchestrationStore.js';
import { createSSEResponse } from './StreamAdapter.js';
import type { StreamAdapterConfig, SqlExecutor } from './types.js';
import { DEFAULT_STREAM_CONFIG } from './types.js';
import { durableAgentSurface } from './durable-agent-surface.js';

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
    const defaultAgentId = this.getDefaultAgentId();

    // Build session store that bridges CF messages with Kuralle state
    const sessionStore = new BridgeSessionStore({
      sqlExecutor: this.getSql(),
      cfMessages: this.messages,
      sessionId,
      defaultAgentId,
    });

    // Build runtime (fresh per request to pick up latest config)
    const extraConfig = this.getRuntimeConfig();
    this.runtime = createRuntime({
      ...extraConfig,
      agents: this.getAgents(),
      defaultAgentId,
      sessionStore,
    });

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
   * Extract the text content of the last user message from CF's messages array.
   */
  private getLastUserInput(): string | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role !== 'user') continue;

      const text = msg.parts
        ?.filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('');

      if (text?.trim()) return text;
    }
    return null;
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
   * HTTP endpoint handler.
   * Adds Kuralle-specific endpoints on top of CF's defaults.
   */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

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
