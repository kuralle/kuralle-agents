import { describe, expect, test } from 'bun:test';
import type { LanguageModel } from 'ai';
import type { Session, ToolContext } from '@kuralle-agents/core';
import { buildHotelReceptionist } from '../src/agent.js';
import { HotelRepository } from '../src/database.js';
import { loadPolicies, POLICY_TOPICS } from '../src/policies.js';

function context(): ToolContext {
  const session = {
    id: 'hotel-session',
    conversationId: 'hotel-session',
    channelId: 'cli',
    createdAt: new Date(),
    updatedAt: new Date(),
    messages: [],
    workingMemory: {},
    currentAgent: 'hotel-receptionist',
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
  } as ToolContext;
}

async function execute(agent: ReturnType<typeof buildHotelReceptionist>, name: string, args: unknown, ctx: ToolContext) {
  const tool = agent.tools?.[name];
  if (!tool) throw new Error(`Missing tool ${name}`);
  return await tool.execute(args, ctx);
}

describe('hotel receptionist boundaries', () => {
  test('gates booking reads until verification persists in the session', async () => {
    const repository = new HotelRepository(':memory:', new Date('2026-08-01T00:00:00Z'));
    const agent = buildHotelReceptionist({} as LanguageModel, repository);
    const ctx = context();
    await expect(execute(agent, 'lookup_booking', {}, ctx)).rejects.toThrow('Verify the booking');
    expect(await execute(agent, 'verify_booking', {
      lastName: 'Chen',
      confirmationCode: 'HTL-MN42',
      allowCancelled: false,
    }, ctx)).toMatchObject({ verified: true });
    expect(await execute(agent, 'lookup_booking', {}, ctx)).toMatchObject({
      booking: { code: 'HTL-MN42', paymentMethod: 'ending 4477' },
    });
    repository.close();
  });

  test('approval-gates consequential actions but dispatches emergencies immediately', () => {
    const repository = new HotelRepository(':memory:');
    const agent = buildHotelReceptionist({} as LanguageModel, repository);
    const emergency = 'dispatch_emergency';
    const readOnly = new Set([
      'lookup_policy',
      'check_room_availability',
      'verify_booking',
      'lookup_booking',
      'lookup_invoice',
      'check_restaurant_availability',
      'lookup_restaurant_reservation',
      'lookup_guest_history',
      emergency,
    ]);
    for (const name of Object.keys(agent.tools ?? {})) {
      if (readOnly.has(name)) continue;
      expect(agent.tools?.[name]?.needsApproval, `${name} must require approval`).toBe(true);
    }
    for (const name of [
      'create_room_booking',
      'modify_room_booking',
      'cancel_room_booking',
      'update_payment_method',
      'create_restaurant_reservation',
      'book_tour',
      'book_spa_appointment',
      'order_flowers',
    ]) {
      expect(agent.tools?.[name]?.needsApproval).toBe(true);
    }
    expect(agent.tools?.[emergency]?.needsApproval).not.toBe(true);
    repository.close();
  });

  test('loads every declared policy from the checked-in handbook', () => {
    const policies = loadPolicies();
    expect(Object.keys(policies).sort()).toEqual([...POLICY_TOPICS].sort());
    expect(policies.guest_privacy).toContain('Never confirm or deny');
    expect(policies.pets).toContain('$50 fee per stay');
  });
});
