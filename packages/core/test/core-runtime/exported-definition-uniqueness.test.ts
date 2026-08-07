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

/**
 * **Empty, and worth keeping empty.**
 *
 * Every entry that used to sit here has been resolved rather than excused — most
 * of them by deleting code that was exported and reachable by nobody, which is
 * what a duplicate name usually turns out to be pointing at.
 *
 * The check is bidirectional, so this list cannot rot in either direction: a new
 * duplicate fails immediately, and an entry that no longer describes a real
 * duplicate fails too. Adding an entry is therefore a deliberate act with a
 * stated reason, not a way to quiet the suite — if you are reaching for one,
 * first check whether one of the two definitions has any caller at all.
 */
const KNOWN_DUPLICATES: Record<string, AllowlistedDuplicate> = {};

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

/**
 * The package a path belongs to — `packages/<name>/...` → `<name>`.
 *
 * Detection is keyed on the package of the **entry point**, not of the
 * declaration, and that is the whole point of the scoping (see the header).
 * A name is only ambiguous if two definitions are reachable from one package's
 * public surface. Two packages using the same word for different contracts is
 * normal and unreachable by accident: a consumer writes
 * `from '@kuralle-agents/rag'` and gets exactly rag's.
 *
 * Keying on the entry point also covers the re-export case without a special
 * branch: if package A re-exports B's symbol into A's index while A also
 * defines its own, both declarations land in A's bucket — even though one of
 * them lives under `packages/b/src/` — so A's surface is reported as ambiguous.
 * No package does this today; the guard catches the first one that tries.
 *
 * That only works because of the `paths` mapping on the program options below.
 * Without it the specifier does not resolve, the aliased symbol has no
 * declarations, and this case is invisible — which is what the guard did before
 * the mapping was added, and it passed a planted re-export silently. The two
 * changes are one mechanism; do not remove the mapping and leave this comment.
 */
function packageOf(filePath: string): string {
  const rel = relative(packagesRoot, filePath);
  const [pkg] = rel.split('/');
  return pkg ?? '';
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
    // Resolve workspace specifiers to each package's `src`, not its published
    // `dist`. Without this, `@kuralle-agents/rag` does not resolve at all here
    // (verified: `ts.resolveModuleName` returns undefined), so a package
    // re-exporting another's symbol into its own index produced a symbol with
    // no declarations and the guard saw nothing. Mapping to `src` also keeps
    // the reported paths in the same shape as every other entry, and means the
    // guard does not depend on anything having been built.
    baseUrl: repositoryRoot,
    paths: { '@kuralle-agents/*': ['packages/*/src/index.ts'] },
  });
  const checker = program.getTypeChecker();
  // Both maps are keyed per package, so a name is only compared against other
  // definitions reachable from the SAME package's public surface.
  const publicNames = new Map<string, Set<string>>();
  const definitions = new Map<string, Map<string, Set<string>>>();

  const bucket = <T>(map: Map<string, Map<string, T>>, pkg: string): Map<string, T> => {
    let inner = map.get(pkg);
    if (!inner) {
      inner = new Map();
      map.set(pkg, inner);
    }
    return inner;
  };

  for (const entryPoint of publicEntryPoints(files)) {
    const sourceFile = program.getSourceFile(entryPoint);
    if (!sourceFile) throw new Error(`Missing source file for ${entryPoint}`);
    const module = checker.getSymbolAtLocation(sourceFile);
    if (!module) throw new Error(`Module symbol not found for ${entryPoint}`);
    const pkg = packageOf(entryPoint);

    const pkgNames = publicNames.get(pkg) ?? new Set<string>();
    publicNames.set(pkg, pkgNames);
    const pkgDefinitions = bucket(definitions, pkg);

    for (const exported of checker.getExportsOfModule(module)) {
      pkgNames.add(exported.name);
      const symbol = exported.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(exported)
        : exported;
      for (const declaration of symbol.declarations ?? []) {
        if (!isDefinition(declaration)) continue;
        const filePath = declaration.getSourceFile().fileName;
        if (!filePath.startsWith(`${packagesRoot}/`) || !filePath.includes('/src/')) continue;
        const name = exported.name;
        const paths = pkgDefinitions.get(name) ?? new Set<string>();
        paths.add(relative(repositoryRoot, filePath));
        pkgDefinitions.set(name, paths);
      }
    }
  }

  const duplicates = new Map<string, DuplicateDefinition>();
  // Merged across packages when reporting, because KNOWN_DUPLICATES is keyed by
  // bare name. Two packages each having their own internal duplicate of the same
  // name would collapse into one entry listing all the files — honest, if
  // cramped. It does not occur today; the `files` list disambiguates if it does.
  const record = (name: string, kind: DuplicateDefinition['kind'], paths: Iterable<string>) => {
    const existing = duplicates.get(name);
    const files = new Set(existing?.files ?? []);
    for (const p of paths) files.add(p);
    duplicates.set(name, { kind: existing?.kind ?? kind, files: [...files].sort() });
  };

  for (const pkgDefinitions of definitions.values()) {
    for (const [name, paths] of pkgDefinitions) {
      if (paths.size > 1) record(name, 'export', paths);
    }
  }

  for (const [pkg, pkgDefinitions] of definitions) {
    const pkgNames = publicNames.get(pkg) ?? new Set<string>();
    const moduleStems = new Map<string, Set<string>>();
    for (const [name, paths] of pkgDefinitions) {
      if (!pkgNames.has(name)) continue;
      for (const filePath of paths) {
        const stem = basename(filePath).replace(/\.tsx?$/, '');
        const stemPaths = moduleStems.get(stem) ?? new Set<string>();
        stemPaths.add(filePath);
        moduleStems.set(stem, stemPaths);
      }
    }
    for (const [stem, paths] of moduleStems) {
      if (paths.size > 1 && pkgNames.has(stem) && !duplicates.has(stem)) {
        record(stem, 'module-stem', paths);
      }
    }
  }

  return duplicates;
}

// This walks and parses every public source file, so it is inherently slow —
// measured at ~11 s under full parallel suite load against bun's 5 s default,
// which made it an intermittent red with no assertion actually failing. The
// budget is explicit rather than the default so a genuine hang still fails.
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
}, 60_000);
