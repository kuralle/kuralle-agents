import type { ToolSet } from 'ai';
import type { ZodTypeAny } from 'zod';
import { z } from 'zod';
import type { GeminiFunctionDeclaration } from '../../capabilities/adapters/gemini.js';
import { toGeminiDeclarations } from '../../capabilities/adapters/gemini.js';
import type { ToolDeclaration } from '../../capabilities/index.js';
import type { ResolvedNode } from '../../types/channel.js';
import type { Tool, AnyTool } from '../../types/effectTool.js';
import { buildToolSet } from '../../tools/effect/defineTool.js';

function toolToDeclaration(name: string, tool: Tool): ToolDeclaration {
  return {
    name: tool.name || name,
    description: tool.description,
    parameters: (tool.input as ZodTypeAny | undefined) ?? z.object({}),
    execute: async () => ({}),
  };
}

export function v2ToolsToGemini(tools: Record<string, AnyTool>): GeminiFunctionDeclaration[] {
  const declarations = Object.entries(tools).map(([name, tool]) => toolToDeclaration(name, tool));
  return toGeminiDeclarations(declarations);
}

export function resolveVoiceGeminiTools(
  resolved: ResolvedNode,
  toolDefs: Record<string, AnyTool>,
): GeminiFunctionDeclaration[] {
  const merged: Record<string, AnyTool> = { ...toolDefs, ...(resolved.localTools ?? {}) };
  const fromNode = toolSetToEffectTools(resolved.tools);
  for (const [name, tool] of Object.entries(fromNode)) {
    if (!merged[name]) {
      merged[name] = tool;
    }
  }
  return v2ToolsToGemini(merged);
}

function toolSetToEffectTools(tools: ToolSet): Record<string, AnyTool> {
  const out: Record<string, AnyTool> = {};
  for (const [name, aiTool] of Object.entries(tools)) {
    const spec = aiTool as {
      description?: string;
      inputSchema?: ZodTypeAny;
    };
    out[name] = {
      name,
      description: spec.description ?? name,
      input: spec.inputSchema,
      execute: async () => ({}),
    };
  }
  return out;
}

export { buildToolSet };
