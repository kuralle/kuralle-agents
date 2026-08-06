import { describe, expect, test } from 'bun:test';
import type { LanguageModel } from 'ai';
import type { Session, ToolContext } from '@kuralle-agents/core';
import { buildHealthcareAgent } from '../src/agent.js';
import { HealthcareRepository } from '../src/database.js';

function context(): ToolContext {
  const session = {
    id: 'session-1',
    conversationId: 'conversation-1',
    channelId: 'cli',
    createdAt: new Date(),
    updatedAt: new Date(),
    messages: [],
    workingMemory: {},
    currentAgent: 'healthcare-assistant',
    agentStates: {},
    handoffHistory: [],
  } satisfies Session;
  return {
    session,
    runState: {} as ToolContext['runState'],
    tool: async () => undefined,
    now: async () => Date.now(),
    uuid: async () => crypto.randomUUID(),
    emit: () => undefined,
    // A hand-built stub covers only the fields these tool tests touch, so it no longer overlaps
    // `ToolContext` closely enough for a direct assertion — widen through `unknown` rather than
    // padding the stub with fields nothing here reads.
  } as unknown as ToolContext;
}

async function execute(agent: ReturnType<typeof buildHealthcareAgent>, name: string, args: unknown, ctx: ToolContext) {
  const tool = agent.tools?.[name];
  if (!tool) throw new Error(`Missing tool ${name}`);
  return await tool.execute(args, ctx);
}

describe('healthcare agent boundaries', () => {
  test('rejects protected reads until the patient is authenticated', async () => {
    const repository = new HealthcareRepository(':memory:', new Date('2026-08-01T00:00:00Z'));
    const agent = buildHealthcareAgent({} as LanguageModel, repository);
    const ctx = context();

    await expect(execute(agent, 'get_balance', {}, ctx)).rejects.toThrow('Authenticate the patient');
    expect(await execute(agent, 'authenticate_patient', {
      fullName: 'Mary Jane',
      dateOfBirth: '2001-06-10',
    }, ctx)).toMatchObject({ authenticated: true });
    expect(await execute(agent, 'get_balance', {}, ctx)).toMatchObject({
      outstandingBalance: '$125.75',
      paymentMethod: 'card ending 4242',
    });
    repository.close();
  });

  test('requires human approval for every consequential mutation', () => {
    const repository = new HealthcareRepository(':memory:');
    const agent = buildHealthcareAgent({} as LanguageModel, repository);
    for (const name of ['schedule_appointment', 'cancel_appointment', 'reschedule_appointment', 'pay_balance']) {
      expect(agent.tools?.[name]?.needsApproval).toBe(true);
    }
    repository.close();
  });
});
