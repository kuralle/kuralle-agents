import { z } from 'zod';
import type { AnyTool } from '../../types/effectTool.js';
import type { JsonSchema } from '../definition/types.js';
import type { FlowRegistryIndex, FlowRegistrySchemas } from '../definition/validate/types.js';

export interface FlowBuilderCatalogEntry {
  id: string;
  name?: string;
  description?: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
}

export type FlowBuilderCatalogSource =
  | Iterable<FlowBuilderCatalogEntry | AnyTool>
  | Record<string, FlowBuilderCatalogEntry | AnyTool>;

function isTool(value: unknown): value is AnyTool {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AnyTool).execute === 'function' &&
    typeof (value as AnyTool).description === 'string'
  );
}

function jsonSchemaOf(schema: unknown): JsonSchema | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined;
  const standard = (schema as { '~standard'?: { vendor?: string } })['~standard'];
  if (standard?.vendor !== 'zod') return undefined;
  try {
    return z.toJSONSchema(schema as z.ZodType) as JsonSchema;
  } catch {
    return undefined;
  }
}

function entryFromTool(tool: AnyTool, fallbackId: string): FlowBuilderCatalogEntry {
  const id = tool.name || fallbackId;
  const inputSchema = jsonSchemaOf(tool.input);
  const outputSchema = jsonSchemaOf(tool.output);
  return {
    id,
    name: id,
    description: tool.description,
    ...(inputSchema ? { inputSchema } : {}),
    ...(outputSchema ? { outputSchema } : {}),
  };
}

function entryFromUnknown(value: FlowBuilderCatalogEntry | AnyTool, fallbackId: string): FlowBuilderCatalogEntry {
  if (isTool(value)) return entryFromTool(value, fallbackId);
  const id = value.id || fallbackId;
  return { ...value, id };
}

export function normalizeFlowBuilderCatalog(source: FlowBuilderCatalogSource | undefined): FlowBuilderCatalogEntry[] {
  if (source === undefined) return [];
  if (typeof source === 'object' && !Array.isArray(source) && !(Symbol.iterator in source)) {
    return Object.entries(source as Record<string, FlowBuilderCatalogEntry | AnyTool>).map(([key, value]) =>
      entryFromUnknown(value, key),
    );
  }
  const entries: FlowBuilderCatalogEntry[] = [];
  for (const value of source as Iterable<FlowBuilderCatalogEntry | AnyTool>) {
    entries.push(entryFromUnknown(value, isTool(value) ? value.name : value.id));
  }
  return entries;
}

function schemasFrom(entry: FlowBuilderCatalogEntry): FlowRegistrySchemas {
  return {
    id: entry.id,
    ...(entry.inputSchema ? { inputSchema: entry.inputSchema } : {}),
    ...(entry.outputSchema ? { outputSchema: entry.outputSchema } : {}),
  };
}

function tableFrom(entries: FlowBuilderCatalogEntry[]): Record<string, FlowRegistrySchemas> {
  const table: Record<string, FlowRegistrySchemas> = {};
  for (const entry of entries) {
    table[entry.id] = schemasFrom(entry);
    if (entry.name && entry.name !== entry.id) {
      table[entry.name] = schemasFrom({ ...entry, id: entry.name });
    }
  }
  return table;
}

export function registryIndexFromCatalogs(catalogs: {
  tools: FlowBuilderCatalogEntry[];
  flows: FlowBuilderCatalogEntry[];
  agents: FlowBuilderCatalogEntry[];
}): FlowRegistryIndex {
  const index: FlowRegistryIndex = {};
  if (catalogs.tools.length > 0) index.tools = tableFrom(catalogs.tools);
  if (catalogs.flows.length > 0) index.flows = tableFrom(catalogs.flows);
  if (catalogs.agents.length > 0) index.agents = tableFrom(catalogs.agents);
  return index;
}
