#!/usr/bin/env node
/**
 * create-kuralle-agents — scaffold a new Kuralle project from a bundled template.
 *
 *   npm create kuralle-agents@latest [dir] [--template <id>]
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import pc from 'picocolors';

const here = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(here, '..', 'templates');

type ManifestEntry = { id: string; title: string; description: string };

function loadManifest(): ManifestEntry[] {
  const file = join(templatesDir, 'manifest.json');
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, 'utf8')) as ManifestEntry[];
}

function parseArgs(argv: string[]): { dir?: string; template?: string; help: boolean } {
  let dir: string | undefined;
  let template: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') help = true;
    else if (a === '--template' || a === '-t') template = argv[++i];
    else if (a.startsWith('--template=')) template = a.slice('--template='.length);
    else if (!a.startsWith('-') && !dir) dir = a;
  }
  return { dir, template, help };
}

function isEmptyDir(dir: string): boolean {
  if (!existsSync(dir)) return true;
  const entries = readdirSync(dir).filter((e) => e !== '.git');
  return entries.length === 0;
}

function bail(message: string): never {
  p.cancel(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const { dir, template, help } = parseArgs(process.argv.slice(2));

  if (help) {
    console.log(`
${pc.bold('create-kuralle-agents')} — scaffold a new Kuralle project

  ${pc.cyan('npm create kuralle-agents@latest')} ${pc.dim('[dir] [--template <id>]')}

Options:
  -t, --template <id>   Template to use (skips the picker)
  -h, --help            Show this help
`);
    return;
  }

  const templates = loadManifest();
  if (templates.length === 0) bail('No templates are bundled with this build of create-kuralle-agents.');

  p.intro(pc.bgCyan(pc.black(' create-kuralle-agents ')));

  // 1. Project directory
  let targetDir = dir;
  if (!targetDir) {
    const answer = await p.text({
      message: 'Where should we create your project?',
      placeholder: 'my-kuralle-app',
      defaultValue: 'my-kuralle-app',
    });
    if (p.isCancel(answer)) bail('Cancelled.');
    targetDir = (answer as string) || 'my-kuralle-app';
  }
  const targetPath = resolve(process.cwd(), targetDir);
  const projectName = basename(targetPath);

  if (!isEmptyDir(targetPath)) {
    const overwrite = await p.confirm({
      message: `${pc.yellow(targetDir)} is not empty. Continue anyway?`,
      initialValue: false,
    });
    if (p.isCancel(overwrite) || !overwrite) bail('Cancelled.');
  }

  // 2. Template
  let templateId = template;
  if (templateId && !templates.some((t) => t.id === templateId)) {
    bail(`Unknown template "${templateId}". Available: ${templates.map((t) => t.id).join(', ')}`);
  }
  if (!templateId) {
    const choice = await p.select({
      message: 'Pick a template',
      options: templates.map((t) => ({ value: t.id, label: t.title, hint: t.description })),
    });
    if (p.isCancel(choice)) bail('Cancelled.');
    templateId = choice as string;
  }

  // 3. Scaffold
  const s = p.spinner();
  s.start(`Creating ${pc.cyan(projectName)} from ${pc.cyan(templateId)}`);

  const src = join(templatesDir, templateId);
  mkdirSync(targetPath, { recursive: true });
  cpSync(src, targetPath, {
    recursive: true,
    filter: (from) => basename(from) !== 'manifest.json',
  });

  // npm strips .gitignore from tarballs, so templates store it as _gitignore — restore it.
  const gi = join(targetPath, '_gitignore');
  if (existsSync(gi)) renameSync(gi, join(targetPath, '.gitignore'));

  // Set the package name to the project directory name.
  const pkgPath = join(targetPath, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
    pkg.name = projectName;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  }

  s.stop(`Created ${pc.cyan(projectName)}`);

  p.note(
    [
      `${pc.dim('cd')} ${targetDir}`,
      `${pc.dim('npm install')}`,
      `${pc.dim('cp')} .env.example .env  ${pc.dim('# add your OPENAI_API_KEY')}`,
      `${pc.dim('npm run dev')}`,
    ].join('\n'),
    'Next steps',
  );

  p.outro(`Done. Happy building with ${pc.cyan('Kuralle')}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
