import type { FileSystem, FlowDefinition, FlowRegistryIndex } from '@kuralle-agents/core';
import { flowDefinitionSchema, validateFlowDefinition } from '@kuralle-agents/core';
import { containsResolvedPath, normalizePath, resolvePath } from '@kuralle-agents/fs';
import { diagnostic as makeDiagnostic } from './diagnostics.js';
import type { Diagnostic } from './types.js';

const FLOWS_DIR = 'flows';
const FLOW_FILE_SUFFIX = '.flow.json';

export interface LoadFlowsResult {
  flows: FlowDefinition[];
  diagnostics: Diagnostic[];
}

function flowDiagnostic(rule: string, origin: string, message: string): Diagnostic {
  return makeDiagnostic('flows', rule, origin, message);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function schemaIssueMessage(parsed: ReturnType<typeof flowDefinitionSchema.safeParse>): string {
  if (parsed.success) {
    return 'flow envelope is invalid.';
  }
  const issue = parsed.error.issues[0];
  if (issue === undefined) {
    return 'flow envelope is invalid.';
  }
  const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
  return `${path}: ${issue.message}`;
}

/**
 * Build the registry index used to validate plugin flows.
 *
 * `tools` is omitted when the caller did not name host tools. An empty
 * `tools: {}` would fail every action node; an absent kind skips that check
 * class. MCP server names join the index only once the kind is present, as
 * prospective tools the plugin itself declared.
 */
export function pluginFlowRegistryIndex(
  hostTools: readonly string[] | undefined,
  mcpServerNames: readonly string[],
): FlowRegistryIndex {
  if (hostTools === undefined) {
    return {};
  }

  const tools: NonNullable<FlowRegistryIndex['tools']> = {};
  for (const name of hostTools) {
    tools[name] = {};
  }
  for (const name of mcpServerNames) {
    tools[name] = {};
  }
  return { tools };
}

function toPluginRelative(pluginRoot: string, absolutePath: string): string {
  const normalizedRoot = normalizePath(pluginRoot);
  const normalizedPath = normalizePath(absolutePath);
  if (normalizedPath === normalizedRoot) {
    return '.';
  }
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  return normalizedPath;
}

function isFlowFileName(name: string): boolean {
  return name.endsWith(FLOW_FILE_SUFFIX);
}

async function loadOneFlowFile(
  fs: FileSystem,
  pluginRoot: string,
  flowPath: string,
  origin: string,
  index: FlowRegistryIndex,
): Promise<{ flow?: FlowDefinition; diagnostic?: Diagnostic }> {
  if (!(await containsResolvedPath(fs, pluginRoot, flowPath))) {
    return {
      diagnostic: flowDiagnostic(
        'path-escapes-plugin-root',
        origin,
        `${origin} resolves outside the plugin root.`,
      ),
    };
  }

  let text: string;
  try {
    text = await fs.readFile(flowPath);
  } catch (err) {
    return {
      diagnostic: flowDiagnostic(
        'flow-unreadable',
        origin,
        `${origin} could not be read: ${errorMessage(err)}`,
      ),
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return {
      diagnostic: flowDiagnostic(
        'flow-invalid-json',
        origin,
        `${origin} is not valid JSON: ${errorMessage(err)}`,
      ),
    };
  }

  const envelope = flowDefinitionSchema.safeParse(json);
  if (!envelope.success) {
    return {
      diagnostic: flowDiagnostic(
        'flow-schema-invalid',
        origin,
        `${origin} failed the flow envelope schema: ${schemaIssueMessage(envelope)}`,
      ),
    };
  }

  const def: FlowDefinition = envelope.data;
  let issues;
  try {
    issues = validateFlowDefinition(def, index);
  } catch (err) {
    return {
      diagnostic: flowDiagnostic(
        'flow-invalid',
        origin,
        `${origin} failed validation: ${errorMessage(err)}`,
      ),
    };
  }

  if (issues.length === 0) {
    return { flow: def };
  }

  const missing = issues.find((issue) => issue.code === 'missing-reference');
  const primary = missing ?? issues[0];
  if (primary === undefined) {
    return { flow: def };
  }
  const extra =
    issues.length > 1 ? ` (+${issues.length - 1} more)` : '';
  return {
    diagnostic: flowDiagnostic(
      primary.code,
      origin,
      `${origin}: ${primary.message} (${primary.path})${extra}`,
    ),
  };
}

export async function loadFlowsComponent(
  fs: FileSystem,
  pluginRoot: string,
  index: FlowRegistryIndex,
): Promise<LoadFlowsResult> {
  const flowsPath = resolvePath(pluginRoot, FLOWS_DIR);

  if (!(await fs.exists(flowsPath))) {
    return { flows: [], diagnostics: [] };
  }

  if (!(await containsResolvedPath(fs, pluginRoot, flowsPath))) {
    return {
      flows: [],
      diagnostics: [
        flowDiagnostic(
          'path-escapes-plugin-root',
          FLOWS_DIR,
          `${FLOWS_DIR} resolves outside the plugin root.`,
        ),
      ],
    };
  }

  let stat;
  try {
    stat = await fs.stat(flowsPath);
  } catch (err) {
    return {
      flows: [],
      diagnostics: [
        flowDiagnostic(
          'flow-unreadable',
          FLOWS_DIR,
          `${FLOWS_DIR} could not be read: ${errorMessage(err)}`,
        ),
      ],
    };
  }

  if (stat.type !== 'directory') {
    return {
      flows: [],
      diagnostics: [
        flowDiagnostic(
          'component-location-wrong-kind',
          FLOWS_DIR,
          `${FLOWS_DIR} is not a directory.`,
        ),
      ],
    };
  }

  let entries: string[];
  try {
    entries = await fs.readdir(flowsPath);
  } catch (err) {
    return {
      flows: [],
      diagnostics: [
        flowDiagnostic(
          'flow-unreadable',
          FLOWS_DIR,
          `${FLOWS_DIR} could not be listed: ${errorMessage(err)}`,
        ),
      ],
    };
  }

  const flows: FlowDefinition[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const entry of [...entries].sort()) {
    if (!isFlowFileName(entry)) continue;

    const flowPath = resolvePath(flowsPath, entry);
    const origin = toPluginRelative(pluginRoot, flowPath);

    let loaded: { flow?: FlowDefinition; diagnostic?: Diagnostic };
    try {
      loaded = await loadOneFlowFile(fs, pluginRoot, flowPath, origin, index);
    } catch (err) {
      diagnostics.push(
        flowDiagnostic(
          'flow-invalid',
          origin,
          `${origin} failed to load: ${errorMessage(err)}`,
        ),
      );
      continue;
    }

    if (loaded.diagnostic) {
      diagnostics.push(loaded.diagnostic);
      continue;
    }
    if (loaded.flow) {
      flows.push(loaded.flow);
    }
  }

  return { flows, diagnostics };
}
