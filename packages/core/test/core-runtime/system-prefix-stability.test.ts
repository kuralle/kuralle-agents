import { describe, expect, it } from 'bun:test';
import { composeSystem } from '../../src/flow/nodeBuilders.js';

/**
 * A cache breakpoint is placed on the LAST system message. That only buys anything if the
 * message it marks is byte-identical between turns.
 *
 * `composeSystem` used to join base instructions, skills, working memory and the flow node
 * prompt into ONE message. The breakpoint therefore marked a message that changed the moment
 * a flow became active — so the whole system region re-billed on every flow turn. Measured
 * live: 93.20% input-cache rate on a plain session, 77.20% once a flow entered.
 *
 * The contract now: stable content (base instructions, skills) is its own message and stays
 * byte-identical; volatile content (working memory, node prompt) goes in a later message.
 */
const BASE = 'You are a property agent. This head is stable and must stay cacheable.';
const SKILL = 'Triage skill: classify by urgency.';

describe('system prompt prefix stability', () => {
  it('keeps the stable head byte-identical when a flow node prompt appears', () => {
    const noFlow = composeSystem(BASE, '', {}, SKILL, undefined);
    const inFlow = composeSystem(BASE, 'Collect the unit id and the issue.', {}, SKILL, undefined);

    // The head is what a breakpoint protects. It must not move.
    expect(String(inFlow[0]?.content)).toBe(String(noFlow[0]?.content));
    expect(String(noFlow[0]?.content)).toContain(BASE);
  });

  it('keeps the stable head byte-identical when working memory changes', () => {
    const a = composeSystem(BASE, '', {}, SKILL, 'Open threads: leak in A-101 (open).');
    const b = composeSystem(BASE, '', {}, SKILL, 'Open threads: fan in B-12 (open); leak (done).');

    expect(String(b[0]?.content)).toBe(String(a[0]?.content));
  });

  it('puts volatile content in a later message, not the head', () => {
    const inFlow = composeSystem(BASE, 'NODE_PROMPT_MARKER', {}, SKILL, 'MEMORY_MARKER');

    expect(String(inFlow[0]?.content)).not.toContain('NODE_PROMPT_MARKER');
    expect(String(inFlow[0]?.content)).not.toContain('MEMORY_MARKER');

    const all = inFlow.map((m) => String(m.content)).join('\n');
    expect(all).toContain('NODE_PROMPT_MARKER');
    expect(all).toContain('MEMORY_MARKER');
  });

  it('still returns nothing when there is no content at all', () => {
    expect(composeSystem(undefined, '', {}, undefined, undefined)).toEqual([]);
  });
});
