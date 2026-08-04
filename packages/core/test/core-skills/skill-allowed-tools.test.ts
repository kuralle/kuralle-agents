import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import {
  ALLOW,
  composePolicies,
  needsApprovalPolicy,
  type Policy,
} from '../../src/runtime/policies/toolPolicy.js';
import { defineTool } from '../../src/tools/effect/defineTool.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { wireAgentSkills } from '../../src/skills/wireAgentSkills.js';
import { collectRegisteredNames } from '../../src/skills/collectSkills.js';
import { defineSkill } from '../../src/skills/defineSkill.js';
import {
  permittedToolNames,
  recordSkillActivation,
  resetSkillActivations,
  resetSkillActivationsOnTurnStart,
  skillRestrictionPolicy,
  type SkillActivation,
} from '../../src/skills/skillActivation.js';
import { ToolApprovalDeniedError } from '../../src/tools/effect/errors.js';
import { setupDurableHarness } from '../core-durable/helpers.js';

function restrictionPolicy(active: SkillActivation[]): Policy {
  return skillRestrictionPolicy(() => active);
}

async function decide(
  policy: Policy,
  toolName: string,
  def?: ReturnType<typeof defineTool>,
) {
  return policy.decide({ toolName, args: {}, def });
}

describe('skill allowed-tools policy', () => {
  it('no active skill → every tool allowed', async () => {
    const active: SkillActivation[] = [];
    const policy = restrictionPolicy(active);
    expect(await decide(policy, 'alpha')).toEqual(ALLOW);
    expect(await decide(policy, 'beta')).toEqual(ALLOW);
    expect(permittedToolNames(active)).toBeNull();
  });

  it('active skill declaring alpha → calling beta is denied, reason names alpha', async () => {
    const active: SkillActivation[] = [{ name: 'refunds', allowedTools: ['alpha'] }];
    const policy = restrictionPolicy(active);
    const verdict = await decide(policy, 'beta');
    expect(verdict.kind).toBe('deny');
    if (verdict.kind === 'deny') {
      expect(verdict.reason).toContain('alpha');
      expect(verdict.reason).toContain('refunds');
    }
  });

  it('active skill declaring alpha → calling alpha is allowed', async () => {
    const active: SkillActivation[] = [{ name: 'refunds', allowedTools: ['alpha'] }];
    const policy = restrictionPolicy(active);
    expect(await decide(policy, 'alpha')).toEqual(ALLOW);
  });

  it('active skill declaring alpha → load_skill and read_skill_resource still allowed', async () => {
    const active: SkillActivation[] = [{ name: 'refunds', allowedTools: ['alpha'] }];
    const policy = restrictionPolicy(active);
    expect(await decide(policy, 'load_skill')).toEqual(ALLOW);
    expect(await decide(policy, 'read_skill_resource')).toEqual(ALLOW);
  });

  it('two active skills declaring alpha and beta → both permitted', async () => {
    const active: SkillActivation[] = [
      { name: 'skill-a', allowedTools: ['alpha'] },
      { name: 'skill-b', allowedTools: ['beta'] },
    ];
    const policy = restrictionPolicy(active);
    expect(await decide(policy, 'alpha')).toEqual(ALLOW);
    expect(await decide(policy, 'beta')).toEqual(ALLOW);
    const permitted = permittedToolNames(active);
    expect(permitted?.has('alpha')).toBe(true);
    expect(permitted?.has('beta')).toBe(true);
  });

  it('skill declaring alpha + skill declaring nothing → still restricted to alpha', async () => {
    const active: SkillActivation[] = [
      { name: 'bounded', allowedTools: ['alpha'] },
      { name: 'free' },
    ];
    const permitted = permittedToolNames(active);
    expect(permitted).not.toBeNull();
    expect(permitted?.has('alpha')).toBe(true);
    expect(permitted?.has('beta')).toBe(false);

    const policy = restrictionPolicy(active);
    const verdict = await decide(policy, 'beta');
    expect(verdict.kind).toBe('deny');
  });

  it('allowed-tools skill loaded but turn ended → no longer restricting', async () => {
    const active: SkillActivation[] = [{ name: 'refunds', allowedTools: ['alpha'] }];
    const policy = restrictionPolicy(active);
    expect((await decide(policy, 'beta')).kind).toBe('deny');

    resetSkillActivations(active);
    expect(await decide(policy, 'beta')).toEqual(ALLOW);
    expect(permittedToolNames(active)).toBeNull();
  });

  it('agent policy that asks for a permitted tool still asks — composition did not swallow it', async () => {
    const active: SkillActivation[] = [{ name: 'refunds', allowedTools: ['alpha'] }];
    const askAlpha: Policy = {
      decide: ({ toolName }) =>
        toolName === 'alpha' ? { kind: 'ask', title: 'Confirm alpha' } : ALLOW,
    };
    const policy = composePolicies(restrictionPolicy(active), askAlpha);
    const verdict = await decide(policy, 'alpha');
    expect(verdict.kind).toBe('ask');
  });

  it('agent policy that denies is not overridden by skill policy allowing it', async () => {
    const active: SkillActivation[] = [{ name: 'refunds', allowedTools: ['alpha'] }];
    const denyAlpha: Policy = {
      decide: ({ toolName }) =>
        toolName === 'alpha' ? { kind: 'deny', reason: 'agent blocked alpha' } : ALLOW,
    };
    const policy = composePolicies(restrictionPolicy(active), denyAlpha);
    const verdict = await decide(policy, 'alpha');
    expect(verdict.kind).toBe('deny');
    if (verdict.kind === 'deny') {
      expect(verdict.reason).toBe('agent blocked alpha');
    }
  });

  it('load_skill with allowed-tools activates restriction at the tool boundary', async () => {
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

    const agent = {
      id: 'skills-agent',
      instructions: 'test',
      tools: { alpha, beta },
      skills: [
        {
          name: 'bounded',
          description: 'Bounded skill.',
          body: 'Use alpha only.',
          allowedTools: ['alpha'],
        },
      ],
    };

    const wired = await wireAgentSkills(agent);
    expect(wired).toBeDefined();

    const { session, runStore, runState } = await setupDurableHarness('skill-bound-sess', 'skill-bound-run');

    const skillActivations: SkillActivation[] = [];
    const executor = new CoreToolExecutor({ tools: { ...wired!.tools, alpha, beta } });
    const skillMetaByName = new Map(wired!.metas.map((meta) => [meta.name, meta]));
    const policy = composePolicies(
      skillRestrictionPolicy(() => skillActivations),
      needsApprovalPolicy,
    );

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: executor,
      model: {} as import('ai').LanguageModel,
      emit: () => {},
      policy,
      skillActivations,
      skillMetaByName,
      getSkill: wired!.getSkill,
    });

    await ctx.tool('load_skill', { name: 'bounded' });
    expect(skillActivations).toEqual([{ name: 'bounded', allowedTools: ['alpha'] }]);

    await expect(ctx.tool('beta', {})).rejects.toBeInstanceOf(ToolApprovalDeniedError);
    const alphaResult = await ctx.tool('alpha', {});
    expect(alphaResult).toEqual({ ok: true });
  });
});

describe('defineSkill allowed-tools authoring (F2)', () => {
  it('rejects allowedTools: [] — ambiguous (means unrestricted, not "no tools")', () => {
    expect(() =>
      defineSkill({
        name: 'ambiguous',
        description: 'd',
        instructions: 'b',
        allowedTools: [],
      }),
    ).toThrow(/allowedTools: \[\].*ambiguous/i);
  });

  it('the rejection message names both intents', () => {
    expect(() =>
      defineSkill({
        name: 'ambiguous',
        description: 'd',
        instructions: 'b',
        allowedTools: [],
      }),
    ).toThrow(/Omit the field.*list the tools/s);
  });

  it('omitting allowedTools is allowed (no restriction)', () => {
    expect(() =>
      defineSkill({ name: 'free', description: 'd', instructions: 'b' }),
    ).not.toThrow();
  });

  it('a non-empty allowedTools list is allowed', () => {
    expect(() =>
      defineSkill({
        name: 'bounded',
        description: 'd',
        instructions: 'b',
        allowedTools: ['alpha'],
      }),
    ).not.toThrow();
  });
});

describe('restriction vs executor identifier when object key ≠ tool.name (F3)', () => {
  // Settled by probe: buildToolSet exposes def.name to the model, collectRegisteredNames
  // registers tool.name ?? key, and the policy compares against the name the model calls.
  // The executor must resolve that same identifier — otherwise a permitted name could run a
  // different tool than the one the restriction allowed.
  it('collectRegisteredNames registers the model-facing name (tool.name ?? key), not the object key', () => {
    const publish_copy = defineTool({
      name: 'publish_copy',
      description: 'Publish.',
      input: z.object({}),
      execute: async () => ({ published: true }),
    });
    const names = collectRegisteredNames({ tools: { publish: publish_copy } });
    expect(names.has('publish_copy')).toBe(true);
    expect(names.has('publish')).toBe(false);
  });

  it('a divergent-key tool is restricted AND resolved by the name the model calls', async () => {
    // Object key "publish"; tool.name "publish_copy". The model calls publish_copy.
    const publish_copy = defineTool({
      name: 'publish_copy',
      description: 'Publish.',
      input: z.object({}),
      execute: async () => ({ published: true }),
    });
    const secret = defineTool({
      name: 'secret',
      description: 'Secret.',
      input: z.object({}),
      execute: async () => ({ leaked: true }),
    });
    const agent = {
      id: 'divergent',
      instructions: 't',
      tools: { publish: publish_copy, secret },
      skills: [
        {
          name: 'only-publish',
          description: 'd',
          body: 'b',
          allowedTools: ['publish_copy'], // must use the model-facing name
        },
      ],
    };

    // Validation passes because collectRegisteredNames registers 'publish_copy'.
    const wired = await wireAgentSkills(agent);
    expect([...collectRegisteredNames(agent)].sort()).toEqual(['publish_copy', 'secret']);

    const { session, runStore, runState } = await setupDurableHarness('div-sess', 'div-run');
    const skillActivations: SkillActivation[] = [];
    const executor = new CoreToolExecutor({
      tools: { ...wired!.tools, publish: publish_copy, secret },
    });
    const skillMetaByName = new Map(wired!.metas.map((m) => [m.name, m]));
    const policy = composePolicies(
      skillRestrictionPolicy(() => skillActivations),
      needsApprovalPolicy,
    );

    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: executor,
      model: {} as LanguageModel,
      emit: () => {},
      policy,
      skillActivations,
      skillMetaByName,
      getSkill: wired!.getSkill,
    });

    await ctx.tool('load_skill', { name: 'only-publish' });
    expect(skillActivations).toEqual([{ name: 'only-publish', allowedTools: ['publish_copy'] }]);

    // secret is not permitted → denied at the boundary, before execution.
    await expect(ctx.tool('secret', {})).rejects.toBeInstanceOf(ToolApprovalDeniedError);
    // publish_copy is permitted AND the executor resolves it by name (not by object key).
    expect(await ctx.tool('publish_copy', {})).toEqual({ published: true });
  });
});

describe('skill activation survives a handoff (F1)', () => {
  it('the target’s load_skill records its own allowed-tools after skillMetaByName is swapped', async () => {
    const src_tool = defineTool({
      name: 'src_tool',
      description: 'src',
      input: z.object({}),
      execute: async () => ({ ok: true }),
    });
    const tgt_tool = defineTool({
      name: 'tgt_tool',
      description: 'tgt',
      input: z.object({}),
      execute: async () => ({ ok: true }),
    });

    const source = {
      id: 'source',
      instructions: 't',
      tools: { src_tool },
      skills: [
        { name: 'src-skill', description: 'd', body: 'b', allowedTools: ['src_tool'] },
      ],
    };
    const target = {
      id: 'target',
      instructions: 't',
      tools: { tgt_tool },
      skills: [
        { name: 'tgt-skill', description: 'd', body: 'b', allowedTools: ['tgt_tool'] },
      ],
    };

    const sourceWired = await wireAgentSkills(source);
    const targetWired = await wireAgentSkills(target);

    const { session, runStore, runState } = await setupDurableHarness('f1-sess', 'f1-run');
    const skillActivations: SkillActivation[] = [];

    // Open the run as the source agent.
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: { ...sourceWired!.tools, src_tool } }),
      model: {} as LanguageModel,
      emit: () => {},
      policy: composePolicies(
        skillRestrictionPolicy(() => skillActivations),
        needsApprovalPolicy,
      ),
      skillActivations,
      skillMetaByName: new Map(sourceWired!.metas.map((m) => [m.name, m])),
      getSkill: sourceWired!.getSkill,
    });

    // --- handoff to target: swap every agent-scoped surface the source captured ---
    ctx.getSkill = targetWired!.getSkill;
    ctx.skillMetaByName = new Map(targetWired!.metas.map((m) => [m.name, m]));
    ctx.toolExecutor = new CoreToolExecutor({ tools: { ...targetWired!.tools, tgt_tool } });
    ctx.policy = composePolicies(
      skillRestrictionPolicy(() => skillActivations),
      needsApprovalPolicy,
    );

    // The target loads its OWN skill. load_skill returns instructions either way (the target’s
    // tool has the target’s metas baked in), but recording the activation needs the swapped
    // skillMetaByName — otherwise nothing is recorded and the boundary evaporates.
    await ctx.tool('load_skill', { name: 'tgt-skill' });
    expect(skillActivations).toEqual([{ name: 'tgt-skill', allowedTools: ['tgt_tool'] }]);

    // The target’s boundary now holds: src_tool denied, tgt_tool allowed and executed.
    await expect(ctx.tool('src_tool', {})).rejects.toBeInstanceOf(ToolApprovalDeniedError);
    expect(await ctx.tool('tgt_tool', {})).toEqual({ ok: true });
  });
});

describe('skill activation reset is per node (F4)', () => {
  it('resetSkillActivationsOnTurnStart lifts a prior node’s restriction so it does not bleed into the next node', async () => {
    const skillActivations: SkillActivation[] = [
      { name: 'prior-node-skill', allowedTools: ['alpha'] },
    ];
    const { session, runStore, runState } = await setupDurableHarness('f4-sess', 'f4-run');
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: {} as LanguageModel,
      emit: () => {},
      skillActivations,
      policy: composePolicies(
        skillRestrictionPolicy(() => skillActivations),
        needsApprovalPolicy,
      ),
    });

    // A prior node left an activation in place: beta is denied at the boundary.
    await expect(ctx.tool('beta', {})).rejects.toBeInstanceOf(ToolApprovalDeniedError);

    // The next node starts: reset clears the shared activation array, so the prior node’s
    // boundary does not silently constrain this node.
    resetSkillActivationsOnTurnStart(ctx);
    expect(ctx.skillActivations).toEqual([]);
    expect(permittedToolNames(skillActivations)).toBeNull();
  });
});
