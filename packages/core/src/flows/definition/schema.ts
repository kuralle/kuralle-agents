import { z } from 'zod';
import type { ChoiceOption } from '../../types/selection.js';
import { mappingConfigSchema } from './mapping.js';
import { predicateSchema } from './predicate.js';

const jsonSchemaSchema = z.record(z.string(), z.unknown());

const transitionRefSchema = z.union([
  z.object({ goto: z.string().min(1), data: z.record(z.string(), z.unknown()).optional() }).strict(),
  z.object({ handoff: z.string().min(1), reason: z.string().optional() }).strict(),
  z.object({ escalate: z.string().min(1) }).strict(),
  z.object({ end: z.string().min(1) }).strict(),
  z.literal('stay'),
]);

const predicateRouteSchema = z
  .object({
    when: predicateSchema,
    to: transitionRefSchema,
    whenSource: z.string().min(1).optional(),
  })
  .strict();

const confirmGateRefSchema = z
  .object({
    onConfirm: transitionRefSchema,
    onDecline: transitionRefSchema,
    onAmbiguous: transitionRefSchema.optional(),
  })
  .strict();

export const choiceOptionSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string().optional(),
    url: z.string().optional(),
    flow: z.object({ flowId: z.string().min(1), cta: z.string().min(1) }).strict().optional(),
  })
  .strict() satisfies z.ZodType<ChoiceOption>;

const collectResolverSpecSchema = z.discriminatedUnion('kind', [
  z
    .object({
      field: z.string().min(1),
      kind: z.literal('enum_check'),
      values: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      field: z.string().min(1),
      kind: z.literal('range'),
      min: z.number().optional(),
      max: z.number().optional(),
    })
    .strict(),
  z
    .object({
      field: z.string().min(1),
      kind: z.literal('jsonpath'),
      path: z.string().min(1),
    })
    .strict(),
]);

const replyBase = {
  kind: z.literal('reply'),
  id: z.string().min(1),
  instructions: z.string().optional(),
  next: transitionRefSchema.optional(),
  routes: z.array(predicateRouteSchema).optional(),
};

const replyTemplateNodeSchema = z
  .object({
    ...replyBase,
    response: z.object({ template: z.string().min(1) }).strict(),
  })
  .strict();

const replyGenerateNodeSchema = z
  .object({
    ...replyBase,
    generate: z.literal(true),
  })
  .strict();

const collectNodeSchema = z
  .object({
    kind: z.literal('collect'),
    id: z.string().min(1),
    schema: jsonSchemaSchema,
    ask: z.string().optional(),
    instructions: z.string().optional(),
    assign: z.record(z.string(), z.string()).optional(),
    resolvers: z.array(collectResolverSpecSchema).optional(),
    required: z.array(z.string().min(1)).optional(),
    maxTurns: z.number().int().positive().optional(),
    choices: z.array(choiceOptionSchema).optional(),
    next: transitionRefSchema.optional(),
  })
  .strict();

const actionNodeSchema = z
  .object({
    kind: z.literal('action'),
    id: z.string().min(1),
    tool: z.string().min(1),
    args: mappingConfigSchema.optional(),
    bind: z.string().min(1).optional(),
    approval: z.literal(true).optional(),
    next: transitionRefSchema.optional(),
    routes: z.array(predicateRouteSchema).optional(),
  })
  .strict();

const decideNodeSchema = z
  .object({
    kind: z.literal('decide'),
    id: z.string().min(1),
    instructions: z.string().optional(),
    schema: jsonSchemaSchema.optional(),
    choices: z.array(choiceOptionSchema).optional(),
    routes: z.array(predicateRouteSchema).optional(),
    otherwise: transitionRefSchema.optional(),
    confirmGate: confirmGateRefSchema.optional(),
  })
  .strict();

export const flowNodeDefinitionSchema = z.union([
  replyTemplateNodeSchema,
  replyGenerateNodeSchema,
  collectNodeSchema,
  actionNodeSchema,
  decideNodeSchema,
]);

const flowGateSeveritySchema = z.enum(['blocking', 'advisory']);

const predicateFlowGateSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal('predicate'),
    severity: flowGateSeveritySchema,
    when: predicateSchema,
  })
  .strict();

const judgeFlowGateSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal('judge'),
    severity: flowGateSeveritySchema,
    inputs: z.array(z.string().min(1)).min(1),
    rubric: z.string().min(1).optional(),
  })
  .strict();

export const flowGateSpecSchema = z.discriminatedUnion('kind', [
  predicateFlowGateSchema,
  judgeFlowGateSchema,
]);

export const flowDefinitionSchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    inputSchema: jsonSchemaSchema.optional(),
    outputSchema: jsonSchemaSchema.optional(),
    start: z.string().min(1),
    nodes: z.array(flowNodeDefinitionSchema),
    gates: z.array(flowGateSpecSchema).optional(),
  })
  .strict();

export type ValidatableFlowNodeDefinition = z.infer<typeof flowNodeDefinitionSchema>;
export type ValidatableFlowDefinition = z.infer<typeof flowDefinitionSchema>;
