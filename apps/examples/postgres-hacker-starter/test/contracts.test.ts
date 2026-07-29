import { describe, expect, test } from 'bun:test';
import type { LanguageModel } from 'ai';
import { buildHackerAgent } from '../server/agent';
import { HackerRepository, normalizeMemoryType } from '../server/database';
import { scopedSessionId } from '../server/api';

describe('hacker starter contracts', () => {
  test('normalizes safe memory labels and rejects unusable labels', () => {
    expect(normalizeMemoryType(' Preferred editor ')).toBe('preferred_editor');
    expect(normalizeMemoryType('timezone-2')).toBe('timezone_2');
    expect(() => normalizeMemoryType('1')).toThrow('Memory labels');
  });

  test('namespaces validated conversation ids by authenticated identity', () => {
    expect(scopedSessionId('user-a', 'web_12345678')).toBe('user-a:web_12345678');
    expect(() => scopedSessionId('user-a', '../other-user')).toThrow('Invalid conversation id');
  });

  test('approval-gates every profile or memory mutation', () => {
    const agent = buildHackerAgent({} as LanguageModel, {} as HackerRepository);
    for (const name of ['update_profile', 'remember_detail', 'forget_detail']) {
      expect(agent.tools?.[name]?.needsApproval, `${name} must require approval`).toBe(true);
    }
    for (const name of ['lookup_order', 'recall_detail', 'search_memories', 'list_user_memories']) {
      expect(agent.tools?.[name]?.needsApproval, `${name} must remain read-only`).not.toBe(true);
    }
  });
});
