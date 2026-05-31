/**
 * withRealtimeVoice — functional mixin adding realtime voice to an
 * AIChatAgent-derived Durable Object class.
 *
 * Realtime voice convergence: this mixin is now pure transport glue. All
 * orchestration — tool dispatch, flow transitions, hooks, handoffs, session
 * persistence, reconnect strategy, chat_ctx replay — lives in Kuralle's
 * `Runtime` and `CloudflareRealtimeAdapter`.
 *
 * Responsibilities that stay in the mixin:
 *   - Intercept voice-protocol frames on the browser ↔ DO WebSocket.
 *   - Per-connection concurrent-session cap (`maxConcurrentSessions`).
 *   - DO-specific lifecycle (`keepAlive()` during an active call).
 *   - Expose subclass-override hooks (`beforeSessionStart`, `onSessionStart`,
 *     `onSessionEnd`, `onInterrupt`, `onUserTranscript`, `onModelTranscript`).
 *   - Build the `Runtime` per call (via `createRuntime(...)`),
 *     wire in a `BridgeSessionStore`, and hand control to the adapter.
 *
 * Responsibilities moved OUT of the mixin:
 *   - Tool execution              → the `Runtime` effect path (`ctx.tool`)
 *   - Flow reconfigure / handoff  → same, via the runtime's transition handling
 *   - Transcript persistence      → the `Runtime` session + event log +
 *                                   existing `AIChatAgent.persistMessages`
 *   - Resumption handle + chat_ctx replay → provider client (in-memory) +
 *                                           adapter (reconnect dispatch)
 *   - SQLite tables `cf_realtime_resumption` and `cf_realtime_chat_ctx`
 *     — DELETED. Storage flows through `SessionStore` (BridgeSessionStore on CF).
 *
 * Capture-and-patch lifecycle wrap mirrors `@cloudflare/voice`'s pattern
 * (voice.ts:251-334, MIT, © 2025 Cloudflare, Inc.).
 */

import type { Connection, WSMessage } from "agents";
import type { RealtimeAudioClient } from "@kuralle-agents/core/realtime";
import { createRuntime, type AgentConfig } from "@kuralle-agents/core";
import { VOICE_PROTOCOL_VERSION } from "@kuralle-agents/voice-protocol";
import {
  CloudflareRealtimeAdapter,
  type CloudflareRealtimeModelPolicy,
} from "@kuralle-agents/realtime-audio";
import {
  AudioConnectionManager,
  sendVoiceJSON,
} from "./AudioConnectionManager.js";
import { BridgeSessionStore } from "../BridgeSessionStore.js";
import type { SqlExecutor } from "../types.js";
import {
  durableAgentSurface,
  type DurableObjectAgentSurface,
} from "../durable-agent-surface.js";

type Constructor<T = object> = new (...args: unknown[]) => T;
type AbstractConstructor<T = object> = abstract new (...args: unknown[]) => T;
type AgentLike = Constructor | AbstractConstructor;

/** DO host surface accessed by the realtime voice mixin. */
interface RealtimeVoiceHost<Env = unknown, State = unknown>
  extends DurableObjectAgentSurface<Env, State> {}

interface VoiceResumptionState {
  voiceResumption?: { handle: string; provider: string; issuedAt: number };
}

function voiceHost<Env, State>(self: object): RealtimeVoiceHost<Env, State> {
  return durableAgentSurface<Env, State>(self);
}

function resolveSql(self: object): SqlExecutor | undefined {
  const { sql } = durableAgentSurface(self);
  if (typeof sql !== "function") return undefined;
  return sql.bind(self);
}

export interface RealtimeVoiceOptions {
  /** Audio wire format. Fixed to PCM16 today; future provider-specific variants. */
  audioFormat?: "pcm16";
  /** Per-DO concurrent-session cap. 5th `start_call` rejected with an `error` frame. Default 4. */
  maxConcurrentSessions?: number;
  /** Max outbound-reconnect attempts under backoff before giving up. Default 3. */
  reconnectMaxAttempts?: number;
  /** Base delay for backoff (delay ∈ [0, min(cap, base * 2^attempt)]). Default 500ms. */
  reconnectBaseDelayMs?: number;
  /** Cap on the backoff delay. Default 8000ms. */
  reconnectCapDelayMs?: number;
  /** Bytes of PCM to ring-buffer per-connection across a reconnect window. Default 48_000. */
  reconnectAudioBufferBytes?: number;
}

export interface RealtimeVoiceMixinMembers {
  realtimeModel?: RealtimeAudioClient;
  createRealtimeModel?(env: unknown): RealtimeAudioClient;
  beforeSessionStart(conn: Connection): boolean | Promise<boolean>;
  onSessionStart(conn: Connection): void | Promise<void>;
  onSessionEnd(conn: Connection): void | Promise<void>;
  onInterrupt(conn: Connection): void | Promise<void>;
  onUserTranscript(text: string, isFinal: boolean, conn: Connection): void | Promise<void>;
  onModelTranscript(text: string, isFinal: boolean, conn: Connection): void | Promise<void>;
  forceEndSession(conn: Connection): void;
}

function inferModelPolicy(client: RealtimeAudioClient): CloudflareRealtimeModelPolicy {
  const provider = (client.provider ?? "unknown").toLowerCase();
  const supportsInstructionUpdate =
    client.capabilities?.midSessionInstructionsUpdate === true ||
    client.capabilities?.midSessionChatCtxUpdate === true;
  if (provider.startsWith("gemini") || provider.startsWith("google")) {
    return { provider: "google", supportsInstructionUpdate };
  }
  if (provider.startsWith("openai")) {
    return { provider: "openai", supportsInstructionUpdate };
  }
  if (provider.startsWith("azure")) {
    return { provider: "azure-openai", supportsInstructionUpdate };
  }
  if (provider.startsWith("xai")) {
    return { provider: "xai", supportsInstructionUpdate };
  }
  if (provider.startsWith("phonic")) {
    return { provider: "phonic", supportsInstructionUpdate };
  }
  if (provider.startsWith("workers")) {
    return { provider: "workers-ai", supportsInstructionUpdate };
  }
  return { provider: "unknown", supportsInstructionUpdate };
}

export function withRealtimeVoice<TBase extends AgentLike>(
  Base: TBase,
  opts: RealtimeVoiceOptions = {},
): TBase & Constructor<RealtimeVoiceMixinMembers> {
  const maxConcurrent = opts.maxConcurrentSessions ?? 4;
  const reconnectMaxAttempts = opts.reconnectMaxAttempts ?? 3;
  const reconnectBaseDelayMs = opts.reconnectBaseDelayMs ?? 500;
  const reconnectCapDelayMs = opts.reconnectCapDelayMs ?? 8000;
  const reconnectAudioBufferBytes = opts.reconnectAudioBufferBytes ?? 48_000;

  class RealtimeVoiceMixin extends Base implements RealtimeVoiceMixinMembers {
    realtimeModel?: RealtimeAudioClient;
    createRealtimeModel?(_env: unknown): RealtimeAudioClient {
      throw new Error(
        "Subclass must override createRealtimeModel or set realtimeModel.",
      );
    }

    #cm = new AudioConnectionManager();
    #adapters = new Map<string, CloudflareRealtimeAdapter>();
    #agents = new Map<string, AgentConfig>();
    #keepAlive = new Map<string, () => void>();
    #starting = new Set<string>();
    /** One-shot guard: emit `session_lost` at most once per conn. */
    #sessionLossSignalled = new Set<string>();
    /** Warn once per instance when host lacks `keepAlive()` — calls will die at 70-140s idle. */
    #keepAliveWarned = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reason: TypeScript TS2545 mixin constructors require `any[]` rest params
    constructor(...args: any[]) {
      super(...args);

      const host = voiceHost(this);
      const _onConnect = host.onConnect?.bind(this);
      const _onClose = host.onClose?.bind(this);
      const _onMessage = host.onMessage?.bind(this);

      host.onConnect = (c: Connection, ...rest: unknown[]) => {
        sendVoiceJSON(c, { type: "welcome", protocol_version: VOICE_PROTOCOL_VERSION });
        sendVoiceJSON(c, { type: "status", status: "idle" });
        return _onConnect?.(c, ...rest);
      };

      host.onClose = (c: Connection, ...rest: unknown[]) => {
        void this.#teardown(c);
        return _onClose?.(c, ...rest);
      };

      host.onMessage = (c: Connection, m: WSMessage) => {
        if (m instanceof ArrayBuffer) {
          const frame = new Uint8Array(m);
          const adapter = this.#adapters.get(c.id);
          if (adapter) {
            adapter.sendUserAudio(frame);
            return;
          }
          // No adapter for this conn. Three plausible causes:
          //   1. Mid-call DO eviction — isolate died, `#adapters` wiped, client
          //      WS re-hydrated by hibernation, audio now lands on a fresh
          //      mixin with no session to forward to.
          //   2. Teardown race — client sent last 20ms of audio after
          //      `end_call`. `@cloudflare/voice` stops streaming on end so
          //      this is near-zero in practice.
          //   3. Buggy client streaming pre-`start_call`.
          // In all three cases, silently dropping audio is worse than
          // signalling. Emit once + close so partysocket reconnects cleanly
          // and the user can restart.
          if (this.#starting.has(c.id)) return;
          if (this.#sessionLossSignalled.has(c.id)) return;
          this.#sessionLossSignalled.add(c.id);
          sendVoiceJSON(c, {
            type: "error",
            code: "session_lost",
            message:
              "Voice session lost (server restart, eviction, or no active call). " +
              "Please start a new call.",
          });
          try {
            c.close(1011, "session_lost");
          } catch {
            /* connection already closing */
          }
          return;
        }
        if (typeof m !== "string") return _onMessage?.(c, m);

        let parsed: { type: string; [k: string]: unknown };
        try {
          parsed = JSON.parse(m);
        } catch {
          return _onMessage?.(c, m);
        }

        switch (parsed.type) {
          case "start_call":
            this.#handleStartCall(c).catch((err) => {
              console.error(
                "[withRealtimeVoice] #handleStartCall REJECTED:",
                String(err),
                err instanceof Error ? err.stack : "",
              );
              const raw = err instanceof Error ? err.message : String(err);
              sendVoiceJSON(c, { type: "error", message: `start_call failed: ${raw}` });
            });
            return;
          case "end_call":
            void this.#teardown(c);
            return;
          case "interrupt":
            void this.#handleInterrupt(c);
            return;
          case "text_message": {
            const text = typeof parsed.text === "string" ? parsed.text : undefined;
            if (text) this.#adapters.get(c.id)?.sendUserText(text);
            return;
          }
          case "start_of_speech":
          case "end_of_speech":
          case "hello":
            return; // acknowledge but no-op
          default:
            return _onMessage?.(c, m);
        }
      };
    }

    // ─── Hook defaults (overridable by subclasses) ──────────────────────────
    async beforeSessionStart(_c: Connection): Promise<boolean> {
      return true;
    }
    async onSessionStart(_c: Connection): Promise<void> {}
    async onSessionEnd(_c: Connection): Promise<void> {}
    async onInterrupt(_c: Connection): Promise<void> {}
    async onUserTranscript(_t: string, _f: boolean, _c: Connection): Promise<void> {}
    async onModelTranscript(_t: string, _f: boolean, _c: Connection): Promise<void> {}

    /** Imperative end-session helper for subclasses (e.g. timeout, moderation). */
    forceEndSession(c: Connection): void {
      void this.#teardown(c);
    }

    // ─── Internals ───────────────────────────────────────────────────────────

    #resolveModel(): RealtimeAudioClient {
      if (this.realtimeModel) return this.realtimeModel;
      if (this.createRealtimeModel) {
        const { env } = voiceHost(this);
        return this.createRealtimeModel(env);
      }
      throw new Error(
        "withRealtimeVoice: subclass must provide `realtimeModel` or override `createRealtimeModel(env)`.",
      );
    }

    #resolveDefaultAgent(): AgentConfig {
      const host = voiceHost(this);
      const agents: AgentConfig[] = host.getAgents?.() ?? [];
      const defaultId: string = host.getDefaultAgentId?.() ?? agents[0]?.id;
      const agent = agents.find((a) => a.id === defaultId) ?? agents[0];
      if (!agent) {
        throw new Error(
          "withRealtimeVoice: subclass must implement getAgents()/getDefaultAgentId() returning at least one agent.",
        );
      }
      return agent;
    }

    #buildRuntime(sessionId: string) {
      const host = voiceHost(this);
      const defaultAgentId = host.getDefaultAgentId?.() ?? "";
      const extra = host.getRuntimeConfig?.() ?? {};
      const agents = host.getAgents?.() ?? [];
      const sql = resolveSql(this);
      // BridgeSessionStore is the CF-native SessionStore — messages live in
      // AIChatAgent's `cf_ai_chat_agent_messages`, orchestration state in the
      // `kuralle_orchestration` row. No voice-specific tables.
      const sessionStore = sql
        ? new BridgeSessionStore({
            sqlExecutor: sql,
            cfMessages: host.messages ?? [],
            sessionId,
            defaultAgentId,
          })
        : undefined;
      return createRuntime({
        ...extra,
        agents,
        defaultAgentId,
        sessionStore,
      });
    }

    /**
     * Generate a **call-scoped** session id. Each `start_call` gets its own
     * UUID so orchestration state (currentAgent, flow node, handoffHistory)
     * is isolated per call — the 2nd call doesn't inherit the 1st call's
     * flow-node position. DO-scoped state that survives across calls
     * (Gemini resumption handle, long-term memory) belongs in `this.state`.
     *
     * Prior version returned `ctx.id.toString()` which collapsed every
     * call in a DO into one orchestration row — fine for demo but wrong
     * for any agent with flow transitions.
     */
    #mintCallId(): string {
      return crypto.randomUUID();
    }

    /** DO-stable identity, distinct from per-call session id. */
    #getDoId(): string {
      const id = voiceHost(this).ctx?.id;
      return id?.toString?.() ?? "unknown-do";
    }

    /**
     * Read a previously-captured provider resumption handle from DO-scoped
     * `this.state`. Returns undefined if missing, from a different provider,
     * or older than the provider's TTL (Gemini: 2h). DO-scoped means
     * `hibernate: true` + fresh wake + new call will still see it.
     */
    #readDoResumption(provider: string): string | undefined {
      const state = (voiceHost(this).state ?? {}) as VoiceResumptionState;
      const r = state.voiceResumption;
      if (!r || r.provider !== provider) return undefined;
      const TWO_HOURS = 2 * 60 * 60 * 1000;
      if (Date.now() - r.issuedAt > TWO_HOURS) return undefined;
      return r.handle;
    }

    #writeDoResumption(handle: string, provider: string): void {
      const host = voiceHost(this);
      if (typeof host.setState !== 'function') return;
      const prev = (host.state ?? {}) as Record<string, unknown>;
      host.setState({
        ...prev,
        voiceResumption: { handle, provider, issuedAt: Date.now() },
      } as typeof host.state);
    }

    async #handleStartCall(conn: Connection): Promise<void> {
      if (this.#adapters.has(conn.id) || this.#starting.has(conn.id)) {
        // Duplicate start_call on the same connection — ignore.
        return;
      }
      // Count in-flight starts toward the cap — otherwise concurrent start_call
      // frames from N distinct connections can all read size=0 before any has
      // populated the adapter map, over-subscribing the DO.
      if (this.#adapters.size + this.#starting.size >= maxConcurrent) {
        sendVoiceJSON(conn, {
          type: "error",
          code: "session_cap_exceeded",
          message: `Max concurrent realtime sessions (${maxConcurrent}) reached.`,
        });
        return;
      }
      this.#starting.add(conn.id);

      let client: RealtimeAudioClient;
      try {
        client = this.#resolveModel();
      } catch (err) {
        this.#starting.delete(conn.id);
        sendVoiceJSON(conn, { type: "error", message: String(err) });
        return;
      }

      const canStart = await this.beforeSessionStart(conn);
      if (!canStart) {
        this.#starting.delete(conn.id);
        return;
      }

      const agent = this.#resolveDefaultAgent();
      this.#agents.set(conn.id, agent);

      // Keep the DO alive for the duration of the call (matches @cloudflare/voice).
      const { keepAlive } = voiceHost(this);
      if (keepAlive) {
        try {
          const dispose = await keepAlive.call(this);
          this.#keepAlive.set(conn.id, dispose);
        } catch (err) {
          // Host exposes keepAlive but it threw — that's a real bug, surface it.
          console.error(
            "[withRealtimeVoice] keepAlive() threw — call will not be protected " +
              "from idle eviction (70-140s):",
            err instanceof Error ? err.message : String(err),
          );
        }
      } else if (!this.#keepAliveWarned) {
        // Host lacks `keepAlive()` entirely — this is an Kuralle usage error.
        // The SDK-shipped Agent / AIChatAgent classes both provide it; a
        // missing implementation means the mixin was applied to a custom base
        // that didn't extend those. Without keepAlive, calls die at ~70-140s
        // of audio-flow idle (VAD silence during a turn).
        this.#keepAliveWarned = true;
        console.warn(
          "[withRealtimeVoice] host does not expose `keepAlive()` — realtime " +
            "calls will be killed by DO idle eviction at ~70-140s. Extend " +
            "`KuralleRealtimeVoiceAgent` (which inherits from `AIChatAgent`) " +
            "rather than applying the mixin to a custom base.",
        );
      }

      this.#cm.initConnection(conn.id);

      // Per-call session id. DO identity (`this.ctx.id`) gives scalability
      // across users (distinct `name` on the client → distinct DO); call id
      // gives isolation between successive calls within the same DO.
      const sessionId = this.#mintCallId();
      const runtime = this.#buildRuntime(sessionId);

      // DO-scoped resumption handle (if the same user previously called and
      // their Gemini session handle is still within the 2h TTL, pass it in
      // so the provider resumes server-side state — audio/text context).
      const initialResumptionHandle = this.#readDoResumption(client.provider);

      const adapter = new CloudflareRealtimeAdapter({
        runtime,
        client,
        sessionId,
        agentId: agent.id,
        modelPolicy: inferModelPolicy(client),
        reconnectMaxAttempts,
        reconnectBaseDelayMs,
        reconnectCapDelayMs,
        reconnectAudioBufferBytes,
        initialResumptionHandle,
        sendJson: (frame: unknown) =>
          sendVoiceJSON(conn, frame as Record<string, unknown>),
        sendBinary: (data: Uint8Array) => conn.send(data),
        onResumptionHandle: (handle: string, meta: { provider: string }) => {
          // Persist DO-scoped (`this.state`), not call-scoped. Survives the
          // end of this call and is available to the next `start_call` on
          // the same DO.
          this.#writeDoResumption(handle, meta.provider);
        },
        onReconnecting: () => {
          sendVoiceJSON(conn, { type: "status", status: "connecting" });
        },
        onReconnected: () => {
          sendVoiceJSON(conn, { type: "status", status: "listening" });
        },
        onEnd: () => {
          void this.#teardown(conn);
        },
        onError: (err: Error) => {
          console.error("[withRealtimeVoice] adapter error:", err.message);
        },
      });

      this.#adapters.set(conn.id, adapter);

      try {
        await adapter.start();
      } catch (err) {
        this.#adapters.delete(conn.id);
        this.#starting.delete(conn.id);
        throw err;
      }

      this.#starting.delete(conn.id);

      sendVoiceJSON(conn, { type: "audio_config", format: "pcm16", sampleRate: 24000 });
      sendVoiceJSON(conn, { type: "status", status: "listening" });

      // Wrap adapter transcript frames so subclass hooks fire alongside UI events.
      // The adapter already sent `{type:"transcript", role, text}` via sendJson;
      // we surface to the hook here. isFinal is always true in the current
      // RealtimeAudioClient transcript stream (every emission is cumulative).
      const userHook = this.onUserTranscript.bind(this);
      const modelHook = this.onModelTranscript.bind(this);
      const clientForHooks = client;
      clientForHooks.on("transcript", (text: string, role: "user" | "assistant") => {
        sendVoiceJSON(conn, { type: "transcript", role, text });
        const fn = role === "user" ? userHook : modelHook;
        void fn(text, true, conn);
      });

      await this.onSessionStart(conn);
    }

    async #handleInterrupt(conn: Connection): Promise<void> {
      this.#adapters.get(conn.id)?.sendInterrupt();
      sendVoiceJSON(conn, { type: "status", status: "listening" });
      await this.onInterrupt(conn);
    }

    async #teardown(conn: Connection): Promise<void> {
      this.#starting.delete(conn.id);
      this.#sessionLossSignalled.delete(conn.id);
      const adapter = this.#adapters.get(conn.id);
      if (adapter) {
        this.#adapters.delete(conn.id);
        try {
          await adapter.stop("teardown");
        } catch {
          /* already closed */
        }
      }
      this.#agents.delete(conn.id);
      this.#cm.cleanup(conn.id);
      const dispose = this.#keepAlive.get(conn.id);
      if (dispose) {
        this.#keepAlive.delete(conn.id);
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
      sendVoiceJSON(conn, { type: "status", status: "idle" });
      try {
        await this.onSessionEnd(conn);
      } catch {
        /* ignore */
      }
    }
  }

  return RealtimeVoiceMixin as TBase & Constructor<RealtimeVoiceMixinMembers>;
}
