import { dirname, relative, resolve, sep } from 'node:path';
import type { CompiledAgentProject } from './types.js';

function moduleSpecifier(
  generatedFile: string,
  sourcePath: string,
  importMode: 'relative' | 'absolute',
): string {
  if (importMode === 'absolute') return resolve(sourcePath).split(sep).join('/');
  let path = relative(dirname(generatedFile), sourcePath).split(sep).join('/');
  if (!path.startsWith('.')) path = `./${path}`;
  return path;
}

function literal(value: string): string {
  return JSON.stringify(value);
}

/**
 * Generate the only dynamic-looking part of a deployment as static imports.
 * A normal bundler then proves target compatibility and packages the modules.
 */
export function generateCapabilityRegistrySource(
  project: CompiledAgentProject,
  options: { generatedFile: string; importMode?: 'relative' | 'absolute' },
): string {
  const modules = [...project.modules].sort((a, b) => a.capability.localeCompare(b.capability));
  const imports = modules.map((module, index) => {
    const specifier = literal(moduleSpecifier(
      options.generatedFile,
      module.sourcePath,
      options.importMode ?? 'relative',
    ));
    return module.exportName === 'default'
      ? `import capability${index} from ${specifier};`
      : `import { ${module.exportName} as capability${index} } from ${specifier};`;
  });
  const registrations = modules.map((module, index) => {
    const entry = `{ id: ${literal(module.capability)}, version: ${literal(module.version)}, value: capability${index} }`;
    if (module.kind === 'tool') return `  bindings.tools.register(${entry});`;
    if (module.kind === 'flow') return `  bindings.flows.register(${entry});`;
    const registry = {
      input: 'inputPolicies',
      output: 'outputPolicies',
      tool: 'toolPolicies',
      refine: 'refiners',
      validate: 'validators',
    }[module.id];
    if (!registry) throw new Error(`unsupported policy module id ${module.id}`);
    return [
      `  if (!bindings.${registry}) throw new Error(${literal(`missing ${registry} registry`)});`,
      `  bindings.${registry}.register(${entry});`,
    ].join('\n');
  });
  const manifest = modules.map(module => ({ id: module.capability, version: module.version }));
  return [
    "import type { RuntimeBindings } from '@kuralle-agents/deployment';",
    ...imports,
    '',
    `export const runtimeCapabilities = ${JSON.stringify(manifest, null, 2)} as const;`,
    '',
    'export function registerGeneratedCapabilities(bindings: RuntimeBindings): void {',
    ...registrations,
    '}',
    '',
  ].join('\n');
}
