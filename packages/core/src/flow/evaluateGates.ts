import { generateObject, type LanguageModel } from 'ai';
import { z } from 'zod';
import {
  evaluatePredicate,
  pickAllowListedPaths,
  type PredicateContext,
} from '../flows/definition/predicate.js';
import { FLOW_INPUT_KEY, FLOW_RESULTS_KEY } from '../flows/definition/rehydrate.js';
import type {
  FlowGateSpec,
  FlowGateVerdict,
  FlowVerificationRecord,
} from '../flows/definition/types.js';
import type { FlowState } from '../types/flow.js';

export const FLOW_GATE_JUDGE_SYSTEM = [
  'You judge whether a completed flow run satisfies a rubric.',
  'You see only the allow-listed run-record fields in the user message.',
  'Return { pass: boolean, reason?: string }.',
].join(' ');

export const flowGateJudgeResultSchema = z
  .object({
    pass: z.boolean(),
    reason: z.string().optional(),
  })
  .strict();

export interface FlowGateJudgeProvider {
  readonly modelId: string;
  judge(args: {
    schema: typeof flowGateJudgeResultSchema;
    system: string;
    prompt: string;
    payload: Record<string, unknown>;
  }): Promise<unknown>;
}

export function isFlowGateJudgeProvider(value: unknown): value is FlowGateJudgeProvider {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { judge?: unknown }).judge === 'function' &&
    typeof (value as { modelId?: unknown }).modelId === 'string'
  );
}

function modelIdOf(model: { modelId?: unknown } | unknown): string {
  const id = (model as { modelId?: unknown } | null | undefined)?.modelId;
  return typeof id === 'string' && id.length > 0 ? id : 'unknown';
}

export function asFlowGateJudgeProvider(
  provider: FlowGateJudgeProvider | LanguageModel,
): FlowGateJudgeProvider {
  if (isFlowGateJudgeProvider(provider)) return provider;
  const model = provider;
  return {
    modelId: modelIdOf(model),
    async judge({ schema, system, prompt }) {
      const { object } = await generateObject({
        model,
        schema,
        system,
        prompt,
        temperature: 0,
      });
      return object;
    },
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function gateScopeFromState(state: FlowState, requestContext?: unknown): PredicateContext {
  const results = state[FLOW_RESULTS_KEY];
  return {
    input: state[FLOW_INPUT_KEY] ?? state,
    state,
    results: isPlainRecord(results) ? results : {},
    requestContext,
  };
}

/**
 * A check that fails to execute is always blocking, regardless of declared severity.
 * Advisory failures record and do not change the outcome.
 */
export function gateFailureIsBlocking(verdict: FlowGateVerdict): boolean {
  if (verdict.executionError) return true;
  return verdict.severity === 'blocking' && !verdict.passed;
}

function executionErrorVerdict(gate: FlowGateSpec, reason: string): FlowGateVerdict {
  return {
    id: gate.id,
    kind: gate.kind,
    severity: gate.severity,
    passed: false,
    executionError: true,
    reason,
  };
}

async function evaluateJudgeGate(
  gate: Extract<FlowGateSpec, { kind: 'judge' }>,
  ctx: PredicateContext,
  judge: FlowGateJudgeProvider | LanguageModel | undefined,
): Promise<FlowGateVerdict> {
  if (judge === undefined) {
    return executionErrorVerdict(gate, 'Judge gate has no provider.');
  }
  const payload = pickAllowListedPaths(ctx, gate.inputs);
  const prompt = [
    gate.rubric ? `Rubric:\n${gate.rubric}` : 'Rubric: the allow-listed fields must be acceptable.',
    `Allow-listed run record:\n${JSON.stringify(payload)}`,
  ].join('\n\n');
  try {
    const resolved = asFlowGateJudgeProvider(judge);
    const generated = await resolved.judge({
      schema: flowGateJudgeResultSchema,
      system: FLOW_GATE_JUDGE_SYSTEM,
      prompt,
      payload,
    });
    const parsed = flowGateJudgeResultSchema.safeParse(generated);
    if (!parsed.success) {
      return executionErrorVerdict(gate, 'Judge returned an object that is not a valid verdict.');
    }
    return {
      id: gate.id,
      kind: 'judge',
      severity: gate.severity,
      passed: parsed.data.pass,
      ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return executionErrorVerdict(gate, `Judge failed to execute: ${message}`);
  }
}

function evaluatePredicateGate(
  gate: Extract<FlowGateSpec, { kind: 'predicate' }>,
  ctx: PredicateContext,
): FlowGateVerdict {
  try {
    const passed = evaluatePredicate(gate.when, ctx);
    return {
      id: gate.id,
      kind: 'predicate',
      severity: gate.severity,
      passed,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return executionErrorVerdict(gate, `Predicate failed to execute: ${message}`);
  }
}

export async function evaluateFlowGates(args: {
  gates: readonly FlowGateSpec[] | undefined;
  state: FlowState;
  requestContext?: unknown;
  judge?: FlowGateJudgeProvider | LanguageModel;
}): Promise<FlowVerificationRecord | undefined> {
  if (!args.gates || args.gates.length === 0) return undefined;
  const ctx = gateScopeFromState(args.state, args.requestContext);
  const verdicts: FlowGateVerdict[] = [];
  for (const gate of args.gates) {
    if (gate.kind === 'predicate') {
      verdicts.push(evaluatePredicateGate(gate, ctx));
    } else {
      verdicts.push(await evaluateJudgeGate(gate, ctx, args.judge));
    }
  }
  const blocked = verdicts.some(gateFailureIsBlocking);
  return {
    outcome: blocked ? 'failed-verification' : 'passed',
    verdicts,
  };
}
