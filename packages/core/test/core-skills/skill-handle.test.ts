import { describe, expect, it } from 'bun:test';
import { buildAgentToolSurface } from '../../src/runtime/buildAgentToolSurface.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import {
  brandPackagedSkill,
  classifySkillFileKind,
  createSkillHandle,
  defineSkill,
  fsSkillStore,
  InlineSkillStore,
  packagedSkillStore,
  type SkillHandle,
} from '../../src/skills/index.js';
import { InMemoryFs } from '@kuralle-agents/fs';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function buildPackagedSkill(
  name: string,
  description: string,
  body: string,
  resources: Record<string, Uint8Array> = {},
) {
  const skillMd = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
  const files: Record<string, { path: string; encoding: 'base64'; kind: 'text' | 'binary'; content: string }> =
    Object.create(null);
  files['SKILL.md'] = {
    path: 'SKILL.md',
    encoding: 'base64',
    kind: 'text',
    content: bytesToBase64(new TextEncoder().encode(skillMd)),
  };
  for (const [path, bytes] of Object.entries(resources)) {
    files[path] = {
      path,
      encoding: 'base64',
      kind: classifySkillFileKind(bytes),
      content: bytesToBase64(bytes),
    };
  }
  return brandPackagedSkill({
    id: `skill:${name}:test`,
    name,
    description,
    files,
  });
}

type ForbiddenSkillHandleMutations = 'write' | 'delete';
type _SkillHandleIsReadOnly = {
  [K in ForbiddenSkillHandleMutations]: K extends keyof SkillHandle ? never : true;
};
const _skillHandleMutationGuard: _SkillHandleIsReadOnly[keyof _SkillHandleIsReadOnly] = true;
void _skillHandleMutationGuard;

describe('ctx.getSkill and SkillHandle', () => {
  it('reads packaged skill resources through the tool context', async () => {
    const packaged = buildPackagedSkill('packaged-x', 'Packaged.', 'Body.', {
      'references/a.json': new TextEncoder().encode('{"ok":true}'),
    });
    const { session } = await setupDurableHarness();
    const surface = await buildAgentToolSurface(
      { id: 'agent', instructions: 'test', skills: [packaged] },
      session,
      {},
    );
    expect(surface.getSkill).toBeDefined();

    const { session: ctxSession, runStore, runState } = await setupDurableHarness();
    const ctx = await createRunContext({
      session: ctxSession,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      getSkill: surface.getSkill,
    });

    const text = await ctx.getSkill('packaged-x').file('references/a.json').text();
    expect(text).toBe('{"ok":true}');
  });

  it('reads inline and filesystem-backed skill resources through the same handle', async () => {
    const inline = defineSkill({
      name: 'inline-x',
      description: 'Inline.',
      instructions: 'Inline body.',
      resources: { 'references/a.json': '{"inline":true}' },
    });
    const fs = new InMemoryFs({
      '/.agents/skills/fs-x/SKILL.md': `---
name: fs-x
description: Filesystem skill.
---

Fs body.`,
      '/.agents/skills/fs-x/references/a.json': '{"fs":true}',
    });
    const { session } = await setupDurableHarness();
    const surface = await buildAgentToolSurface(
      { id: 'agent', instructions: 'test', workspace: fs, skills: [inline, fsSkillStore(fs)] },
      session,
      {},
    );

    const { session: ctxSession, runStore, runState } = await setupDurableHarness();
    const ctx = await createRunContext({
      session: ctxSession,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      getSkill: surface.getSkill,
    });

    expect(await ctx.getSkill('inline-x').file('references/a.json').text()).toBe('{"inline":true}');
    expect(await ctx.getSkill('fs-x').file('references/a.json').text()).toBe('{"fs":true}');
  });

  it('rejects hostile resource paths before touching the store', () => {
    const store = new InlineSkillStore([
      { name: 'secure', description: 'Secure.', body: 'Body.', resources: { secret: 'nope' } },
    ]);
    const handle = createSkillHandle(store, 'secure');

    expect(() => handle.file('../secret')).toThrow(/Invalid resource path/);
    expect(() => handle.file('/etc/passwd')).toThrow(/Invalid resource path/);
    expect(() => handle.file('a\\b')).toThrow(/Invalid resource path/);
  });

  it('exposes only read-only members on the handle', () => {
    const store = new InlineSkillStore([
      { name: 'readonly', description: 'Read only.', body: 'Body.' },
    ]);
    const handle = createSkillHandle(store, 'readonly');

    expect(Object.keys(handle).sort()).toEqual(['file', 'name']);
    expect('write' in handle).toBe(false);
    expect('delete' in handle).toBe(false);
  });

  it('throws naming available skills for an unknown skill name', async () => {
    const { session } = await setupDurableHarness();
    const surface = await buildAgentToolSurface(
      {
        id: 'agent',
        instructions: 'test',
        skills: [
          defineSkill({ name: 'alpha', description: 'A', instructions: 'a' }),
          defineSkill({ name: 'beta', description: 'B', instructions: 'b' }),
        ],
      },
      session,
      {},
    );

    expect(() => surface.getSkill!('nope')).toThrow(
      'Skill "nope" is not available. Available skills: alpha, beta.',
    );
  });

  it('throws when getSkill is called on an agent with no skills configured', async () => {
    const { session, runStore, runState } = await setupDurableHarness();
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
    });

    expect(() => ctx.getSkill('anything')).toThrow('[skills] This agent has no skills configured.');
  });

  it('discovers the default .agents/skills root and ignores legacy /skills', async () => {
    const fs = new InMemoryFs({
      '/.agents/skills/foo/SKILL.md': `---
name: foo
description: Default root skill.
---

Foo body.`,
      '/skills/foo/SKILL.md': `---
name: foo
description: Legacy root skill.
---

Legacy body.`,
    });

    const store = fsSkillStore(fs);
    const metas = await store.list();
    expect(metas).toHaveLength(1);
    expect(metas[0]?.description).toBe('Default root skill.');
    expect(await store.loadBody('foo')).toBe('Foo body.');
  });

  it('still discovers an explicit custom root', async () => {
    const fs = new InMemoryFs({
      '/custom/foo/SKILL.md': `---
name: foo
description: Custom root skill.
---

Custom body.`,
    });

    const store = fsSkillStore(fs, ['/custom']);
    expect(await store.list()).toHaveLength(1);
    expect(await store.loadBody('foo')).toBe('Custom body.');
  });

  it('decodes text resources and encodes binary resources across store kinds', async () => {
    const binary = new Uint8Array([0xff, 0x00, 0x7f]);
    const packaged = buildPackagedSkill('codec', 'Codec.', 'Body.', {
      'references/text.txt': new TextEncoder().encode('hello'),
      'data.bin': binary,
    });
    const packagedHandle = createSkillHandle(packagedSkillStore([packaged]), 'codec');
    expect(await packagedHandle.file('references/text.txt').text()).toBe('hello');
    expect(await packagedHandle.file('data.bin').bytes()).toEqual(binary);
    expect(await packagedHandle.file('references/text.txt').bytes()).toEqual(
      new TextEncoder().encode('hello'),
    );

    const inline = new InlineSkillStore([
      {
        name: 'inline-codec',
        description: 'Inline codec.',
        body: 'Body.',
        resources: {
          'references/text.txt': 'hello',
          'data.bin': binary,
        },
      },
    ]);
    const inlineHandle = createSkillHandle(inline, 'inline-codec');
    expect(await inlineHandle.file('references/text.txt').text()).toBe('hello');
    expect(await inlineHandle.file('data.bin').bytes()).toEqual(binary);
  });
});
