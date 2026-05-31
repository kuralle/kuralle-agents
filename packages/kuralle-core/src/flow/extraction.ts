import type { StandardSchemaV1 } from '../types/standard-schema.js';
import type { CollectNode, FlowState } from '../types/flow.js';
import type { Tool } from '../types/effectTool.js';
import { defineTool } from '../tools/effect/defineTool.js';
import { z } from 'zod';

function collectDataKey(nodeId: string): string {
  return `__collect_${nodeId}`;
}

function collectTurnsKey(nodeId: string): string {
  return `__collectTurns_${nodeId}`;
}

export function getCollectData(state: FlowState, nodeId: string): Record<string, unknown> {
  const raw = state[collectDataKey(nodeId)];
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return { ...(raw as Record<string, unknown>) };
  }
  return {};
}

function setCollectData(state: FlowState, nodeId: string, data: Record<string, unknown>): void {
  state[collectDataKey(nodeId)] = data;
}

function getCollectTurns(state: FlowState, nodeId: string): number {
  const value = state[collectTurnsKey(nodeId)];
  return typeof value === 'number' ? value : 0;
}

export function incrementCollectTurns(state: FlowState, nodeId: string): number {
  const next = getCollectTurns(state, nodeId) + 1;
  state[collectTurnsKey(nodeId)] = next;
  return next;
}

export function computeMissingFields(
  node: CollectNode,
  data: Record<string, unknown>,
): string[] {
  const required = node.required ?? inferRequiredFields(node.schema);
  return required.filter((field) => !fieldPopulated(data[field]));
}

export function schemaSatisfied(node: CollectNode, state: FlowState): boolean {
  const data = getCollectData(state, node.id);
  return computeMissingFields(node, data).length === 0;
}

export function projectCollectData(node: CollectNode, state: FlowState): unknown {
  const data = getCollectData(state, node.id);
  const required = node.required ?? inferRequiredFields(node.schema);
  const projected: Record<string, unknown> = {};
  for (const field of required) {
    projected[field] = data[field];
  }
  return projected;
}

export function mergeExtractionData(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    if (!fieldPopulated(value)) {
      continue;
    }
    next[key] = value;
  }
  return next;
}

function isEmptySubmission(args: Record<string, unknown>): boolean {
  for (const value of Object.values(args)) {
    if (fieldPopulated(value)) {
      return false;
    }
  }
  return true;
}

export function createExtractionSubmitTool(
  node: CollectNode,
  missingFields: readonly string[],
  opts: { userMessage?: string; retryNudge?: boolean } = {},
): Tool {
  const toolName = submitToolName(node.id);
  const stillNeeded =
    missingFields.length > 0
      ? `Still needed: ${missingFields.join(', ')}.`
      : 'All required fields collected.';
  const userMsgBlock = opts.userMessage
    ? `\n\nThe user's latest message (extract values from THIS exact text):\n"""\n${opts.userMessage}\n"""`
    : '';
  const retryBlock = opts.retryNudge
    ? '\n\nIMPORTANT: A previous submit call produced no field values. Extract and submit them now.'
    : '';
  const description =
    `Submit information extracted from the conversation for the "${node.id}" step. ` +
    `${stillNeeded} Only submit values explicitly provided by the user. Call this when you learn a field value.` +
    userMsgBlock +
    retryBlock;

  return defineTool({
    name: toolName,
    description,
    input: toNullablePartialSchema(node.schema),
    execute: async (args: unknown) => (isPlainRecord(args) ? args : {}),
  });
}

function submitToolName(nodeId: string): string {
  return `submit_${slugify(nodeId)}_data`;
}

export function mergeTurnExtraction(
  node: CollectNode,
  state: FlowState,
  toolResults: Array<{ name: string; result: unknown }>,
): boolean {
  const submitName = submitToolName(node.id);
  let merged = false;
  const current = getCollectData(state, node.id);

  for (const record of toolResults) {
    if (record.name !== submitName) {
      continue;
    }
    const incoming = isPlainRecord(record.result) ? record.result : {};
    if (isEmptySubmission(incoming)) {
      continue;
    }
    const next = mergeExtractionData(current, incoming);
    setCollectData(state, node.id, next);
    Object.assign(current, next);
    merged = true;
  }

  return merged;
}

function fieldPopulated(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return false;
  }
  return true;
}

function inferRequiredFields(schema: StandardSchemaV1): string[] {
  const zodSchema = schema as z.ZodObject<z.ZodRawShape>;
  if (typeof zodSchema?.shape === 'object') {
    return Object.keys(zodSchema.shape);
  }
  return [];
}

function toNullablePartialSchema(schema: StandardSchemaV1): z.ZodTypeAny {
  const zodSchema = schema as z.ZodObject<z.ZodRawShape>;
  if (typeof zodSchema?.shape !== 'object') {
    return schema as z.ZodTypeAny;
  }

  const partialShape: z.ZodRawShape = {};
  for (const [key, fieldSchema] of Object.entries(zodSchema.shape)) {
    partialShape[key] = (fieldSchema as z.ZodTypeAny).optional().nullable();
  }
  return z.object(partialShape);
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
