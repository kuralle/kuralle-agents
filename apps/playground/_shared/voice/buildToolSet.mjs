import { tool as aiTool } from 'ai';

/** Build AI SDK ToolSet (schema-only) from defineTool-style effect tools. */
export function buildToolSet(tools) {
  const set = {};
  for (const [name, def] of Object.entries(tools)) {
    const toolName = def.name ?? name;
    const spec = { description: def.description };
    if (def.input) spec.inputSchema = def.input;
    set[toolName] = aiTool(spec);
  }
  return set;
}
