import { describe, expect, it } from 'bun:test';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { z } from 'zod';
import {
  MemorySessionEventLog,
  MemoryStore,
  PART_CHANNEL,
  createRuntime,
  defineTool,
  type AgentConfig,
  type LoggedEvent,
} from '@kuralle-agents/core';
import {
  InMemoryDeploymentStore,
  NamedRegistry,
  VersionedRegistry,
  createArtifact,
  sha256,
  type RuntimeBindings,
  type RuntimeRevision,
} from '@kuralle-agents/deployment';
import { createDeploymentRouter, type ThreadExecutionCoordinator } from '../src/deploymentRouter.js';
import { startDeploymentServer } from '../src/node.js';
import { mockV3GenerateResult, mockV3StreamResult } from './helpers/mockLanguageModelV3Results.js';
import { httpTransport } from '@kuralle-agents/client';

/**
 * The turn route, exercised by the client that actually consumes it.
 *
 * The predecessor of this test stood up a hand-written `Bun.serve` that emitted whatever shape the
 * client was being taught to read. It passed while the real route spoke a different wire entirely,
 * which is how the same defect was mis-diagnosed twice. Both halves here are the real ones.
 */

const AT = '2026-08-01T00:00:00.000Z';

const TOOL_SECRET = 'sk-proj-abc123def456789012345678901';

function billingTool(needsApproval: boolean) {
  return defineTool({
    name: 'billing',
    description: 'test tool',
    input: z.object({ apiKey: z.string() }),
    needsApproval,
    execute: async () => ({ ok: true }),
  });
}

async function deployment(options?: {
  withEventLog?: boolean;
  callsTool?: boolean;
  needsApproval?: boolean;
  streamFilter?: 'safe' | 'all';
}) {
  let turns = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => mockV3GenerateResult('ok'),
    doStream: async () => {
      if (!options?.callsTool) return mockV3StreamResult(`turn${++turns}`);
      if (++turns > 1) return mockV3StreamResult('billed');
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'billing',
              input: JSON.stringify({ apiKey: TOOL_SECRET }),
            },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls' },
              usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
            },
          ] as never[],
        }),
      } as never;
    },
  });
  const instructions = 'Reply briefly.';
  const artifact = await createArtifact({
    schemaVersion: 1,
    artifactId: 'support-v1',
    compiler: { name: 'kuralle', version: '0.19.0' },
    runtimeApiRange: '^1.0.0',
    agent: { id: 'support', model: 'test/model' },
    instructions: [{
      path: 'instructions.md',
      digest: await sha256(instructions),
      bytes: new TextEncoder().encode(instructions).byteLength,
      mediaType: 'text/markdown',
      role: 'instructions',
      content: { kind: 'inline', text: instructions },
    }],
    skills: [], references: [], workspaceSeed: [], agents: [], flows: [],
    tools: options?.callsTool
      ? [{ kind: 'trusted', id: 'billing', capability: 'billing', versionRange: '^1.0.0' }]
      : [],
    policies: {},
    requiredCapabilities: options?.callsTool
      ? [{ capability: 'billing', versionRange: '^1.0.0' }]
      : [],
    secretRefs: [], sourceMap: [],
  });

  const deploymentStore = new InMemoryDeploymentStore();
  await deploymentStore.createEntity({
    id: 'support', tenantId: 'tenant-a', slug: 'support', status: 'active',
    ownerId: 'owner-1', visibility: 'private', createdAt: AT,
  });
  await deploymentStore.createVersion({
    id: 'version-1', tenantId: 'tenant-a', agentEntityId: 'support', version: 1,
    artifact, createdBy: 'owner-1', createdAt: AT,
  });
  const runtimeRevision: RuntimeRevision = {
    id: 'runtime-1', artifactSchemaVersions: [1], runtimeApiVersion: '1.0.0',
    capabilities: options?.callsTool ? [{ id: 'billing', version: '1.0.0' }] : [], createdAt: AT,
  };
  await deploymentStore.registerRuntime(runtimeRevision);
  await deploymentStore.createRelease({
    id: 'release-1', tenantId: 'tenant-a', agentEntityId: 'support', environment: 'production',
    allocations: [{ agentVersionId: 'version-1', runtimeRevisionId: 'runtime-1', weight: 10_000 }],
    createdAt: AT,
  });
  await deploymentStore.routeTrafficTo('tenant-a', 'release-1');

  const models = new NamedRegistry<NonNullable<AgentConfig['model']>>();
  models.register('test/model', model);
  const bindings: RuntimeBindings = {
    models, tools: new VersionedRegistry(), flows: new VersionedRegistry(),
  };
  const billing = billingTool(options?.needsApproval ?? false);
  if (options?.callsTool) bindings.tools.register({ id: 'billing', version: '1.0.0', value: billing });
  let active = false;
  const coordinator: ThreadExecutionCoordinator = {
    acquire: async () => {
      if (active) return null;
      active = true;
      return { renew: async () => {}, release: async () => { active = false; } };
    },
  };

  const app = createDeploymentRouter({
    deploymentStore,
    sessionStore: new MemoryStore(),
    runtimeRevision,
    bindings,
    coordinator,
    ...(options?.withEventLog === false ? {} : { eventLog: new MemorySessionEventLog() }),
    // No `streamFilter` by default: the router's own default is what a deployment runs, and it
    // is the boundary that keeps tool arguments and internal parts off a public wire.
    ...(options?.streamFilter ? { streamFilter: options.streamFilter } : {}),
    runtimeConfig: options?.callsTool ? { tools: { billing } } : {},
    runtimeFactory: config => createRuntime(config),
    resolvePrincipal: c => {
      const tenantId = c.req.header('authorization')?.replace('Bearer ', '');
      return tenantId ? { tenantId, userId: 'user-1' } : null;
    },
  });
  // The Node server the product actually ships, not `Bun.serve`. `@hono/node-server` swaps the
  // `Response` implementation for the whole process, so a `Bun.serve` in the same test run stops
  // accepting Hono's responses as soon as another file has imported it. Using the real entry point
  // makes this file order-independent and tests the server a deployment runs.
  let announce!: (port: number) => void;
  const listening = new Promise<number>(resolve => { announce = resolve; });
  const server = startDeploymentServer({
    app,
    port: 0,
    installSignalHandlers: false,
    onListening: info => announce(info.port),
  });
  const port = await listening;
  return { app, origin: `http://127.0.0.1:${port}`, stop: () => server.shutdown() };
}

/**
 * Exactly what `ChatApp.drainTurn` does: append each streamed event the session does not already
 * hold at that index, then merge `/snapshot` the same way — onto the events earlier turns left
 * behind, which is what makes the index space shared rather than per-turn.
 */
function drainTurnLikeTheTui(
  held: LoggedEvent[],
  streamed: LoggedEvent[],
  snapshot: LoggedEvent[],
): LoggedEvent[] {
  const merged = [...held];
  for (const event of [...streamed, ...snapshot]) {
    if (!merged.some((existing) => existing.index === event.index)) merged.push(event);
  }
  return merged;
}

function assistantText(events: LoggedEvent[]): string {
  return events
    .filter((event) => event.part.type === 'text-delta')
    .map((event) => (event.part.payload as { delta: string }).delta)
    .join('');
}

describe('the deployment turn route', () => {
  it('streams the log identity, so a second turn merges with the snapshot cleanly', async () => {
    const deployed = await deployment();
    try {
      const session = httpTransport({
        kind: 'http', url: deployed.origin, agentName: 'support', auth: { token: 'tenant-a' },
      } as never).sessions.attach('thread-1');

      // Two turns, because one proves nothing: a client-side sequencer numbers every turn from 0,
      // so the second one lands on top of the first and the collision only shows from turn two.
      let held: LoggedEvent[] = [];
      let streamed: LoggedEvent[] = [];
      for (const message of ['first', 'second']) {
        streamed = [];
        for await (const event of await session.send(message)) streamed.push(event);
        held = drainTurnLikeTheTui(held, streamed, (await session.snapshot()).events);
      }
      const snapshot = await session.snapshot();

      expect(streamed.length).toBeGreaterThan(0);
      expect(Math.min(...streamed.map((event) => event.index))).toBeGreaterThan(0);
      for (const event of streamed) {
        const logged = snapshot.events.find((candidate) => candidate.index === event.index);
        expect(logged?.eventId).toBe(event.eventId);
        expect(logged?.at).toBe(event.at);
      }

      expect(held).toHaveLength(snapshot.events.length);
      expect(assistantText(held)).toBe(assistantText(snapshot.events));
      expect(assistantText(held)).toBe('turn1turn2');
    } finally {
      await deployed.stop();
    }
  }, 20_000);

  /**
   * `scopedKey(tenantId, threadId)` is how a thread is addressed in storage. It names the tenant
   * and it shows how keys are composed, and it used to ride out on every logged event — in
   * `runId`, and in `done.payload.sessionId` — across the turn stream, `/events` and `/snapshot`.
   * The raw wire had always rewritten it out of `done`; the logged-event surfaces had not.
   */
  it('never puts the composed storage key on any logged-event surface', async () => {
    const deployed = await deployment();
    try {
      const session = httpTransport({
        kind: 'http', url: deployed.origin, agentName: 'support', auth: { token: 'tenant-a' },
      } as never).sessions.attach('thread-key');

      const streamed: LoggedEvent[] = [];
      for await (const event of await session.send('hi')) streamed.push(event);
      const snapshot = await session.snapshot();
      // `follow=false` on purpose. Omitting it is a long poll — `parseFollow(undefined)` is
      // `true` — so a reader that wants the backlog and nothing more has to say so.
      const eventsResponse = await deployed.app.request(
        'http://local/v1/agents/support/sessions/thread-key/events?from=0&follow=false',
        { headers: { authorization: 'Bearer tenant-a' } },
      );
      const events = await eventsResponse.text();

      for (const wire of [JSON.stringify(streamed), JSON.stringify(snapshot), events]) {
        expect(wire).not.toContain('tenant-a');
        expect(wire).not.toContain('|');
      }
      expect(streamed.every((event) => event.runId === 'thread-key')).toBe(true);
    } finally {
      await deployed.stop();
    }
  }, 20_000);

  it('still answers the AI SDK UIMessage stream by default, for the browser', async () => {
    const deployed = await deployment();
    try {
      const response = await fetch(`${deployed.origin}/v1/agents/support/threads/b/messages`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer tenant-a',
          'content-type': 'application/json',
          'idempotency-key': 'browser-1',
        },
        body: JSON.stringify({ message: 'hi' }),
      });
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain('"type":"text-delta"');
      expect(body).not.toContain('"eventId"');
    } finally {
      await deployed.stop();
    }
  }, 20_000);

  /**
   * The logged-event wire streams the session log, which holds every part the turn emitted —
   * tool arguments, model call spans, flow transitions, extraction results. The default
   * `streamFilter` is what keeps those off a public route, and it keys on `PART_CHANNEL` rather
   * than the part's own `channel` so a part cannot mislabel its way out. Nothing here should be
   * readable by whoever holds a thread credential except the assistant's own words.
   */
  it('keeps internal parts and tool arguments off the wire under the default filter', async () => {
    const deployed = await deployment({ callsTool: true });
    try {
      const session = httpTransport({
        kind: 'http', url: deployed.origin, agentName: 'support', auth: { token: 'tenant-a' },
      } as never).sessions.attach('thread-tool');

      const streamed: LoggedEvent[] = [];
      for await (const event of await session.send('bill me')) streamed.push(event);
      const snapshot = await session.snapshot();

      for (const event of [...streamed, ...snapshot.events]) {
        expect(PART_CHANNEL[event.part.type]).toBe('client');
      }
      expect(JSON.stringify(streamed)).not.toContain(TOOL_SECRET);
      expect(JSON.stringify(snapshot.events)).not.toContain(TOOL_SECRET);
      expect(JSON.stringify(streamed)).not.toContain('billing');
    } finally {
      await deployed.stop();
    }
  }, 20_000);

  it('refuses the logged-event wire before starting a turn when no log is configured', async () => {
    const deployed = await deployment({ withEventLog: false });
    try {
      const response = await fetch(
        `${deployed.origin}/v1/agents/support/threads/c/messages?format=events`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer tenant-a',
            'content-type': 'application/json',
            'idempotency-key': 'nolog-1',
          },
          body: JSON.stringify({ message: 'hi' }),
        },
      );

      expect(response.status).toBe(503);
    } finally {
      await deployed.stop();
    }
  }, 20_000);
});

/**
 * `respond()` against a deployment used to answer 404.
 *
 * The client posted every resume to `/api/chat/resume`, which belongs to the single-process chat
 * server and which this router does not register. So a hosted approval — the TUI's whole HITL
 * path — could never be delivered, however the turn had paused.
 */
describe('resuming a paused turn on a deployment', () => {
  it('delivers the approval and finishes the turn', async () => {
    // `streamFilter: 'all'` because `paused` is an internal-channel part. Under the default filter
    // a deployment never tells a client it is waiting, and `HitlInterrupt.operation` carries the
    // tool arguments, so admitting it wholesale is a deliberate choice a deployment has to make.
    const deployed = await deployment({ callsTool: true, needsApproval: true, streamFilter: 'all' });
    try {
      const session = httpTransport({
        kind: 'http', url: deployed.origin, agentName: 'support', auth: { token: 'tenant-a' },
      } as never).sessions.attach('thread-hitl');

      const first: LoggedEvent[] = [];
      for await (const event of await session.send('bill me')) first.push(event);
      const paused = first.find((event) => event.part.type === 'paused');
      const interrupt = (paused?.part.payload as { interrupt?: { requestId: string } } | undefined)
        ?.interrupt;
      expect(interrupt?.requestId).toBeTruthy();

      const resumed: LoggedEvent[] = [];
      for await (const event of await session.respond([
        { requestId: interrupt!.requestId, decision: 'approve' },
      ])) resumed.push(event);

      expect(resumed.length).toBeGreaterThan(0);
      // The resumed turn keeps reading the same log, so it continues the index space rather than
      // restarting it — the same property the message route has.
      expect(Math.min(...resumed.map((event) => event.index)))
        .toBeGreaterThan(Math.max(...first.map((event) => event.index)));
      expect(resumed.some((event) => event.part.type === 'tool-result')).toBe(true);
    } finally {
      await deployed.stop();
    }
  }, 20_000);

  it('takes the actor from the credential, never the body', async () => {
    const deployed = await deployment();
    try {
      // In-process, because a turn that fails after the headers are sent can only break the
      // stream, and a socket read would surface that as ECONNRESET rather than a status.
      const response = await deployed.app.request(
        'http://local/v1/agents/support/threads/t/resume?format=events',
        {
          method: 'POST',
          headers: { authorization: 'Bearer tenant-a', 'content-type': 'application/json' },
          body: JSON.stringify({
            signal: {
              signalId: 's1',
              requestId: 'r1',
              name: '__approval',
              decision: 'approve',
              actor: { id: 'someone-else', type: 'user' },
            },
          }),
        },
      );
      await response.body?.cancel();

      // The route is registered. A 404 here is the defect this test covers: every hosted approval
      // used to be posted to `/api/chat/resume`, which this router does not serve. Nothing is
      // waiting on this thread, so the turn itself then fails — that is the runtime's answer.
      expect(response.status).toBe(200);
    } finally {
      await deployed.stop();
    }
  }, 20_000);
});
