import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { buildAgentToolSurface } from '../../src/runtime/buildAgentToolSurface.js';
import { wireAgentSkills } from '../../src/skills/wireAgentSkills.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { composePolicies, needsApprovalPolicy } from '../../src/runtime/policies/toolPolicy.js';
import { defineTool } from '../../src/tools/effect/defineTool.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { skillRestrictionPolicy, type SkillActivation } from '../../src/skills/skillActivation.js';
import { ToolApprovalDeniedError } from '../../src/tools/effect/errors.js';
import { systemNoteBlocks } from '../../src/runtime/systemNotes.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { sessionDerivedRunId } from '../../src/runtime/openRun.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import type { SkillResolver } from '../../src/types/skills.js';
import type { ChannelDriver } from '../../src/types/channel.js';
import type { TurnHandle } from '../../src/types/stream.js';

// a6-dynamic: a `SkillResolver` entry resolves a per-session/per-tenant skill set, merged
// into the same baseline pipeline a1-a5 already built for static skills — not a second,
// divergent population path (see the "seam that matters" note in the task brief).

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

async function collectParts(handle: TurnHandle) {
  const parts = [];
  for await (const part of handle.events) parts.push(part);
  await handle;
  return parts;
}

function silentDriver(runAgentTurn: ChannelDriver['runAgentTurn']): ChannelDriver {
  return {
    runAgentTurn,
    async awaitUser() {
      return { type: 'message', input: '' };
    },
  };
}

describe('SkillResolver (a6-dynamic)', () => {
  it('two sessions with different tenant keys receive different catalogs from one agent definition', async () => {
    const tenantResolver: SkillResolver = async ({ session }) => [
      {
        name: `tenant-skill-${session.id}`,
        description: `Skill for tenant ${session.id}.`,
        body: `Body for tenant ${session.id}.`,
      },
    ];
    const agent = defineAgent({
      id: 'multi-tenant-agent',
      instructions: 'help',
      model: stubModel,
      skills: [tenantResolver],
    });

    const { session: sessionA } = await setupDurableHarness('tenant-a', 'tenant-a-run');
    const { session: sessionB } = await setupDurableHarness('tenant-b', 'tenant-b-run');

    const surfaceA = await buildAgentToolSurface(agent, sessionA, {});
    const surfaceB = await buildAgentToolSurface(agent, sessionB, {});

    expect(surfaceA.skillPrompt).toContain('tenant-skill-tenant-a');
    expect(surfaceA.skillPrompt).not.toContain('tenant-skill-tenant-b');
    expect(surfaceB.skillPrompt).toContain('tenant-skill-tenant-b');
    expect(surfaceB.skillPrompt).not.toContain('tenant-skill-tenant-a');
  });

  it('a resolver-produced skill overrides a statically declared one of the same name; load_skill returns the resolver body', async () => {
    const resolver: SkillResolver = async () => [
      { name: 'refunds', description: 'Tenant refund policy.', body: 'RESOLVER REFUNDS' },
    ];
    const { session } = await setupDurableHarness('override-sess', 'override-run');
    const agent = {
      id: 'override-agent',
      skills: [
        { name: 'refunds', description: 'Static refund policy.', body: 'STATIC REFUNDS' },
        resolver,
      ],
    };

    const wired = await wireAgentSkills(agent, undefined, { session });
    if (!wired) throw new Error('expected skills to wire');

    const result = await wired.tools.load_skill!.execute({ name: 'refunds' });
    expect(result).toContain('RESOLVER REFUNDS');
    expect(result).not.toContain('STATIC REFUNDS');
  });

  it('two resolvers producing the same skill name throws, naming both', async () => {
    const resolverA: SkillResolver = async () => [
      { name: 'dup', description: 'From A.', body: 'A body' },
    ];
    const resolverB: SkillResolver = async () => [
      { name: 'dup', description: 'From B.', body: 'B body' },
    ];
    const { session } = await setupDurableHarness('collision-sess', 'collision-run');
    const agent = { id: 'collision-agent', skills: [resolverA, resolverB] };

    await expect(wireAgentSkills(agent, undefined, { session })).rejects.toThrow(
      /"dup".*resolver #0.*resolver #1/s,
    );
  });

  it('a resolver that throws fails agent construction with a message naming the agent', async () => {
    const failingResolver: SkillResolver = async () => {
      throw new Error('tenant db unreachable');
    };
    const { session } = await setupDurableHarness('ctor-fail-sess', 'ctor-fail-run');
    const agent = { id: 'ctor-fail-agent', skills: [failingResolver] };

    await expect(wireAgentSkills(agent, undefined, { session })).rejects.toThrow(
      /"ctor-fail-agent".*tenant db unreachable/s,
    );
  });

  it('resolves a skill resolver exactly once per session, across two turns', async () => {
    let calls = 0;
    const resolver: SkillResolver = async () => {
      calls += 1;
      return [{ name: 'tenant-skill', description: 'Tenant skill.', body: 'Tenant body.' }];
    };
    const driver = silentDriver(async () => ({ text: 'ok', toolResults: [] }));
    const runtime = createRuntime({
      agents: [
        defineAgent({ id: 'once-agent', instructions: 'help', model: stubModel, skills: [resolver] }),
      ],
      defaultAgentId: 'once-agent',
    });

    await collectParts(runtime.run({ sessionId: 'once-sess', input: 'first', driver }));
    expect(calls).toBe(1);

    await collectParts(runtime.run({ sessionId: 'once-sess', input: 'second', driver }));
    expect(calls).toBe(1);
  });

  it('a resolver-produced skill appears in the baseline skillPrompt, with no catalog-delta note at session start', async () => {
    const resolver: SkillResolver = async () => [
      { name: 'tenant-skill', description: 'Tenant skill.', body: 'Tenant body.' },
    ];
    let capturedSkillPrompt: string | undefined;
    const driver = silentDriver(async (_node, ctx) => {
      capturedSkillPrompt = ctx.skillPrompt;
      return { text: 'ok', toolResults: [] };
    });
    const runtime = createRuntime({
      agents: [
        defineAgent({
          id: 'baseline-agent',
          instructions: 'help',
          model: stubModel,
          skills: [resolver],
        }),
      ],
      defaultAgentId: 'baseline-agent',
    });

    await collectParts(runtime.run({ sessionId: 'baseline-sess', input: 'hi', driver }));

    expect(capturedSkillPrompt).toContain('tenant-skill');

    const runStore = new SessionRunStore(runtime.getSessionStore(), 'baseline-sess');
    const runState = await runStore.getRunState(sessionDerivedRunId('baseline-sess'));
    const notes = systemNoteBlocks(runState!);
    expect(notes.some((note) => note.includes('skills available in this run changed'))).toBe(false);
  });

  it('a resolver-produced skill declaring allowed-tools still restricts once activated (composes with a3)', async () => {
    const resolver: SkillResolver = async () => [
      {
        name: 'bounded-resolved',
        description: 'Bounded tenant skill.',
        body: 'Use alpha only.',
        allowedTools: ['alpha'],
      },
    ];
    const { session, runStore, runState } = await setupDurableHarness('bounded-sess', 'bounded-run');
    const agent = { id: 'bounded-agent', instructions: 'test', tools: { alpha, beta }, skills: [resolver] };

    const wired = await wireAgentSkills(agent, undefined, { session });
    if (!wired) throw new Error('expected skills to wire');

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

    await ctx.tool('load_skill', { name: 'bounded-resolved' });
    expect(ctx.skillActivations).toEqual([{ name: 'bounded-resolved', allowedTools: ['alpha'] }]);

    await expect(ctx.tool('beta', {})).rejects.toBeInstanceOf(ToolApprovalDeniedError);
    expect(await ctx.tool('alpha', {})).toEqual({ ok: true });
  });

  /**
   * The end-to-end version of the injection guard. A unit test on `stripInternalKeys` proves the
   * function works; it cannot notice the call site being removed. This drives a real run with a
   * hostile `selection.formData` and asserts the resolver still ran and the tenant's skills — not
   * the caller's — reached the model.
   *
   * Before the fix this exact payload gave: resolver invoked 0 times, attacker skill in the
   * prompt, tenant skill absent.
   */
  it('a hostile selection.formData cannot replace the tenant skill snapshot', async () => {
    let resolverCalls = 0;
    const tenantResolver: SkillResolver = async () => {
      resolverCalls++;
      return [{ name: 'tenant-only', description: 'Tenant scoped.', body: 'REAL TENANT BODY' }];
    };
    const evil = [{ name: 'attacker-skill', description: 'Injected.', body: 'ATTACKER BODY' }];
    let seenPrompt = '';
    const driver = silentDriver(async (_node, ctx) => {
      seenPrompt = ctx.skillPrompt ?? '';
      return { text: 'ok', toolResults: [] };
    });
    const runtime = createRuntime({
      agents: [
        defineAgent({ id: 'victim', instructions: 'help', model: stubModel, skills: [tenantResolver] }),
      ],
      defaultAgentId: 'victim',
    });

    await collectParts(
      runtime.run({
        sessionId: `inject-${Date.now()}`,
        input: 'hi',
        selection: { id: 'x', formData: { resolvedSkills: { victim: { '0': evil } } } } as never,
        driver,
      }),
    );

    expect(resolverCalls).toBe(1);
    expect(seenPrompt).toContain('tenant-only');
    expect(seenPrompt).not.toContain('attacker-skill');
  });


  /**
   * The second layer, tested separately on purpose.
   *
   * The namespace alone makes a ROOT-level `resolvedSkills` payload inert, so a test using that
   * key passes even with the strip removed — it is proving the namespace, not the strip. Only a
   * payload that names the reserved key exercises `stripInternalKeys` at its call site.
   */
  it('a formData payload naming the reserved namespace is stripped, not merged', async () => {
    let resolverCalls = 0;
    const tenantResolver: SkillResolver = async () => {
      resolverCalls++;
      return [{ name: 'tenant-only', description: 'Tenant scoped.', body: 'REAL TENANT BODY' }];
    };
    const evil = [{ name: 'attacker-skill', description: 'Injected.', body: 'ATTACKER BODY' }];
    let seenPrompt = '';
    const driver = silentDriver(async (_node, ctx) => {
      seenPrompt = ctx.skillPrompt ?? '';
      return { text: 'ok', toolResults: [] };
    });
    const runtime = createRuntime({
      agents: [
        defineAgent({ id: 'victim2', instructions: 'help', model: stubModel, skills: [tenantResolver] }),
      ],
      defaultAgentId: 'victim2',
    });

    await collectParts(
      runtime.run({
        sessionId: `inject-ns-${Date.now()}`,
        input: 'hi',
        selection: {
          id: 'x',
          formData: { __kuralle: { resolvedSkills: { victim2: { '0': evil } } } },
        } as never,
        driver,
      }),
    );

    expect(resolverCalls).toBe(1);
    expect(seenPrompt).toContain('tenant-only');
    expect(seenPrompt).not.toContain('attacker-skill');
  });

});
