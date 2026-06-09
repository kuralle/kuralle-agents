import { generateObject } from 'ai';
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import type { TurnHandle } from '../types/stream.js';
import type { UserInputContent } from '../runtime/userInput.js';
import { newSessionId } from '../runtime/openRun.js';

/**
 * Simulated-user evaluation: an LLM role-plays a customer persona against a
 * real runtime, and an LLM judge scores the resulting transcript against a
 * rubric. This is the pre-deploy gate that scripted turn assertions
 * (`EvalRunner`) cannot provide — scripted turns test the happy path you
 * thought of; simulated users find the conversations you didn't.
 */
export interface SimulatedUserPersona {
  /** Who the user is, e.g. "a busy parent in Colombo ordering a birthday cake". */
  profile: string;
  /** What they are trying to accomplish — the goal the judge scores against. */
  goal: string;
  /** Behavioral style, e.g. "impatient; sends short fragmented messages; switches topics". */
  temperament?: string;
  /** First user message. Generated from the persona when omitted. */
  openingMessage?: string;
}

export interface SimulatedTranscriptTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type SimulationEnd = 'goal-met' | 'user-gave-up' | 'max-turns';

export interface SimulationResult {
  transcript: SimulatedTranscriptTurn[];
  turns: number;
  endedBy: SimulationEnd;
  sessionId: string;
  toolsCalled: string[];
  escalated: boolean;
}

/** The runtime surface the simulator drives (satisfied by `Runtime`). */
export interface SimulatableRuntime {
  run(opts: { sessionId?: string; input?: UserInputContent }): TurnHandle;
}

const userTurnSchema = z.object({
  /** Null when the user would stop talking instead of replying. */
  message: z.union([z.string(), z.null()]),
  status: z.enum(['continue', 'goal-met', 'give-up']),
});

function renderTranscript(transcript: SimulatedTranscriptTurn[]): string {
  return transcript
    .map((turn) => `${turn.role === 'user' ? 'You' : 'Agent'}: ${turn.content}`)
    .join('\n');
}

async function nextUserTurn(
  model: LanguageModel,
  persona: SimulatedUserPersona,
  transcript: SimulatedTranscriptTurn[],
): Promise<z.infer<typeof userTurnSchema>> {
  const { object } = await generateObject({
    model,
    schema: userTurnSchema,
    temperature: 0.7,
    system: [
      'You are role-playing a customer talking to a business chat agent. Stay fully in character.',
      `Who you are: ${persona.profile}`,
      `Your goal: ${persona.goal}`,
      persona.temperament ? `Your style: ${persona.temperament}` : '',
      'Write your next message as this customer would (short, natural chat messages — not essays).',
      "Set status to 'goal-met' when the agent has fully accomplished your goal,",
      "'give-up' if you would abandon the conversation in frustration, otherwise 'continue'.",
      "When status is not 'continue', message may be null or a short closing line.",
    ]
      .filter(Boolean)
      .join('\n'),
    prompt:
      transcript.length === 0
        ? 'Write your opening message to the agent.'
        : `Conversation so far:\n${renderTranscript(transcript)}\n\nWrite your next message.`,
  });
  return object;
}

export interface SimulateConversationOptions {
  runtime: SimulatableRuntime;
  persona: SimulatedUserPersona;
  /** Model that plays the user. */
  userModel: LanguageModel;
  /** Max user turns before the simulation stops. Default: 10. */
  maxTurns?: number;
  sessionId?: string;
}

export async function simulateConversation(
  options: SimulateConversationOptions,
): Promise<SimulationResult> {
  const maxTurns = options.maxTurns ?? 10;
  const sessionId = options.sessionId ?? newSessionId();
  const transcript: SimulatedTranscriptTurn[] = [];
  const toolsCalled: string[] = [];
  let escalated = false;
  let endedBy: SimulationEnd = 'max-turns';

  for (let turn = 0; turn < maxTurns; turn += 1) {
    let userMessage: string;
    if (turn === 0 && options.persona.openingMessage) {
      userMessage = options.persona.openingMessage;
    } else {
      const next = await nextUserTurn(options.userModel, options.persona, transcript);
      if (next.status !== 'continue') {
        if (next.message?.trim()) {
          transcript.push({ role: 'user', content: next.message });
        }
        endedBy = next.status === 'goal-met' ? 'goal-met' : 'user-gave-up';
        break;
      }
      if (!next.message?.trim()) {
        endedBy = 'user-gave-up';
        break;
      }
      userMessage = next.message;
    }

    transcript.push({ role: 'user', content: userMessage });

    const handle = options.runtime.run({ sessionId, input: userMessage });
    let reply = '';
    for await (const part of handle.events) {
      if (part.type === 'text-delta') reply += part.delta;
      if (part.type === 'tool-call') toolsCalled.push(part.toolName);
      if (part.type === 'escalation' || (part.type === 'handoff' && part.targetAgent === 'human')) {
        escalated = true;
      }
    }
    const result = await handle;
    transcript.push({ role: 'assistant', content: reply || result.text });
  }

  return {
    transcript,
    turns: transcript.filter((turn) => turn.role === 'user').length,
    endedBy,
    sessionId,
    toolsCalled,
    escalated,
  };
}

// ── LLM judge ────────────────────────────────────────────────────────────────

export interface JudgeDimension {
  key: string;
  description: string;
}

export const DEFAULT_JUDGE_DIMENSIONS: JudgeDimension[] = [
  { key: 'goalCompletion', description: 'Did the agent fully accomplish what the user wanted?' },
  {
    key: 'grounding',
    description:
      'Did the agent avoid claiming actions or facts it did not perform/know (no invented orders, prices, policies)?',
  },
  { key: 'tone', description: 'Was the agent natural, concise, and appropriate for chat?' },
  {
    key: 'efficiency',
    description: 'Did the agent resolve the request without unnecessary turns or repeated questions?',
  },
];

const judgeSchema = z.object({
  scores: z.array(
    z.object({
      key: z.string(),
      /** 1 (poor) to 5 (excellent). */
      score: z.number(),
      rationale: z.string(),
    }),
  ),
  summary: z.string(),
});

export interface JudgeVerdict {
  scores: Record<string, { score: number; rationale: string }>;
  /** Mean of dimension scores, 1–5. */
  overall: number;
  pass: boolean;
  summary: string;
}

export interface CreateJudgeOptions {
  model: LanguageModel;
  dimensions?: JudgeDimension[];
  /** Minimum mean score (1–5) to pass. Default: 3.5. */
  passThreshold?: number;
  /** Extra domain rules appended to the judge prompt. */
  instructions?: string;
}

export interface ConversationJudge {
  judge(result: SimulationResult, persona: SimulatedUserPersona): Promise<JudgeVerdict>;
}

export function createJudge(options: CreateJudgeOptions): ConversationJudge {
  const dimensions = options.dimensions ?? DEFAULT_JUDGE_DIMENSIONS;
  const passThreshold = options.passThreshold ?? 3.5;

  return {
    async judge(result, persona) {
      const { object } = await generateObject({
        model: options.model,
        schema: judgeSchema,
        temperature: 0,
        system: [
          'You are an evaluation judge for customer-facing conversational agents.',
          'Score the AGENT (not the user) on each dimension from 1 (poor) to 5 (excellent), with a one-sentence rationale each:',
          ...dimensions.map((dimension) => `- ${dimension.key}: ${dimension.description}`),
          options.instructions ? `Additional rules:\n${options.instructions}` : '',
          'Be strict: claiming an action that has no evidence in the transcript is a grounding failure.',
        ]
          .filter(Boolean)
          .join('\n'),
        prompt: [
          `User persona: ${persona.profile}`,
          `User goal: ${persona.goal}`,
          `Conversation ended by: ${result.endedBy}. Tools called: ${result.toolsCalled.join(', ') || 'none'}.`,
          `Transcript:\n${renderTranscript(result.transcript)}`,
        ].join('\n\n'),
      });

      const scores: JudgeVerdict['scores'] = {};
      for (const entry of object.scores) {
        scores[entry.key] = { score: entry.score, rationale: entry.rationale };
      }
      const values = Object.values(scores).map((entry) => entry.score);
      const overall =
        values.length > 0 ? values.reduce((sum, score) => sum + score, 0) / values.length : 0;

      return {
        scores,
        overall,
        pass: overall >= passThreshold && result.endedBy !== 'user-gave-up',
        summary: object.summary,
      };
    },
  };
}

// ── Suite ────────────────────────────────────────────────────────────────────

export interface SimulationScenario {
  name: string;
  persona: SimulatedUserPersona;
  maxTurns?: number;
}

export interface SimulationSuiteResult {
  scenarios: Array<{
    name: string;
    result: SimulationResult;
    verdict: JudgeVerdict;
  }>;
  passed: boolean;
  passRate: number;
}

export interface RunSimulationSuiteOptions {
  runtime: SimulatableRuntime;
  scenarios: SimulationScenario[];
  userModel: LanguageModel;
  judge: ConversationJudge;
}

/** Run every scenario and judge each transcript. `passed` is the CI gate. */
export async function runSimulationSuite(
  options: RunSimulationSuiteOptions,
): Promise<SimulationSuiteResult> {
  const scenarios: SimulationSuiteResult['scenarios'] = [];
  for (const scenario of options.scenarios) {
    const result = await simulateConversation({
      runtime: options.runtime,
      persona: scenario.persona,
      userModel: options.userModel,
      maxTurns: scenario.maxTurns,
    });
    const verdict = await options.judge.judge(result, scenario.persona);
    scenarios.push({ name: scenario.name, result, verdict });
  }
  const passedCount = scenarios.filter((entry) => entry.verdict.pass).length;
  return {
    scenarios,
    passed: passedCount === scenarios.length,
    passRate: scenarios.length > 0 ? passedCount / scenarios.length : 1,
  };
}
