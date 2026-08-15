import type { StandardSchemaV1 } from '../types/standard-schema.js';
import type { CollectNode, FlowState, SlotSource } from '../types/flow.js';
import type { Tool } from '../types/effectTool.js';
import type { StreamPart } from '../types/stream.js';
import { defineTool } from '../tools/effect/defineTool.js';
import { z } from 'zod';
import { filterByProvenance } from './slotResolution.js';

function collectDataKey(nodeId: string): string {
  return `__collect_${nodeId}`;
}

function collectTurnsKey(nodeId: string): string {
  return `__collectTurns_${nodeId}`;
}

/** Clear a collect node's gathered fields, preserving its turn counter so
 *  `maxTurns` still bounds a recovery loop. */
export function clearCollectData(state: FlowState, nodeId: string): void {
  delete state[collectDataKey(nodeId)];
}

export function getCollectData(state: FlowState, nodeId: string): Record<string, unknown> {
  const raw = state[collectDataKey(nodeId)];
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return { ...(raw as Record<string, unknown>) };
  }
  return {};
}

export function setCollectData(state: FlowState, nodeId: string, data: Record<string, unknown>): void {
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

/**
 * Fields whose collected value is present but does NOT satisfy the node's schema.
 *
 * Completion used to be presence-only: any non-empty value passed, so a model that invented
 * an enum member (`urgency: "high"` against `z.enum(['emergency','urgent','routine'])`) or
 * supplied the wrong primitive completed the node and the flow acted on it. The schema was
 * only ever used to derive key names, never to check a value.
 *
 * Validation is awaited so async Standard Schema implementations receive the same
 * field-level diagnostics as synchronous schemas.
 *
 * NOTE this catches SHAPE, not REFERENT. `unitId: "12B"` is a perfectly valid string; that a
 * unit by that id does not exist is a domain fact only a tool boundary can know.
 */
export async function invalidCollectFields(
  node: CollectNode,
  data: Record<string, unknown>,
): Promise<string[]> {
  const validate = (node.schema as StandardSchemaV1)['~standard']?.validate;
  if (typeof validate !== 'function') return [];
  let result: StandardSchemaV1.Result<unknown>;
  try {
    result = await validate(data);
  } catch {
    return [];
  }
  const issues = 'issues' in result ? result.issues : undefined;
  if (!issues?.length) return [];
  const fields = new Set<string>();
  for (const issue of issues) {
    const first = issue.path?.[0];
    const key =
      typeof first === 'string'
        ? first
        : typeof (first as { key?: unknown })?.key === 'string'
          ? ((first as { key: string }).key)
          : undefined;
    // Only report fields the node actually collected. An issue on a field that was never
    // supplied is a missing-field problem, which computeMissingFields already owns.
    if (key && key in data) fields.add(key);
  }
  return [...fields];
}

export async function schemaSatisfied(node: CollectNode, state: FlowState): Promise<boolean> {
  const data = getCollectData(state, node.id);
  if (computeMissingFields(node, data).length > 0) return false;
  const result = await node.schema['~standard'].validate(data);
  return !('issues' in result);
}

/** Whether merging tool results into current collect state would satisfy the node. */
export async function wouldCollectSatisfyAfterToolResults(
  node: CollectNode,
  state: FlowState,
  toolResults: Array<{ name: string; result: unknown }>,
  sourceText?: string,
): Promise<boolean> {
  const submitName = submitToolName(node.id);
  let data = getCollectData(state, node.id);
  for (const record of toolResults) {
    if (record.name !== submitName) {
      continue;
    }
    const incoming = isPlainRecord(record.result) ? record.result : {};
    const { accepted } = filterByProvenance(incoming, sourceText, node.verbatimFields);
    if (isEmptySubmission(accepted) || isNonDataToolResult(incoming)) {
      continue;
    }
    data = mergeExtractionData(data, accepted);
  }
  const probeState: FlowState = { ...state, [collectDataKey(node.id)]: data };
  return schemaSatisfied(node, probeState);
}

export async function projectCollectData(node: CollectNode, state: FlowState): Promise<unknown> {
  const data = getCollectData(state, node.id);
  const result = await node.schema['~standard'].validate(data);
  if ('issues' in result) {
    const message = result.issues.map((issue) => issue.message).join('; ');
    throw new Error(`Collect "${node.id}" completed with invalid data: ${message}`);
  }
  return result.value;
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

function isNonDataToolResult(result: Record<string, unknown>): boolean {
  return result.error === true || result.__denied === true;
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
    input: toNullablePartialSchema(node.schema, missingFields),
    execute: async (args: unknown) => (isPlainRecord(args) ? args : {}),
  });
}

function submitToolName(nodeId: string): string {
  return `submit_${slugify(nodeId)}_data`;
}

export interface MergeTurnExtractionResult {
  merged: boolean;
  incoming?: Record<string, unknown>;
  submitted?: Record<string, unknown>;
  dropped?: string[];
  slotSources?: Record<string, SlotSource>;
}

export function mergeTurnExtraction(
  node: CollectNode,
  state: FlowState,
  toolResults: Array<{ name: string; result: unknown }>,
  opts?: { sourceText?: string },
): MergeTurnExtractionResult {
  const submitName = submitToolName(node.id);
  let merged = false;
  let lastIncoming: Record<string, unknown> | undefined;
  let lastSubmitted: Record<string, unknown> | undefined;
  const dropped: string[] = [];
  const slotSources: Record<string, SlotSource> = {};
  const current = getCollectData(state, node.id);

  for (const record of toolResults) {
    if (record.name !== submitName) {
      continue;
    }
    const raw = isPlainRecord(record.result) ? record.result : {};
    lastSubmitted = raw;
    const { accepted, dropped: guardedOut } = filterByProvenance(
      raw,
      opts?.sourceText,
      node.verbatimFields,
    );
    dropped.push(...guardedOut);
    if (isEmptySubmission(accepted) || isNonDataToolResult(raw)) {
      continue;
    }
    const next = mergeExtractionData(current, accepted);
    setCollectData(state, node.id, next);
    Object.assign(current, next);
    merged = true;
    lastIncoming = accepted;
    for (const key of Object.keys(accepted)) {
      if (fieldPopulated(accepted[key])) {
        slotSources[key] = 'model';
      }
    }
  }

  if (!merged && dropped.length === 0) {
    return { merged: false };
  }
  return {
    merged,
    incoming: lastIncoming,
    submitted: lastSubmitted,
    ...(dropped.length > 0 ? { dropped } : {}),
    ...(Object.keys(slotSources).length > 0 ? { slotSources } : {}),
  };
}

export function emitExtractionTelemetry(
  node: CollectNode,
  state: FlowState,
  incoming: Record<string, unknown>,
  emit: (part: StreamPart) => void,
  extra?: { dropped?: string[]; slotSources?: Record<string, SlotSource> },
): void {
  const droppedSet = new Set(extra?.dropped ?? []);
  const fieldsAccepted: string[] = [];
  const fieldsRejected: string[] = [...droppedSet];
  for (const [key, value] of Object.entries(incoming)) {
    if (droppedSet.has(key)) {
      continue;
    }
    if (fieldPopulated(value)) {
      fieldsAccepted.push(key);
    } else {
      fieldsRejected.push(key);
    }
  }
  emit({
    channel: 'internal',
    type: 'custom',
    payload: {
      name: 'flow.extraction.submission',
      data: { node: node.id, fieldsAccepted, fieldsRejected },
    },
  });
  const collected = getCollectData(state, node.id);
  const missing = computeMissingFields(node, collected);
  emit({
    channel: 'internal',
    type: 'custom',
    payload: {
      name: 'flow.extraction.update',
      data: {
        nodeId: node.id,
        collected,
        missing,
        ...(extra?.slotSources && Object.keys(extra.slotSources).length > 0
          ? { slotSources: extra.slotSources }
          : {}),
      },
    },
  });
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

export function inferRequiredFields(schema: StandardSchemaV1): string[] {
  const zodSchema = schema as z.ZodObject<z.ZodRawShape>;
  if (typeof zodSchema?.shape === 'object') {
    return Object.keys(zodSchema.shape);
  }
  return [];
}

function toNullablePartialSchema(
  schema: StandardSchemaV1,
  keys?: readonly string[],
): z.ZodTypeAny {
  const zodSchema = schema as z.ZodObject<z.ZodRawShape>;
  if (typeof zodSchema?.shape !== 'object') {
    return schema as z.ZodTypeAny;
  }

  const allowed = keys ? new Set(keys) : undefined;
  const partialShape: Record<string, z.ZodTypeAny> = {};
  for (const [key, fieldSchema] of Object.entries(zodSchema.shape)) {
    if (allowed && !allowed.has(key)) {
      continue;
    }
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

function recoveryMessageKey(nodeId: string): string {
  return `__recoveryMessage_${nodeId}`;
}

/** Stash author-written copy for the user, to be shown once by the next `ask`. */
export function setPendingRecoveryMessage(
  state: FlowState,
  nodeId: string,
  message: string | undefined,
): void {
  if (message === undefined || !message.trim()) {
    delete state[recoveryMessageKey(nodeId)];
    return;
  }
  state[recoveryMessageKey(nodeId)] = message;
}

/** Read and clear it — a reason is shown once, not repeated on every later re-ask. */
export function takePendingRecoveryMessage(
  state: FlowState,
  nodeId: string,
): string | undefined {
  const raw = state[recoveryMessageKey(nodeId)];
  delete state[recoveryMessageKey(nodeId)];
  return typeof raw === 'string' && raw.trim() ? raw : undefined;
}
