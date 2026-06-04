import { generateObject } from 'ai';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import type { DecideNode } from '../types/flow.js';
import type { ChoiceOption } from '../types/selection.js';
import type { RunContext } from '../types/run-context.js';

/** Reserved enum member: model declines to pick a listed choice (→ author stay/unmatched). */
export const CHOICE_NONE = '__none';

function normalize(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

function keywordTerms(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 4);
}

export function isConstrainedChoiceEnumSchema(schema: unknown): boolean {
  if (!(schema instanceof z.ZodObject)) {
    return false;
  }
  return schema.shape.choice instanceof z.ZodEnum;
}

export function isChoiceFieldSchema(schema: unknown): schema is z.ZodObject<{ choice: z.ZodString }> {
  if (!(schema instanceof z.ZodObject)) {
    return false;
  }
  const keys = Object.keys(schema.shape);
  if (keys.length !== 1 || keys[0] !== 'choice') {
    return false;
  }
  return schema.shape.choice instanceof z.ZodString;
}

export function buildChoiceEnumSchema(choices: ChoiceOption[]): z.ZodObject<{ choice: z.ZodEnum<[string, ...string[]]> }> {
  const ids = choices.map((c) => c.id);
  if (ids.length === 0) {
    return z.object({ choice: z.enum([CHOICE_NONE]) });
  }
  const members = [ids[0]!, ...ids.slice(1), CHOICE_NONE] as [string, ...string[]];
  return z.object({ choice: z.enum(members) });
}

export function latestUserMessageText(messages: ModelMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'user') {
      if (typeof message.content === 'string') {
        return message.content;
      }
      if (Array.isArray(message.content)) {
        const text = message.content
          .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
          .map((part) => part.text)
          .join('');
        if (text) {
          return text;
        }
      }
    }
  }
  return undefined;
}

export function matchChoiceFromInput(input: string, choices: ChoiceOption[]): string | undefined {
  const normalized = normalize(input);
  if (!normalized) {
    return undefined;
  }

  const idMatches = choices.filter((c) => normalize(c.id) === normalized).map((c) => c.id);
  if (idMatches.length === 1) {
    return idMatches[0];
  }
  if (idMatches.length > 1) {
    return undefined;
  }

  const labelMatches = choices.filter((c) => normalize(c.label) === normalized).map((c) => c.id);
  if (labelMatches.length === 1) {
    return labelMatches[0];
  }
  if (labelMatches.length > 1) {
    return undefined;
  }

  const keywordMatches: string[] = [];
  for (const choice of choices) {
    const terms = keywordTerms(choice.label);
    if (terms.length > 0 && terms.some((term) => normalized.includes(term))) {
      keywordMatches.push(choice.id);
    }
  }
  if (keywordMatches.length === 1) {
    return keywordMatches[0];
  }
  return undefined;
}

export async function resolveStructuredDecide(
  node: DecideNode,
  ctx: RunContext,
  system: string,
): Promise<unknown> {
  const schema = node.schema as z.ZodType;
  const useConstrainedChoices = (node.choices?.length ?? 0) > 0 && isChoiceFieldSchema(schema);

  if (!useConstrainedChoices) {
    const { object } = await generateObject({
      model: ctx.controlModel,
      schema,
      system,
      messages: ctx.runState.messages,
      temperature: 0,
      abortSignal: ctx.abortSignal,
    });
    return object;
  }

  const input = latestUserMessageText(ctx.runState.messages);
  if (input) {
    const matched = matchChoiceFromInput(input, node.choices!);
    if (matched) {
      return { choice: matched };
    }
  }

  const choiceSchema = buildChoiceEnumSchema(node.choices!);
  const { object } = await generateObject({
    model: ctx.controlModel,
    schema: choiceSchema,
    system,
    messages: ctx.runState.messages,
    temperature: 0,
    abortSignal: ctx.abortSignal,
  });
  return object;
}
