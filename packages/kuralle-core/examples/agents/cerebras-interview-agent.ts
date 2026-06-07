#!/usr/bin/env node

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { generateObject, type ModelMessage } from 'ai';
import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { buildToolSet, defineTool } from '../../src/tools/effect/defineTool.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { newSessionId } from '../../src/runtime/openRun.js';
import { loadExampleEnv, requireLiveModel } from '../_shared/v2Runner.js';

loadExampleEnv(import.meta.url);
const { model } = requireLiveModel();
const judgeModel = model;

const PROMPT_MAIN = `Interview practice assistant. If user is ready to start, call start_interview with confirmed=true. If they want to stop, call end_call. Do not mention tools. Be concise like a coach — ask the next interview question briefly. /no_think .`;

const evaluationSchema = z.object({
  competence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  strengths: z.string(),
  weaknesses: z.string(),
});

const judgePrompts = {
  technical: `Expert evaluating technical expertise. Bullet-point strengths/weaknesses. Rate HIGH/MEDIUM/LOW.`,
  communication: `Expert evaluating communication skills. Bullet-point strengths/weaknesses. Rate HIGH/MEDIUM/LOW.`,
  reasoning: `Expert evaluating reasoning and logic. Bullet-point strengths/weaknesses. Rate HIGH/MEDIUM/LOW.`,
};

class BackgroundJudge {
  constructor(
    private readonly nodeName: string,
    private readonly prompt: string,
  ) {
    const reportsDir = join(process.cwd(), 'reports');
    mkdirSync(reportsDir, { recursive: true });
    this.logPath = join(reportsDir, `${nodeName}.txt`);
    this.write(`Assessment for ${nodeName}\n${'-'.repeat(40)}\n`);
  }

  private readonly logPath: string;

  private write(message: string): void {
    appendFileSync(this.logPath, message, 'utf8');
  }

  async analyze(history: ModelMessage[], latestResponse: string): Promise<void> {
    try {
      const transcript = history.map((m) => `${m.role.toUpperCase()}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n');
      const { object } = await generateObject({
        model: judgeModel,
        schema: evaluationSchema,
        system: this.prompt,
        prompt: `Analyze the interview so far.\n\nConversation:\n${transcript}`,
        temperature: 0.4,
        maxOutputTokens: 100,
      });
      this.write(`\n[RESPONSE]\n${latestResponse}\n${'-'.repeat(40)}\n${this.nodeName}:\n  competence: ${object.competence}\n  strengths: ${object.strengths}\n  weaknesses: ${object.weaknesses}\n${'-'.repeat(40)}\n`);
    } catch (error) {
      console.error(`Judge ${this.nodeName} failed:`, error);
    }
  }
}

const judges = [
  new BackgroundJudge('Technical Report', judgePrompts.technical),
  new BackgroundJudge('Communication Report', judgePrompts.communication),
  new BackgroundJudge('Reasoning Report', judgePrompts.reasoning),
];

let interviewStarted = false;
const judgeJobs = new Set<Promise<void>>();

function runJudges(history: ModelMessage[], latest: string): void {
  if (!interviewStarted) return;
  const job = Promise.allSettled(judges.map((j) => j.analyze(history, latest))).then(() => {}).finally(() => judgeJobs.delete(job));
  judgeJobs.add(job);
}

const startInterview = defineTool({
  name: 'start_interview',
  description: 'Starts the interview after user confirmation.',
  input: z.object({ confirmed: z.boolean() }),
  execute: async ({ confirmed }) => {
    interviewStarted = confirmed;
    return confirmed
      ? { interviewStarted: true, message: 'Interview started. Ask the first question based on their role.' }
      : { interviewStarted: false, message: 'User declined to start the interview.' };
  },
});

const endCall = defineTool({
  name: 'end_call',
  description: 'End the interview call when user wants to stop.',
  input: z.object({ message: z.string().optional() }),
  execute: async ({ message }) => ({ endCall: true, message: message ?? 'Thank you for practicing. Goodbye!' }),
});

const tools = { end_call: endCall, start_interview: startInterview };

const agent = defineAgent({
  id: 'interview-agent',
  name: 'Interview Agent',
  instructions: PROMPT_MAIN,
  model,
  tools: tools,
  limits: { toolMaxSteps: 5 },
});

const sessionStore = new MemoryStore();

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: agent.id,
  sessionStore,
  defaultModel: model,
});

const prompts = [
  'I am applying for a senior backend engineer role.',
  'Yes, I am ready to start the interview.',
  'I recently led a migration from monolith to microservices and improved API latency by 40 percent.',
  'I design by clarifying requirements, ranking tradeoffs, and validating with metrics after rollout.',
  'I need to leave now. Thanks, goodbye.',
];

async function main() {
  console.log('Line example_integrations/cerebras parity (v2)');
  console.log('Intro: Welcome to the Interview Practice Platform! What role are you applying for?');

  const sessionId = newSessionId();
  let shouldStop = false;

  for (const input of prompts) {
    if (shouldStop) break;
    console.log(`\n${'='.repeat(70)}\nUser: ${input}\n${'='.repeat(70)}`);
    let response = '';
    const handle = runtime.run({ sessionId, input });
    for await (const part of handle.events) {
      if (part.type === 'text-delta') response += part.delta;
      if (part.type === 'tool-call') console.log(`[Tool call] ${part.toolName}`);
      if (part.type === 'tool-result') {
        console.log(`[Tool result] ${part.toolName} => ${JSON.stringify(part.result)}`);
        if (part.toolName === 'end_call' && (part.result as { endCall?: boolean })?.endCall) shouldStop = true;
      }
    }
    await handle;
    console.log(`Assistant: ${response.trim()}`);
    const session = await sessionStore.get(sessionId);
    if (session && interviewStarted) runJudges(session.messages as ModelMessage[], input);
  }

  await Promise.allSettled([...judgeJobs]);
  console.log('\nRun complete.');
  console.log('Reports written to: ' + join(process.cwd(), 'reports'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
