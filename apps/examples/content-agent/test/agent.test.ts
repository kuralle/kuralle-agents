import { describe, expect, it } from 'bun:test';
import type { LanguageModel } from 'ai';
import { InMemoryFs } from '@kuralle-agents/fs';
import { buildContentAgent } from '../src/agent.js';

const model = {} as LanguageModel;

describe('local content agent contract', () => {
  const agent = buildContentAgent(model, new InMemoryFs());

  it('keeps the generic workspace read-only and mounts skills from it', () => {
    expect(agent.workspace).toMatchObject({ readOnly: true });
    expect(agent.skills).toBe('/skills');
  });

  it('approval-gates every durable mutation', () => {
    for (const name of ['save_writer_preferences', 'create_draft', 'update_draft', 'publish_draft', 'delete_draft']) {
      expect(agent.tools?.[name]?.needsApproval, name).toBe(true);
    }
  });

  it('leaves reads and deterministic lint ungated', () => {
    for (const name of ['get_writer_preferences', 'lint_against_style', 'get_draft']) {
      expect(agent.tools?.[name]?.needsApproval, name).not.toBe(true);
    }
  });

  it('exposes only local content operations', () => {
    expect(Object.keys(agent.tools ?? {}).sort()).toEqual([
      'create_draft',
      'delete_draft',
      'get_draft',
      'get_writer_preferences',
      'lint_against_style',
      'publish_draft',
      'save_writer_preferences',
      'update_draft',
    ]);
  });
});
