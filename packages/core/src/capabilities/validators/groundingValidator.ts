import { generateObject } from 'ai';
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import type {
  ValidationCapability,
  ValidateDecision,
  ValidateInput,
} from '../ValidationCapability.js';

export interface GroundingValidatorOptions {
  /** Judge model, run at temperature 0. Use the agent's controlModel-class model. */
  model: LanguageModel;
  /** Extra domain rules appended to the judge prompt (e.g. "never promise refunds"). */
  instructions?: string;
  name?: string;
}

const verdictSchema = z.object({
  verdict: z.enum(['grounded', 'ungrounded']),
  /** Required when ungrounded: the same reply with unsupported claims removed/softened. */
  rewrittenOutput: z.union([z.string(), z.null()]),
  rationale: z.union([z.string(), z.null()]),
  confidence: z.number(),
});

function summarizeEvidence(input: ValidateInput): string {
  const lines: string[] = [];
  if (input.toolCallsMade.length === 0) {
    lines.push('Tool calls this turn: NONE — no external action was performed.');
  } else {
    lines.push('Tool calls this turn:');
    for (const call of input.toolCallsMade) {
      const result = truncateJson(call.result, 400);
      lines.push(`- ${call.toolName}(${truncateJson(call.args, 200)}) → ${call.success ? result : `FAILED: ${result}`}`);
    }
  }
  const stateKeys = Object.entries(input.state);
  if (stateKeys.length > 0) {
    lines.push('Flow state (evidence written by earlier steps):');
    for (const [key, value] of stateKeys) {
      if (key.startsWith('__')) continue;
      lines.push(`- ${key}: ${truncateJson(value, 200)}`);
    }
  }
  if (input.knowledgeCitations.length > 0) {
    lines.push(
      `Knowledge citations: ${input.knowledgeCitations.map((c) => c.title ?? c.id).join('; ')}`,
    );
  }
  return lines.join('\n');
}

function truncateJson(value: unknown, max: number): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * State-grounded output validator: checks the assistant reply for action/fact
 * claims unsupported by this turn's tool calls, flow state, or citations —
 * the "order placed" with no create-order call class of hallucination.
 *
 * Repair policy is rewrite-not-block: an ungrounded claim is rewritten out of
 * the reply rather than replacing the whole turn with an apology, so the
 * conversation keeps moving. If the judge flags ungrounded but cannot produce
 * a rewrite, the turn is blocked (fail safe). Judge errors fail open with low
 * confidence — the validator is a gate, not a single point of failure.
 */
export function createGroundingValidator(options: GroundingValidatorOptions): ValidationCapability {
  return {
    name: options.name ?? 'grounding-validator',
    async validate(input: ValidateInput): Promise<ValidateDecision> {
      let verdict: z.infer<typeof verdictSchema>;
      try {
        const { object } = await generateObject({
          model: options.model,
          schema: verdictSchema,
          temperature: 0,
          abortSignal: input.abortSignal,
          system: [
            'You are a grounding judge for a customer-facing agent. Decide whether the assistant reply',
            'claims any COMPLETED action or specific fact that the evidence below does not support.',
            'Examples of ungrounded claims: "your order has been placed" with no order-creation evidence;',
            'inventing prices, dates, or policies not present in tool results, state, or citations.',
            'Asking questions, describing next steps, or hedged language is grounded.',
            'If ungrounded, produce rewrittenOutput: the SAME reply with unsupported claims removed or',
            'softened into honest next steps. Preserve tone and any grounded content.',
            options.instructions ? `Additional rules:\n${options.instructions}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
          prompt: [
            `User message:\n${input.userMessage}`,
            `Assistant reply:\n${input.assistantOutput}`,
            `Evidence:\n${summarizeEvidence(input)}`,
          ].join('\n\n'),
        });
        verdict = object;
      } catch {
        return { decision: 'continue', confidence: 0.5, rationale: 'grounding judge unavailable' };
      }

      if (verdict.verdict === 'grounded') {
        return { decision: 'continue', confidence: verdict.confidence };
      }
      if (verdict.rewrittenOutput && verdict.rewrittenOutput.trim()) {
        return {
          decision: 'rewrite',
          confidence: verdict.confidence,
          rewrittenOutput: verdict.rewrittenOutput,
          rationale: verdict.rationale ?? 'ungrounded claim removed',
        };
      }
      return {
        decision: 'block',
        confidence: verdict.confidence,
        rationale: verdict.rationale ?? 'ungrounded claim with no safe rewrite',
      };
    },
  };
}
