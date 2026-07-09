/**
 * Tests for `withRealtimeVoice` — the transport-glue mixin.
 *
 * After realtime voice convergence, the mixin is thin glue. Tool dispatch, flow
 * transitions, hooks, and persistence live in Runtime + VoiceEngine. These tests
 * cover ONLY what the mixin still owns: voice-protocol frame interception,
 * concurrent-session cap, adapter lifecycle wiring, subclass hook fire.
 *
 * Adapter-level behaviour (reconnect, chat_ctx replay, tool dispatch) is tested
 * separately in the realtime-audio package.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { withRealtimeVoice } from "../withRealtimeVoice.js";
import type { RealtimeVoiceMixinMembers } from "../withRealtimeVoice.js";
import { FakeConnection, StubRealtimeClient } from "./stubs.js";
import type { AgentConfig } from "@kuralle-agents/core";
import { z } from "zod";
import { tool } from "ai";
import type { UIMessage } from "ai";

// ─── Host factory ────────────────────────────────────────────────────────────

interface HostOptions {
  agents: AgentConfig[];
  defaultAgentId: string;
  client: StubRealtimeClient;
  maxConcurrent?: number;
}

/**
 * Minimal AIChatAgent-shaped host. Exposes what the mixin + adapter need:
 * `getAgents`, `getDefaultAgentId`, `messages`, `persistMessages`. No SQL —
 * the mixin now relies on Runtime + SessionStore (MemoryStore by default)
 * rather than `this.sql`.
 */
function makeHost(opts: HostOptions) {
  class BaseAgent {
    messages: UIMessage[] = [];
    persistedBatches: UIMessage[][] = [];
    env: Record<string, unknown> = {};
    getAgents() {
      return opts.agents;
    }
    getDefaultAgentId() {
      return opts.defaultAgentId;
    }
    async persistMessages(messages: UIMessage[]): Promise<void> {
      this.persistedBatches.push(messages);
      this.messages = messages;
    }
  }
  const Mixed = withRealtimeVoice(BaseAgent, {
    maxConcurrentSessions: opts.maxConcurrent ?? 4,
  });
  const host = new Mixed() as BaseAgent &
    RealtimeVoiceMixinMembers & {
      onConnect: (c: FakeConnection) => unknown;
      onClose: (c: FakeConnection) => unknown;
      onMessage: (c: FakeConnection, m: unknown) => unknown;
    };
  host.realtimeModel = opts.client;
  return host;
}

const demoTool = tool({
  description: "Echo the input",
  inputSchema: z.object({ value: z.string() }),
  async execute({ value }) {
    return { echoed: value };
  },
});

function makeAgents(): AgentConfig[] {
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "ok" },
          { type: "text-end", id: "t1" },
          {
            type: "finish",
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
            finishReason: { unified: "stop", raw: undefined },
          },
        ],
      }),
    }),
  });
  return [
    {
      id: "assistant",
      name: "Assistant",
      model,
      instructions: "You are a helpful voice assistant.",
      tools: { echo: demoTool },
    },
  ];
}

async function waitMs(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

let client: StubRealtimeClient;
let host: ReturnType<typeof makeHost>;
let conn: FakeConnection;

beforeEach(() => {
  client = new StubRealtimeClient();
  host = makeHost({ agents: makeAgents(), defaultAgentId: "assistant", client });
  conn = new FakeConnection("conn-1");
});

// ─── Mixin: transport-glue behaviour ─────────────────────────────────────────

describe("withRealtimeVoice — voice protocol", () => {
  test("welcome + idle frames on connect", () => {
    host.onConnect(conn);
    const frames = conn.jsonFrames();
    const welcome = frames.find((f) => f.type === "welcome");
    expect(welcome).toMatchObject({ type: "welcome", protocol_version: 1 });
    const idle = frames.find((f) => f.type === "status" && f.status === "idle");
    expect(idle).toBeTruthy();
  });

  test("start_call connects the provider client with authority-prepared config", async () => {
    host.onConnect(conn);
    host.onMessage(conn, JSON.stringify({ type: "start_call" }));
    await waitMs(30);
    expect(client.connectCalls.length).toBe(1);
    const cfg = client.connectCalls[0];
    // Authority's prepareRealtimeConfig feeds instructions + tool declarations.
    expect(typeof cfg.systemInstruction).toBe("string");
    expect(Array.isArray(cfg.tools)).toBe(true);
    const audioCfg = conn.jsonFrames().find((f) => f.type === "audio_config");
    expect(audioCfg).toMatchObject({
      type: "audio_config",
      format: "pcm16",
      sampleRate: 24000,
    });
    const listening = conn
      .jsonFrames()
      .find((f) => f.type === "status" && f.status === "listening");
    expect(listening).toBeTruthy();
  });

  test("audio passthrough: client PCM → adapter → client.sendAudio", async () => {
    host.onConnect(conn);
    host.onMessage(conn, JSON.stringify({ type: "start_call" }));
    await waitMs(30);
    const pcm = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    host.onMessage(conn, pcm.buffer.slice(0));
    expect(client.audioSent.length).toBe(1);
    expect(Array.from(client.audioSent[0])).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("audio passthrough: provider audio → client binary frame", async () => {
    host.onConnect(conn);
    host.onMessage(conn, JSON.stringify({ type: "start_call" }));
    await waitMs(30);
    const reply = new Uint8Array([9, 8, 7]);
    client.emit("audio", reply);
    const bin = conn.binaryFrames();
    expect(bin.length).toBe(1);
    expect(Array.from(bin[0])).toEqual([9, 8, 7]);
  });

  test("transcript event reaches the UI AND subclass hook", async () => {
    let userFired = "";
    host.onUserTranscript = async (text) => {
      userFired = text;
    };
    host.onConnect(conn);
    host.onMessage(conn, JSON.stringify({ type: "start_call" }));
    await waitMs(100);
    client.emit("transcript", "hello there", "user");
    await waitMs(100);
    const frame = conn
      .jsonFrames()
      .find((f) => f.type === "transcript" && f.role === "user");
    expect(frame).toMatchObject({ type: "transcript", role: "user", text: "hello there" });
    expect(userFired).toBe("hello there");
  });

  test("interrupt frame drives adapter → onInterrupt hook", async () => {
    let hookFired = 0;
    host.onInterrupt = async () => {
      hookFired += 1;
    };
    host.onConnect(conn);
    host.onMessage(conn, JSON.stringify({ type: "start_call" }));
    await waitMs(30);
    host.onMessage(conn, JSON.stringify({ type: "interrupt" }));
    await waitMs(20);
    expect(hookFired).toBe(1);
    const listeningFrames = conn
      .jsonFrames()
      .filter((f) => f.type === "status" && f.status === "listening");
    expect(listeningFrames.length).toBeGreaterThanOrEqual(2);
  });

  test("text_message routes to adapter's sendUserText path", async () => {
    host.onConnect(conn);
    host.onMessage(conn, JSON.stringify({ type: "start_call" }));
    await waitMs(30);
    host.onMessage(conn, JSON.stringify({ type: "text_message", text: "yo" }));
    await waitMs(10);
    // Stub falls through to requestResponse; verify either path recorded.
    expect(
      client.textPushed.includes("yo") || client.requestResponseCalls.includes("yo"),
    ).toBe(true);
  });
});

describe("withRealtimeVoice — lifecycle & cap", () => {
  test("duplicate start_call is ignored", async () => {
    host.onConnect(conn);
    host.onMessage(conn, JSON.stringify({ type: "start_call" }));
    host.onMessage(conn, JSON.stringify({ type: "start_call" }));
    await waitMs(50);
    expect(client.connectCalls.length).toBe(1);
  });

  test("end_call disconnects and emits idle", async () => {
    host.onConnect(conn);
    host.onMessage(conn, JSON.stringify({ type: "start_call" }));
    await waitMs(30);
    host.onMessage(conn, JSON.stringify({ type: "end_call" }));
    await waitMs(20);
    expect(client.disconnectCount).toBe(1);
    const idleCount = conn
      .jsonFrames()
      .filter((f) => f.type === "status" && f.status === "idle").length;
    // One idle on connect, one on teardown.
    expect(idleCount).toBeGreaterThanOrEqual(2);
  });

  test("onClose triggers teardown", async () => {
    host.onConnect(conn);
    host.onMessage(conn, JSON.stringify({ type: "start_call" }));
    await waitMs(30);
    host.onClose(conn);
    await waitMs(20);
    expect(client.disconnectCount).toBe(1);
  });

  test("session cap rejects the 5th concurrent start_call", async () => {
    const agents = makeAgents();
    const client1 = new StubRealtimeClient();
    const hostCap = makeHost({
      agents,
      defaultAgentId: "assistant",
      client: client1,
      maxConcurrent: 4,
    });
    const conns = Array.from({ length: 5 }, (_, i) => new FakeConnection(`c${i}`));
    for (const c of conns) hostCap.onConnect(c);
    for (const c of conns) hostCap.onMessage(c, JSON.stringify({ type: "start_call" }));
    await waitMs(60);
    expect(client1.connectCalls.length).toBe(4);
    const fifthErr = conns[4].jsonFrames().find((f) => f.type === "error");
    expect(fifthErr).toMatchObject({ type: "error", code: "session_cap_exceeded" });
  });

  test("beforeSessionStart returning false vetoes the call", async () => {
    host.beforeSessionStart = async () => false;
    host.onConnect(conn);
    host.onMessage(conn, JSON.stringify({ type: "start_call" }));
    await waitMs(30);
    expect(client.connectCalls.length).toBe(0);
  });
});
