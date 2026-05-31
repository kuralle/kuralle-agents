#!/usr/bin/env node
/**
 * create-kuralle-agents — scaffold a new Kuralle project from a template.
 *
 * Templates are fetched from the public `kuralle/starter` repo (via giget),
 * pinned to the `vMAJOR.MINOR` tag that matches this CLI's own version — so a
 * given create-kuralle-agents always pulls a compatible template set.
 *
 *   npm create kuralle-agents@latest [dir] [--template <id>]
 */
import { downloadTemplate } from '@bluwy/giget-core';
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import pc from 'picocolors';

const here = dirname(fileURLToPath(import.meta.url));

const { version } = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version: string };
const [major, minor] = version.split('.');
const STARTER_REPO = 'kuralle/starter';
const STARTER_REF = `v${major}.${minor}`;

type ManifestEntry = { id: string; title: string; description: string };

// Offline fallback for the picker. The live manifest from the starter repo is
// preferred (new templates show up without a CLI release); this list only kicks
// in when GitHub is unreachable.
const FALLBACK_MANIFEST: ManifestEntry[] = [
  {
    id: 'nextjs-chatbot',
    title: 'Next.js Chatbot',
    description: 'A Next.js chat app wired to a Kuralle agent — streaming UI, thread history, and Postgres-ready persistence.',
  },
];

async function loadManifest(): Promise<ManifestEntry[]> {
  try {
    const url = `https://raw.githubusercontent.com/${STARTER_REPO}/${STARTER_REF}/manifest.json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) return (await res.json()) as ManifestEntry[];
  } catch {
    // offline / network error — fall through to the bundled fallback
  }
  return FALLBACK_MANIFEST;
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
  return readdirSync(dir).filter((e) => e !== '.git').length === 0;
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

Templates are fetched from ${pc.cyan(`github.com/${STARTER_REPO}`)} (${STARTER_REF}).
`);
    return;
  }

  p.intro(pc.bgCyan(pc.black(' create-kuralle-agents ')));

  const templates = await loadManifest();

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

  // 3. Fetch + scaffold
  const s = p.spinner();
  s.start(`Fetching ${pc.cyan(templateId)} from ${pc.dim(`${STARTER_REPO}#${STARTER_REF}`)}`);
  try {
    await downloadTemplate(`gh:${STARTER_REPO}/${templateId}#${STARTER_REF}`, {
      dir: targetPath,
      force: true,
    });
  } catch (err) {
    s.stop(pc.red('Download failed'));
    bail(
      `Could not fetch the template from github.com/${STARTER_REPO} (${STARTER_REF}).\n` +
        `${(err as Error).message}\n\n` +
        `Check your network connection, or browse templates at https://github.com/${STARTER_REPO}.`,
    );
  }

  // npm/git tooling strips a real .gitignore, so templates store it as _gitignore — restore it.
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
