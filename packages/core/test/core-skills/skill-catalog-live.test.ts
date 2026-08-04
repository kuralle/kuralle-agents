import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { composePolicies, needsApprovalPolicy } from '../../src/runtime/policies/toolPolicy.js';
import { defineTool } from '../../src/tools/effect/defineTool.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { wireAgentSkills } from '../../src/skills/wireAgentSkills.js';
import { skillRestrictionPolicy, type SkillActivation } from '../../src/skills/skillActivation.js';
import { ToolApprovalDeniedError } from '../../src/tools/effect/errors.js';
import { systemNoteBlocks } from '../../src/runtime/systemNotes.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';

// a5-catalog: the frozen `skillPrompt` baseline vs the live catalog `load_skill` resolves
// against. These tests exercise `ctx.addSkill` / `ctx.removeSkill` end to end through a real
// `createRunContext`, matching the harness pattern `skill-allowed-tools.test.ts` (a3) uses.

const alpha = defineTool({
  name: 'alpha',
  description: 'alpha',
  input: z.object({}),
  execute: async () => ({ ok: true }),
});
const beta = defineTool({
  name: 'beta',
  description: 'beta',
  input: z.object({}),
  execute: async () => ({ ok: true }),
});

async function setup(sessionId: string) {
  const agent = {
    id: 'catalog-agent',
    instructions: 'test',
    tools: { alpha, beta },
    skills: [{ name: 'existing', description: 'Existing baseline skill.', body: 'Existing body.' }],
  };
  const wired = await wireAgentSkills(agent);
  if (!wired) throw new Error('expected skills to wire');

  const { session, runStore, runState } = await setupDurableHarness(sessionId, `${sessionId}-run`);
  const skillActivations: SkillActivation[] = [];
  const executor = new CoreToolExecutor({ tools: { ...wired.tools, alpha, beta } });
  const skillMetaByName = new Map(wired.metas.map((meta) => [meta.name, meta]));

  const ctx = await createRunContext({
    session,
    runStore,
    runState,
    steps: [],
    toolExecutor: executor,
    model: stubModel,
    emit: () => {},
    policy: composePolicies(skillRestrictionPolicy(() => skillActivations), needsApprovalPolicy),
    skillActivations,
    skillMetaByName,
    skillCatalog: wired.catalog,
    getSkill: wired.getSkill,
  });
  ctx.skillPrompt = wired.promptSections.map((s) => s.content).join('\n\n');

  return { ctx, runStore, runState };
}

describe('live skill catalog (a5)', () => {
  it('adding a skill mid-session appends exactly one context message naming it, and skillPrompt stays byte-identical', async () => {
    const { ctx } = await setup('a5-t1');
    const before = ctx.skillPrompt;

    await ctx.addSkill({ name: 'added', description: 'Newly added skill.', body: 'Do the thing.' });

    const notes = systemNoteBlocks(ctx.runState);
    expect(notes.length).toBe(1);
    expect(notes[0]).toBe(
      [
        'The skills available in this run changed.',
        'Newly available — call load_skill by name when the description matches:',
        '- added: Newly added skill.',
        'Current available skills: added, existing',
      ].join('\n'),
    );
    // The frozen baseline the prompt was built from must not move: only a system note
    // (delivered out of band, see systemNotes.ts) announces the change.
    expect(ctx.skillPrompt).toBe(before);
  });

  it('load_skill resolves a skill added after the baseline was frozen', async () => {
    const { ctx } = await setup('a5-t2');
    await ctx.addSkill({ name: 'added', description: 'Newly added skill.', body: 'Do the thing.' });

    const result = await ctx.tool('load_skill', { name: 'added' });
    expect(result).toContain('<skill_instructions>');
    expect(result).toContain('Do the thing.');
  });

  it('removing a skill announces the withdrawal, and load_skill then returns the not-available miss, not a throw', async () => {
    const { ctx } = await setup('a5-t3');

    await ctx.removeSkill('existing');

    const notes = systemNoteBlocks(ctx.runState);
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain('No longer available — do not call load_skill for these:');
    expect(notes[0]).toContain('- existing');
    expect(notes[0]).toContain('No skills are currently available.');

    const result = await ctx.tool('load_skill', { name: 'existing' });
    expect(result).toBe('Skill "existing" is not available. No skills are available.');
  });

  it('re-running the same change does not re-announce', async () => {
    const { ctx, runStore } = await setup('a5-t4');

    let putCount = 0;
    const originalPut = runStore.putRunState.bind(runStore);
    runStore.putRunState = async (state: Parameters<typeof originalPut>[0]) => {
      putCount += 1;
      return originalPut(state);
    };

    const skill = { name: 'added', description: 'Newly added skill.', body: 'Do the thing.' };
    await ctx.addSkill(skill);
    expect(putCount).toBe(1);
    const notesAfterFirst = systemNoteBlocks(ctx.runState);
    expect(notesAfterFirst.length).toBe(1);

    // Re-run the identical add (e.g. a replayed effect). Nothing moved relative to the
    // last-announced snapshot, so this must not commit a second write or a second note.
    await ctx.addSkill({ ...skill });
    expect(putCount).toBe(1);
    expect(systemNoteBlocks(ctx.runState)).toEqual(notesAfterFirst);
  });

  it('a skill added mid-session that declares allowed-tools still restricts once activated (composes with a3)', async () => {
    const { ctx } = await setup('a5-t5');

    await ctx.addSkill({
      name: 'bounded-added',
      description: 'Bounded mid-session skill.',
      body: 'Use alpha only.',
      allowedTools: ['alpha'],
    });

    await ctx.tool('load_skill', { name: 'bounded-added' });
    expect(ctx.skillActivations).toEqual([{ name: 'bounded-added', allowedTools: ['alpha'] }]);

    await expect(ctx.tool('beta', {})).rejects.toBeInstanceOf(ToolApprovalDeniedError);
    expect(await ctx.tool('alpha', {})).toEqual({ ok: true });
  });
});
