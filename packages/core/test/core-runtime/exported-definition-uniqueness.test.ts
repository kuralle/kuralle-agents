import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import * as ts from 'typescript';

const repositoryRoot = resolve(import.meta.dir, '../../../..');
const packagesRoot = resolve(repositoryRoot, 'packages');

interface DuplicateDefinition {
  files: string[];
  kind: 'export' | 'module-stem';
}

interface AllowlistedDuplicate extends DuplicateDefinition {
  reason: string;
}

const KNOWN_DUPLICATES: Record<string, AllowlistedDuplicate> = {
  AgentDefinition: {
    kind: 'export',
    files: [
      'packages/core/src/foundation/AgentDefinition.ts',
      'packages/core/src/prompts/types.ts',
    ],
    reason: 'Foundation and prompt-assembly contracts still share this public name; separate cleanup is out of scope.',
  },
  ChannelPolicy: {
    kind: 'export',
    files: ['packages/core/src/channels/types.ts', 'packages/engagement/src/policy.ts'],
    reason: 'Core and engagement expose distinct channel policy contracts; unification is out of scope.',
  },
  DeferReason: {
    kind: 'export',
    files: ['packages/engagement/src/strategist.ts', 'packages/messaging/src/types/outbound.ts'],
    reason: 'Engagement and messaging use distinct defer-reason contracts; unification is out of scope.',
  },
  HandoffInputData: {
    kind: 'export',
    files: ['packages/core/src/types/processors.ts', 'packages/core/src/runtime/handoffFilters.ts'],
    reason: 'The processor contract and runtime filter surface still duplicate this public name; separate cleanup is out of scope.',
  },
  HandoffInputFilter: {
    kind: 'export',
    files: ['packages/core/src/types/processors.ts', 'packages/core/src/runtime/handoffFilters.ts'],
    reason: 'The processor contract and runtime filter surface still duplicate this public name; separate cleanup is out of scope.',
  },
  HandoffInputResult: {
    kind: 'export',
    files: ['packages/core/src/types/processors.ts', 'packages/core/src/runtime/handoffFilters.ts'],
    reason: 'The processor contract and runtime filter surface still duplicate this public name; separate cleanup is out of scope.',
  },
  KnowledgeChunk: {
    kind: 'export',
    files: ['packages/core/src/types/knowledge.ts', 'packages/rag/src/types.ts'],
    reason: 'Core and RAG expose separate knowledge contracts with this shared name; unification is out of scope.',
  },
  PersonaConfig: {
    kind: 'export',
    files: ['packages/core/src/persona/types.ts', 'packages/messaging-meta/src/messenger/types.ts'],
    reason: 'Core persona and Messenger metadata expose distinct configuration contracts; unification is out of scope.',
  },
  PromptSection: {
    kind: 'export',
    files: ['packages/core/src/capabilities/index.ts', 'packages/core/src/prompts/types.ts'],
    reason: 'Capability and prompt-builder surfaces still expose different section contracts; separate cleanup is out of scope.',
  },
  RunContext: {
    kind: 'export',
    files: ['packages/core/src/types/run-context.ts', 'packages/core/src/types/session.ts'],
    reason: 'Execution and session context contracts still share this public name; separate cleanup is out of scope.',
  },
  SqlExecutor: {
    kind: 'export',
    files: ['packages/cf-agent/src/types.ts', 'packages/rag/src/sql.ts'],
    reason: 'Cloudflare and RAG define separate SQL adapter contracts; unification is out of scope.',
  },
  Tool: {
    kind: 'export',
    files: ['packages/core/src/tools/Tool.ts', 'packages/core/src/types/effectTool.ts'],
    reason: 'The legacy tool and effect-tool contracts remain separate public surfaces; unification is out of scope.',
  },
  ToolExecutor: {
    kind: 'module-stem',
    files: [
      'packages/core/src/foundation/ToolExecutor.ts',
      'packages/core/src/tools/effect/ToolExecutor.ts',
    ],
    reason: 'Foundation and effect executors share a public module basename; the separate architecture decision is out of scope.',
  },
  TracingConfig: {
    kind: 'export',
    files: ['packages/core/src/runtime/Runtime.ts', 'packages/core/src/types/telemetry.ts'],
    reason: 'Runtime and telemetry expose distinct tracing configuration contracts; unification is out of scope.',
  },
  TurnResult: {
    kind: 'export',
    files: ['packages/core/src/types/channel.ts', 'packages/messaging/src/inbound/types.ts'],
    reason: 'Core and messaging expose distinct turn-result contracts; unification is out of scope.',
  },
  defineSkill: {
    kind: 'export',
    files: ['packages/skills/src/defineSkill.ts', 'packages/fs/src/define-skill.ts'],
    reason: 'Skills and filesystem expose separate skill authoring helpers; unification is out of scope.',
  },
  isSkillStore: {
    kind: 'export',
    files: ['packages/core/src/skills/collectSkills.ts', 'packages/skills/src/toSkillStore.ts'],
    reason: 'Core and skills use separate skill-store protocols; unification is out of scope.',
  },
  ownershipGate: {
    kind: 'export',
    files: ['packages/engagement/src/ownership.ts', 'packages/messaging/src/inbound/pipeline.ts'],
    reason: 'Engagement and messaging expose separate ownership middleware; unification is out of scope.',
  },
  prepareSkillStore: {
    kind: 'export',
    files: ['packages/core/src/skills/collectSkills.ts', 'packages/skills/src/collectSkills.ts'],
    reason: 'Core and skills prepare separate skill-store implementations; unification is out of scope.',
  },
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(filePath);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [filePath] : [];
  });
}

function isDefinition(
  node: ts.Node,
): node is ts.ClassDeclaration | ts.EnumDeclaration | ts.FunctionDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration {
  return (
    ts.isClassDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node)
  ) && node.name !== undefined;
}

function publicEntryPoints(files: string[]): string[] {
  return files.filter((filePath) => /\/src\/(?:[^/]+\/)*index\.tsx?$/.test(filePath));
}

function duplicateDefinitions(): Map<string, DuplicateDefinition> {
  const files = readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const sourceRoot = resolve(packagesRoot, entry.name, 'src');
      try {
        return sourceFiles(sourceRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    });
  const program = ts.createProgram(files, {
    allowJs: false,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    target: ts.ScriptTarget.Latest,
  });
  const checker = program.getTypeChecker();
  const publicNames = new Set<string>();
  const definitions = new Map<string, Set<string>>();

  for (const entryPoint of publicEntryPoints(files)) {
    const sourceFile = program.getSourceFile(entryPoint);
    if (!sourceFile) throw new Error(`Missing source file for ${entryPoint}`);
    const module = checker.getSymbolAtLocation(sourceFile);
    if (!module) throw new Error(`Module symbol not found for ${entryPoint}`);

    for (const exported of checker.getExportsOfModule(module)) {
      publicNames.add(exported.name);
      const symbol = exported.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(exported)
        : exported;
      for (const declaration of symbol.declarations ?? []) {
        if (!isDefinition(declaration)) continue;
        const filePath = declaration.getSourceFile().fileName;
        if (!filePath.startsWith(`${packagesRoot}/`) || !filePath.includes('/src/')) continue;
        const name = exported.name;
        const paths = definitions.get(name) ?? new Set<string>();
        paths.add(relative(repositoryRoot, filePath));
        definitions.set(name, paths);
      }
    }
  }

  const duplicates = new Map<string, DuplicateDefinition>();
  for (const [name, paths] of definitions) {
    if (paths.size > 1) {
      duplicates.set(name, { kind: 'export', files: [...paths].sort() });
    }
  }

  const moduleStems = new Map<string, Set<string>>();
  for (const [name, paths] of definitions) {
    if (!publicNames.has(name)) continue;
    for (const filePath of paths) {
      const stem = basename(filePath).replace(/\.tsx?$/, '');
      const stemPaths = moduleStems.get(stem) ?? new Set<string>();
      stemPaths.add(filePath);
      moduleStems.set(stem, stemPaths);
    }
  }
  for (const [stem, paths] of moduleStems) {
    if (paths.size > 1 && publicNames.has(stem) && !duplicates.has(stem)) {
      duplicates.set(stem, { kind: 'module-stem', files: [...paths].sort() });
    }
  }

  return duplicates;
}

test('public source names have one definition unless explicitly tracked', () => {
  const detected = duplicateDefinitions();
  const expected = new Map(Object.entries(KNOWN_DUPLICATES));
  const unexpected = [...detected.keys()].filter((name) => !expected.has(name));
  const missingAllowlist = [...expected.keys()].filter((name) => !detected.has(name));

  expect({ unexpected, missingAllowlist }).toEqual({ unexpected: [], missingAllowlist: [] });
  const normalize = (entries: Iterable<[string, DuplicateDefinition]>) =>
    [...entries]
      .map(([name, duplicate]) => [
        name,
        { kind: duplicate.kind, files: [...duplicate.files].sort() },
      ] as const)
      .sort(([left], [right]) => left.localeCompare(right));
  expect(normalize(detected.entries())).toEqual(
    normalize([...expected.entries()].map(([name, duplicate]) => [name, duplicate])),
  );
});
