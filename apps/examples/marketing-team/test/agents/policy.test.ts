import { describe, expect, it } from 'bun:test';
import { createRuntime, MemoryStore, type AgentConfig } from '@kuralle-agents/core';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import type { StreamPart } from '@kuralle-agents/core';
import { createSeoAgent } from '../../agent/seo/agent.js';
import { createProductMarketerAgent } from '../../agent/product-marketer/agent.js';
import { createBrandContextTools } from '../../agent/lib/index.js';
import { testDeps } from './helpers.js';

// `LanguageModelV3Usage` nests token counts (`{ inputTokens: { total, noCache, ... } }`), unlike
// the flat V2 shape — `tsc` catches the mismatch even though the untyped runtime does not.
const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/**
 * A stub model, not a live one — `OPENAI_API_KEY` is unset in this environment (see repo-root
 * `.env`), and this test needs a model that reliably attempts a specific tool call rather than
 * one that might reason its way out of it, so a stub is the right tool even with a key present.
 *
 * Call 1: call the named tool. Call 2+: answer in plain text so the turn ends cleanly once the
 * tool result (denied or not) comes back.
 */
function modelThatAttempts(toolName: string, args: Record<string, unknown>) {
  let calls = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'tool-call', toolCallId: 'call-1', toolName, input: JSON.stringify(args) },
              // `finishReason` is `LanguageModelV3FinishReason` — an object (`{ unified, raw }`),
              // not the plain string the V2 spec used. Passing a bare string silently loses the
              // reason instead of erroring, and Kuralle's own turn loop checks
              // `finishReason !== 'tool-calls'` to decide whether to dispatch the tool call at
              // all — a bare string here makes the whole scenario a silent no-op.
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: USAGE },
            ],
          }),
        };
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: 'noted' },
            { type: 'text-end', id: 't' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE },
          ],
        }),
      };
    },
  }) as never;
}

async function runOneTurn(agent: AgentConfig, model: ReturnType<typeof modelThatAttempts>) {
  const wired = { ...agent, model };
  const runtime = createRuntime({
    agents: [wired],
    defaultAgentId: wired.id,
    sessionStore: new MemoryStore(),
    defaultModel: model,
  });
  const parts: StreamPart[] = [];
  const handle = runtime.run({
    sessionId: `policy-${wired.id}-${Math.random()}`,
    input: 'update the positioning',
  });
  for await (const part of handle.events) parts.push(part);
  await handle;
  return parts;
}

function findToolResult(parts: StreamPart[], toolName: string) {
  return parts.find(
    (p) => p.type === 'tool-result' && (p.payload as { toolName?: string }).toolName === toolName,
  );
}

describe('b5 test 2: save_brand_context is denied by policy for non-product-marketer specialists', () => {
  it('seo attempting save_brand_context is denied by POLICY, not by the model declining', async () => {
    // seo's real, shipped tool grant never includes `save_brand_context` at all — the AI SDK's
    // own tool-call validation silently drops a call to a tool outside the schema it was given,
    // so a call can never even reach dispatch through seo's real surface (that absence is what
    // test 1 already proves). To isolate the POLICY layer specifically — proving it would still
    // hold even if the tool were ever exposed — this test grants it on the wire for this call
    // only, while keeping seo's real, shipped `policy`. The policy is what must do the denying.
    const seo = await createSeoAgent(testDeps());
    const { save_brand_context } = createBrandContextTools(testDeps());
    const wired = { ...seo, tools: { ...seo.tools, save_brand_context } };
    const model = modelThatAttempts('save_brand_context', { markdown: 'hijacked positioning' });

    const parts = await runOneTurn(wired, model);
    const toolResult = findToolResult(parts, 'save_brand_context');
    expect(toolResult, 'no tool-result for save_brand_context was emitted at all').toBeDefined();
    const result = (toolResult!.payload as { result: unknown }).result as {
      __denied?: boolean;
      deniedBy?: string;
      message?: string;
    };
    // `__denied` (not a thrown/malformed-call error) is what the runtime's own
    // `toolDeniedResult` shape marks — proof this came from `ToolApprovalDeniedError` via the
    // policy boundary, not from the tool executing, erroring, or the model declining to call it.
    expect(result.__denied, `save_brand_context result was not a denial: ${JSON.stringify(result)}`).toBe(true);
    expect(result.deniedBy, 'denial did not come from the policy layer').toBe('policy');
    expect(parts.some((p) => p.type === 'error')).toBe(false);
  });

  it('product-marketer calling save_brand_context is NOT denied (the policy is scoped, not global)', async () => {
    const pm = await createProductMarketerAgent(testDeps());
    const model = modelThatAttempts('save_brand_context', { markdown: 'a real update' });
    const parts = await runOneTurn(pm, model);
    const toolResult = findToolResult(parts, 'save_brand_context');
    expect(toolResult).toBeDefined();
    const result = (toolResult!.payload as { result: unknown }).result as { __denied?: boolean };
    // product-marketer's tool actually executes here against the fake `db` in `testDeps()`,
    // which throws (it is an empty stand-in, never a real connection) — a genuine execution
    // failure, not a policy denial. Either way the result must not carry the `__denied` shape.
    expect(result?.__denied).not.toBe(true);
  });
});
