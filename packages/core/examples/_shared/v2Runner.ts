import { config } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageModel } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createXai } from '@ai-sdk/xai';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { newSessionId } from '../../src/runtime/openRun.js';
import type { AgentConfig } from '../../src/authoring/defineAgent.js';
import type { HarnessStreamPart } from '../../src/types/stream.js';

export function loadExampleEnv(importMetaUrl: string): void {
  const dir = dirname(fileURLToPath(importMetaUrl));
  config({ path: join(dir, '../../../../.env') });
}

export interface LiveModel {
  model: LanguageModel;
  label: string;
}

type ExampleProvider = 'openai' | 'google' | 'xai';

function resolveExampleProviderOverride(): ExampleProvider | null {
  const raw = process.env.KURALLE_EXAMPLE_PROVIDER?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'openai' || raw === 'google' || raw === 'xai') return raw;
  throw new Error(
    `Invalid KURALLE_EXAMPLE_PROVIDER="${process.env.KURALLE_EXAMPLE_PROVIDER}" (expected openai, google, or xai)`,
  );
}

function liveModelForProvider(provider: ExampleProvider): LiveModel {
  if (provider === 'google') {
    const google = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!google) {
      throw new Error(
        'KURALLE_EXAMPLE_PROVIDER=google but GOOGLE_GENERATIVE_AI_API_KEY is not set',
      );
    }
    return {
      model: createGoogleGenerativeAI({ apiKey: google })('gemini-2.0-flash'),
      label: 'google:gemini-2.0-flash',
    };
  }
  if (provider === 'xai') {
    const xai = process.env.XAI_API_KEY;
    if (!xai) {
      throw new Error('KURALLE_EXAMPLE_PROVIDER=xai but XAI_API_KEY is not set');
    }
    return { model: createXai({ apiKey: xai })('grok-2-1212'), label: 'xai:grok-2-1212' };
  }
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    throw new Error('KURALLE_EXAMPLE_PROVIDER=openai but OPENAI_API_KEY is not set');
  }
  return {
    model: createOpenAI({ apiKey: openaiKey })(process.env.OPENAI_MODEL ?? 'gpt-4o-mini'),
    label: `openai:${process.env.OPENAI_MODEL ?? 'gpt-4o-mini'}`,
  };
}

export function resolveLiveModel(): LiveModel | null {
  const override = resolveExampleProviderOverride();
  if (override) {
    return liveModelForProvider(override);
  }

  const google = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (google) {
    return {
      model: createGoogleGenerativeAI({ apiKey: google })('gemini-2.0-flash'),
      label: 'google:gemini-2.0-flash',
    };
  }
  const xai = process.env.XAI_API_KEY;
  if (xai) {
    return { model: createXai({ apiKey: xai })('grok-2-1212'), label: 'xai:grok-2-1212' };
  }
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    return {
      model: createOpenAI({ apiKey: openaiKey })(process.env.OPENAI_MODEL ?? 'gpt-4o-mini'),
      label: `openai:${process.env.OPENAI_MODEL ?? 'gpt-4o-mini'}`,
    };
  }
  return null;
}

export function requireLiveModel(): LiveModel {
  const lm = resolveLiveModel();
  if (!lm) {
    console.error('No live API key found (GOOGLE_GENERATIVE_AI_API_KEY, XAI_API_KEY, or OPENAI_API_KEY)');
    process.exit(1);
  }
  return lm;
}

export async function runV2Conversation(opts: {
  title: string;
  agent: AgentConfig;
  agents?: AgentConfig[];
  prompts: string[];
  model?: LanguageModel;
  expectTerminal?: boolean;
  onPart?: (part: HarnessStreamPart) => void;
}): Promise<{ sessionId: string; transcript: string[]; flowEnded: boolean }> {
  const lm = opts.model ? { model: opts.model, label: 'custom' } : requireLiveModel();
  const agents = opts.agents ?? [opts.agent];
  const runtime = createRuntime({
    agents,
    defaultAgentId: opts.agent.id,
    sessionStore: new MemoryStore(),
    defaultModel: lm.model,
  });

  const sessionId = newSessionId();
  const transcript: string[] = [];
  let shouldStop = false;
  let flowTerminal: { flow: string; reason: string } | null = null;

  console.log(opts.title);
  console.log(`Provider: ${lm.label}`);

  for (const input of opts.prompts) {
    if (shouldStop) break;
    const sep = '='.repeat(70);
    console.log(`\n${sep}\nUser: ${input}\n${sep}`);
    transcript.push(`user: ${input}`);

    const handle = runtime.run({ sessionId, input });
    let response = '';

    for await (const part of handle.events) {
      opts.onPart?.(part);
      if (part.type === 'text-delta') response += part.delta;
      if (part.type === 'node-enter') console.log(`[Node] ${part.nodeName}`);
      if (part.type === 'flow-transition') console.log(`[Transition] ${part.from} -> ${part.to}`);
      if (part.type === 'flow-enter') console.log(`[Flow] ${part.flow}`);
      if (part.type === 'handoff') console.log(`[Handoff] ${part.targetAgent} (${part.reason ?? ''})`);
      if (part.type === 'flow-end') {
        flowTerminal = { flow: part.flow, reason: part.reason };
        console.log(`[Flow end] ${part.flow} (${part.reason})`);
      }
      if (part.type === 'tool-call') console.log(`[Tool call] ${part.toolName}`);
      if (part.type === 'tool-result') {
        console.log(`[Tool result] ${part.toolName}`);
        const result = part.result as { endCall?: boolean } | null;
        if (part.toolName === 'end_call' && result?.endCall) shouldStop = true;
      }
    }

    await handle;
    console.log(`Assistant: ${response.trim()}`);
    transcript.push(`assistant: ${response.trim()}`);
  }

  if (flowTerminal) {
    console.log(`\nRun complete (flow ended: ${flowTerminal.reason} in ${flowTerminal.flow}).`);
  } else {
    console.log('\n⚠️ Run ended WITHOUT reaching a terminal node (prompts exhausted).');
    if (opts.expectTerminal) {
      throw new Error('Expected flow to reach a terminal node but flow-end was not observed');
    }
  }

  return { sessionId, transcript, flowEnded: flowTerminal !== null };
}
