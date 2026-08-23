import { z } from 'zod';
import type { HitlInterrupt } from '@kuralle-agents/core';
import {
  projectInputRequest,
  reduce,
  type Block,
  type Cursor,
  type TurnView,
} from '@kuralle-agents/client';

const cursorSchema = z.object({
  sessionId: z.string().min(1),
  index: z.number().int(),
}).strict();

const inputRequestOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
}).strict();

const inputRequestSchema = z.object({
  requestId: z.string(),
  kind: z.enum(['approval', 'signal']),
  prompt: z.string(),
  description: z.string().optional(),
  signalName: z.string().optional(),
  toolName: z.string().optional(),
  options: z.array(inputRequestOptionSchema).optional(),
}).strict();

const turnStatusSchema = z.enum([
  'idle',
  'streaming',
  'completed',
  'waiting',
  'input-required',
  'escalated',
  'failed',
]);

const blockSchema: z.ZodType<Block> = z.discriminatedUnion('kind', [
  z.object({ id: z.string(), kind: z.literal('user'), text: z.string() }).strict(),
  z.object({
    id: z.string(),
    kind: z.literal('assistant'),
    text: z.string(),
    streaming: z.boolean(),
  }).strict(),
  z.object({
    id: z.string(),
    kind: z.literal('tool'),
    name: z.string(),
    args: z.unknown(),
    result: z.unknown().optional(),
    state: z.enum(['running', 'ok', 'error']),
    ms: z.number().optional(),
    startedAt: z.number().optional(),
  }).strict(),
  z.object({
    id: z.string(),
    kind: z.literal('flow'),
    flow: z.string(),
    node: z.string().optional(),
    phase: z.enum(['enter', 'transition', 'end']),
  }).strict(),
  z.object({
    id: z.string(),
    kind: z.literal('handoff'),
    to: z.string(),
    reason: z.string().optional(),
  }).strict(),
  z.object({
    id: z.string(),
    kind: z.literal('notice'),
    level: z.enum(['info', 'warn', 'error']),
    text: z.string(),
  }).strict(),
]);

const hitlInterruptSchema: z.ZodType<HitlInterrupt> = z.object({
  requestId: z.string(),
  kind: z.enum(['approval', 'signal']),
  signalName: z.string(),
  operation: z.object({
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.unknown(),
    argsHash: z.string(),
  }).strict().optional(),
  display: z.object({
    title: z.string(),
    description: z.string().optional(),
  }).strict(),
  responseSchema: z.record(z.string(), z.unknown()),
  deadline: z.number().nullable(),
  allowedDecisions: z.array(z.enum(['approve', 'deny'])),
  createdAt: z.number(),
}).strict();

const turnViewSchema = z.object({
  blocks: z.array(blockSchema),
  status: turnStatusSchema,
  pending: z.array(hitlInterruptSchema),
  timings: z.object({
    ttftMs: z.number().nullable(),
    totalMs: z.number().nullable(),
  }).strict(),
  usage: z.object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    contextTokens: z.number().optional(),
    cacheReadTokens: z.number().optional(),
    cacheWriteTokens: z.number().optional(),
  }).strict(),
  memory: z.object({
    extracted: z.array(z.object({
      slug: z.string(),
      value: z.unknown(),
      at: z.number(),
    }).strict()),
    compactions: z.array(z.object({
      beforeTokens: z.number(),
      afterTokens: z.number(),
      summarizedCount: z.number(),
    }).strict()),
  }).strict(),
  cursor: z.number().int(),
  startedAt: z.number().nullable(),
}).strict();

const turnResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('completed'),
    message: z.string().optional(),
    cursor: cursorSchema,
    view: turnViewSchema,
  }).strict(),
  z.object({
    status: z.literal('waiting'),
    message: z.string().optional(),
    cursor: cursorSchema,
    view: turnViewSchema,
  }).strict(),
  z.object({
    status: z.literal('input-required'),
    requests: z.array(inputRequestSchema),
    cursor: cursorSchema,
    view: turnViewSchema,
  }).strict(),
  z.object({
    status: z.literal('escalated'),
    reason: z.string(),
    cursor: cursorSchema,
    view: turnViewSchema,
  }).strict(),
  z.object({
    status: z.literal('failed'),
    message: z.string(),
    cursor: cursorSchema.optional(),
  }).strict(),
  z.object({
    status: z.literal('auth-required'),
    message: z.string(),
    code: z.string().optional(),
    cursor: cursorSchema.optional(),
  }).strict(),
]);

export type TurnResult = z.infer<typeof turnResultSchema>;

export const TurnResultSchema = turnResultSchema;

export const turnResultJsonSchema = {
  ...z.toJSONSchema(turnResultSchema, {
    target: 'draft-2020-12',
    unrepresentable: 'any',
  }),
  $id: 'https://kuralle.dev/schemas/turn-result.json',
  title: 'kuralle turn result',
};

export function exitCodeFor(status: TurnResult['status']): number {
  switch (status) {
    case 'completed':
    case 'waiting':
    case 'escalated':
      return 0;
    case 'failed':
      return 1;
    case 'input-required':
    case 'auth-required':
      return 3;
  }
}

export function writeTurnResult(result: TurnResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function assistantMessage(view: TurnView): string | undefined {
  const text = view.blocks
    .filter((block): block is Extract<Block, { kind: 'assistant' }> => block.kind === 'assistant')
    .map((block) => block.text)
    .join('');
  return text.length > 0 ? text : undefined;
}

function noticeText(view: TurnView, level: 'warn' | 'error'): string | undefined {
  const notice = view.blocks.find(
    (block): block is Extract<Block, { kind: 'notice' }> =>
      block.kind === 'notice' && block.level === level,
  );
  return notice?.text;
}

export function buildTurnResult(sessionId: string, view: TurnView): TurnResult {
  const cursor: Cursor = { sessionId, index: view.cursor };

  switch (view.status) {
    case 'completed':
      return { status: 'completed', message: assistantMessage(view), cursor, view };
    case 'waiting':
      return { status: 'waiting', message: assistantMessage(view), cursor, view };
    case 'input-required':
      return {
        status: 'input-required',
        requests: view.pending.map(projectInputRequest),
        cursor,
        view,
      };
    case 'escalated':
      return {
        status: 'escalated',
        reason: noticeText(view, 'warn') ?? 'escalated',
        cursor,
        view,
      };
    case 'failed':
      return {
        status: 'failed',
        message: noticeText(view, 'error') ?? 'turn failed',
        cursor,
      };
    default:
      return { status: 'waiting', message: assistantMessage(view), cursor, view };
  }
}

export function authRequiredResult(message: string, code?: string, cursor?: Cursor): TurnResult {
  return { status: 'auth-required', message, code, cursor };
}

export function parseTurnResult(value: unknown): TurnResult {
  return turnResultSchema.parse(value);
}
