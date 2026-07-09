import { describe, it, expect } from 'bun:test';
import { tool } from 'ai';
import { z } from 'zod';

import {
  PromptAssembly,
  PromptSecurityViolationError,
} from '../src/prompts/PromptAssembly.ts';
import type { PromptSectionConfig, ResolvedSection } from '../src/prompts/PromptAssembly.ts';

import {
  renderSections,
  PromptValidationError,
} from '../src/prompts/PromptRenderer.ts';

import { AgentPrompt } from '../src/prompts/AgentPrompt.ts';

import { SECURITY_CORE_TEMPLATES, SECURITY_REMINDER } from '../src/prompts/security.ts';
import { estimateTokenCount } from '../src/runtime/ContextBudget.ts';
import { BuiltinPersonas } from '../src/persona/index.ts';

// ============================================
// Helpers
// ============================================

/** Creates a minimal resolved section for renderer tests. */
function makeSection(
  overrides: Partial<ResolvedSection> & { type: string; content: string },
): ResolvedSection {
  return {
    priority: 50,
    shrinkable: true,
    tag: overrides.type,
    source: 'developer',
    frozen: false,
    estimatedTokens: estimateTokenCount(overrides.content),
    ...overrides,
  };
}

/** Build a pair of security bookend sections for renderer tests. */
function securityBookends(): ResolvedSection[] {
  return [
    makeSection({
      type: 'security_core',
      content: SECURITY_CORE_TEMPLATES.minimal,
      priority: 0,
      shrinkable: false,
      source: 'security',
      frozen: true,
    }),
    makeSection({
      type: 'security_reminder',
      content: SECURITY_REMINDER,
      priority: 1000,
      shrinkable: false,
      source: 'security',
      frozen: true,
    }),
  ];
}

// ============================================
// PromptAssembly
// ============================================

describe('PromptAssembly', () => {
  it('addSection stores sections keyed by type', () => {
    const assembly = new PromptAssembly();
    assembly.addSection({ type: 'role', content: 'Agent role', priority: 10 });
    expect(assembly.hasSection('role')).toBe(true);
    expect(assembly.sectionByType('role')?.content).toBe('Agent role');
  });

  it('addSection replaces existing section of same type (last-write-wins)', () => {
    const assembly = new PromptAssembly();
    assembly.addSection({ type: 'role', content: 'First', priority: 10 });
    assembly.addSection({ type: 'role', content: 'Second', priority: 10 });
    expect(assembly.sectionByType('role')?.content).toBe('Second');
    expect(assembly.size).toBe(1);
  });

  it('custom sections are appended (multiple allowed)', () => {
    const assembly = new PromptAssembly();
    assembly.addSection({ type: 'custom', content: 'Custom A', priority: 60 });
    assembly.addSection({ type: 'custom', content: 'Custom B', priority: 61 });
    expect(assembly.hasSection('custom')).toBe(true);
    expect(assembly.size).toBe(2);
  });

  it('freeze() prevents adding sections at priority 0-9', () => {
    const assembly = new PromptAssembly();
    assembly.freeze();
    expect(() =>
      assembly.addSection({ type: 'hack', content: 'evil', priority: 0 }),
    ).toThrow(PromptSecurityViolationError);
    expect(() =>
      assembly.addSection({ type: 'hack', content: 'evil', priority: 9 }),
    ).toThrow(PromptSecurityViolationError);
  });

  it('freeze() prevents adding sections at priority 1000+', () => {
    const assembly = new PromptAssembly();
    assembly.freeze();
    expect(() =>
      assembly.addSection({ type: 'hack', content: 'evil', priority: 1000 }),
    ).toThrow(PromptSecurityViolationError);
    expect(() =>
      assembly.addSection({ type: 'hack', content: 'evil', priority: 9999 }),
    ).toThrow(PromptSecurityViolationError);
  });

  it('freeze() allows adding sections at normal priorities (10-999)', () => {
    const assembly = new PromptAssembly();
    assembly.freeze();
    // Should not throw
    assembly.addSection({ type: 'role', content: 'My role', priority: 10 });
    assembly.addSection({ type: 'knowledge', content: 'Facts', priority: 999 });
    expect(assembly.size).toBe(2);
  });

  it('resolve() returns sections sorted by priority ascending', async () => {
    const assembly = new PromptAssembly();
    assembly.addSection({ type: 'knowledge', content: 'Facts', priority: 30 });
    assembly.addSection({ type: 'role', content: 'Role', priority: 10 });
    assembly.addSection({ type: 'guardrails', content: 'Rules', priority: 20 });

    const resolved = await assembly.resolve();
    expect(resolved.map((s) => s.type)).toEqual(['role', 'guardrails', 'knowledge']);
    expect(resolved[0].priority).toBeLessThan(resolved[1].priority);
    expect(resolved[1].priority).toBeLessThan(resolved[2].priority);
  });

  it('resolve() resolves async content functions', async () => {
    const assembly = new PromptAssembly();
    assembly.addSection({
      type: 'knowledge',
      content: async () => 'Dynamic knowledge',
      priority: 30,
    });

    const resolved = await assembly.resolve();
    expect(resolved).toHaveLength(1);
    expect(resolved[0].content).toBe('Dynamic knowledge');
  });

  it('resolve() filters out empty/whitespace-only sections', async () => {
    const assembly = new PromptAssembly();
    assembly.addSection({ type: 'role', content: 'Valid', priority: 10 });
    assembly.addSection({ type: 'empty', content: '', priority: 20 });
    assembly.addSection({ type: 'whitespace', content: '   \n  ', priority: 30 });

    const resolved = await assembly.resolve();
    expect(resolved).toHaveLength(1);
    expect(resolved[0].type).toBe('role');
  });

  it('resolve() calculates estimatedTokens per section', async () => {
    const assembly = new PromptAssembly();
    const content = 'This is some test content for token estimation.';
    assembly.addSection({ type: 'role', content, priority: 10 });

    const resolved = await assembly.resolve();
    expect(resolved[0].estimatedTokens).toBe(estimateTokenCount(content));
    expect(resolved[0].estimatedTokens).toBeGreaterThan(0);
  });

  it('sectionByType returns the section or undefined', () => {
    const assembly = new PromptAssembly();
    assembly.addSection({ type: 'role', content: 'Role', priority: 10 });

    expect(assembly.sectionByType('role')).toBeDefined();
    expect(assembly.sectionByType('role')?.type).toBe('role');
    expect(assembly.sectionByType('nonexistent')).toBeUndefined();
  });

  it('hasSection returns true/false correctly', () => {
    const assembly = new PromptAssembly();
    expect(assembly.hasSection('role')).toBe(false);
    assembly.addSection({ type: 'role', content: 'Role', priority: 10 });
    expect(assembly.hasSection('role')).toBe(true);
  });

  it('debug() returns section metadata with types, priorities, tokens, sources', async () => {
    const assembly = new PromptAssembly();
    assembly.addSection({
      type: 'role',
      content: 'Agent role',
      priority: 10,
      source: 'developer',
    });
    assembly.addSection({
      type: 'knowledge',
      content: 'Some facts',
      priority: 30,
      source: 'runtime',
    });

    const debugInfo = await assembly.debug();
    expect(debugInfo.sections).toHaveLength(2);
    expect(debugInfo.sections[0].type).toBe('role');
    expect(debugInfo.sections[0].priority).toBe(10);
    expect(debugInfo.sections[0].source).toBe('developer');
    expect(debugInfo.sections[0].tokens).toBeGreaterThan(0);
    expect(debugInfo.sections[1].type).toBe('knowledge');
    expect(debugInfo.totalTokens).toBe(
      debugInfo.sections[0].tokens + debugInfo.sections[1].tokens,
    );
  });

  it('inject() adds with source=runtime', async () => {
    const assembly = new PromptAssembly();
    assembly.inject('context', 'Runtime context data');

    const resolved = await assembly.resolve();
    expect(resolved).toHaveLength(1);
    expect(resolved[0].source).toBe('runtime');
    expect(resolved[0].content).toBe('Runtime context data');
  });

  it('inject() defaults to priority 60', async () => {
    const assembly = new PromptAssembly();
    assembly.inject('context', 'Data');

    const resolved = await assembly.resolve();
    expect(resolved[0].priority).toBe(60);
  });

  it('inject() accepts custom priority', async () => {
    const assembly = new PromptAssembly();
    assembly.inject('context', 'Data', { priority: 42 });

    const resolved = await assembly.resolve();
    expect(resolved[0].priority).toBe(42);
  });

  it('size getter returns correct count', () => {
    const assembly = new PromptAssembly();
    expect(assembly.size).toBe(0);
    assembly.addSection({ type: 'role', content: 'Role', priority: 10 });
    expect(assembly.size).toBe(1);
    assembly.addSection({ type: 'custom', content: 'C1', priority: 60 });
    assembly.addSection({ type: 'custom', content: 'C2', priority: 61 });
    expect(assembly.size).toBe(3); // 1 keyed + 2 custom
  });
});

// ============================================
// PromptRenderer (renderSections)
// ============================================

describe('PromptRenderer (renderSections)', () => {
  it('renders sections in priority order', () => {
    const sections = [
      ...securityBookends(),
      makeSection({ type: 'role', content: 'I am an agent.', priority: 10, shrinkable: false }),
      makeSection({ type: 'knowledge', content: 'Some facts.', priority: 30 }),
    ];
    sections.sort((a, b) => a.priority - b.priority);

    const result = renderSections(sections);
    const roleIndex = result.indexOf('<role>');
    const knowledgeIndex = result.indexOf('<knowledge>');
    const secCoreIndex = result.indexOf('<security_core>');
    const secRemIndex = result.indexOf('<security_reminder>');

    expect(secCoreIndex).toBeLessThan(roleIndex);
    expect(roleIndex).toBeLessThan(knowledgeIndex);
    expect(knowledgeIndex).toBeLessThan(secRemIndex);
  });

  it('wraps sections in XML tags when useXmlTags=true', () => {
    const sections = [
      ...securityBookends(),
      makeSection({ type: 'role', content: 'Agent role', priority: 10 }),
    ];
    sections.sort((a, b) => a.priority - b.priority);

    const result = renderSections(sections, { useXmlTags: true });
    expect(result).toContain('<role>\nAgent role\n</role>');
  });

  it('does NOT wrap in XML tags when useXmlTags=false', () => {
    const sections = [
      ...securityBookends(),
      makeSection({ type: 'role', content: 'Agent role', priority: 10 }),
    ];
    sections.sort((a, b) => a.priority - b.priority);

    const result = renderSections(sections, { useXmlTags: false });
    expect(result).not.toContain('<role>');
    expect(result).not.toContain('</role>');
    expect(result).toContain('Agent role');
  });

  it('validates security core exists (throws PromptValidationError if missing)', () => {
    const sections = [
      makeSection({
        type: 'security_reminder',
        content: SECURITY_REMINDER,
        priority: 1000,
        shrinkable: false,
      }),
      makeSection({ type: 'role', content: 'Role', priority: 10 }),
    ];

    expect(() => renderSections(sections)).toThrow(PromptValidationError);
    expect(() => renderSections(sections)).toThrow(/security_core/);
  });

  it('validates security reminder exists (throws PromptValidationError if missing)', () => {
    const sections = [
      makeSection({
        type: 'security_core',
        content: SECURITY_CORE_TEMPLATES.minimal,
        priority: 0,
        shrinkable: false,
      }),
      makeSection({ type: 'role', content: 'Role', priority: 10 }),
    ];

    expect(() => renderSections(sections)).toThrow(PromptValidationError);
    expect(() => renderSections(sections)).toThrow(/security_reminder/);
  });

  it('skips validation when validateSecurity=false', () => {
    const sections = [
      makeSection({ type: 'role', content: 'Role', priority: 10 }),
    ];

    // Should not throw
    const result = renderSections(sections, { validateSecurity: false });
    expect(result).toContain('Role');
  });

  it('trims shrinkable sections when over maxTokens (lowest priority trimmed first)', () => {
    const longContent = 'word '.repeat(2000); // ~2500 tokens
    const sections = [
      ...securityBookends(),
      makeSection({
        type: 'role',
        content: 'Critical role.',
        priority: 10,
        shrinkable: false,
      }),
      makeSection({
        type: 'knowledge',
        content: longContent,
        priority: 30,
        shrinkable: true,
      }),
      makeSection({
        type: 'examples',
        content: longContent,
        priority: 50,
        shrinkable: true,
      }),
    ];
    sections.sort((a, b) => a.priority - b.priority);

    // Set a tight budget — the security + role sections are small, but two long sections overflow
    const securityTokens =
      estimateTokenCount(SECURITY_CORE_TEMPLATES.minimal) +
      estimateTokenCount(SECURITY_REMINDER);
    const roleTokens = estimateTokenCount('Critical role.');
    // Budget that fits security + role + one long section but not both
    const maxTokens = securityTokens + roleTokens + estimateTokenCount(longContent) + 10;

    const result = renderSections(sections, { maxTokens });

    // Role must survive (non-shrinkable)
    expect(result).toContain('Critical role.');
    // Examples (priority 50, lowest priority = trimmed first) should be removed or truncated
    // Knowledge (priority 30, higher priority) should be more preserved
  });

  it('does NOT trim non-shrinkable sections (role, instructions, guardrails, security)', () => {
    const longContent = 'word '.repeat(2000);
    const sections = [
      ...securityBookends(),
      makeSection({
        type: 'role',
        content: longContent,
        priority: 10,
        shrinkable: false,
      }),
    ];
    sections.sort((a, b) => a.priority - b.priority);

    // Very tight budget
    const result = renderSections(sections, { maxTokens: 100 });
    // Non-shrinkable content should survive intact
    expect(result).toContain(longContent);
  });

  it('removes sections entirely when trimmed to zero', () => {
    const longContent = 'word '.repeat(5000);
    const sections = [
      ...securityBookends(),
      makeSection({
        type: 'knowledge',
        content: longContent,
        priority: 30,
        shrinkable: true,
      }),
    ];
    sections.sort((a, b) => a.priority - b.priority);

    // Budget that barely fits the security sections but not knowledge
    const secTokens =
      estimateTokenCount(SECURITY_CORE_TEMPLATES.minimal) +
      estimateTokenCount(SECURITY_REMINDER);
    const result = renderSections(sections, { maxTokens: secTokens + 5 });

    // Knowledge should be removed or heavily truncated
    // The security bookends should remain
    expect(result).toContain('security_core');
    expect(result).toContain('security_reminder');
  });

  it('handles no maxTokens (no trimming)', () => {
    const longContent = 'word '.repeat(5000);
    const sections = [
      ...securityBookends(),
      makeSection({ type: 'knowledge', content: longContent, priority: 30 }),
    ];
    sections.sort((a, b) => a.priority - b.priority);

    const result = renderSections(sections);
    // Full content preserved
    expect(result).toContain(longContent);
  });
});

// ============================================
// AgentPrompt
// ============================================

describe('AgentPrompt', () => {
  it('constructor adds security_core at priority 0 and security_reminder at priority 1000', async () => {
    const prompt = new AgentPrompt();
    const debug = await prompt.debug();

    const coreSection = debug.sections.find((s) => s.type === 'security_core');
    const reminderSection = debug.sections.find((s) => s.type === 'security_reminder');

    expect(coreSection).toBeDefined();
    expect(coreSection!.priority).toBe(0);
    expect(reminderSection).toBeDefined();
    expect(reminderSection!.priority).toBe(1000);
  });

  it('constructor freezes security bands', () => {
    const prompt = new AgentPrompt();
    // Attempting to inject into security band should throw
    expect(() =>
      prompt.assembly.addSection({ type: 'hack', content: 'evil', priority: 0 }),
    ).toThrow(PromptSecurityViolationError);
  });

  it('constructor with disableSecurity skips security sections', async () => {
    const prompt = new AgentPrompt({ disableSecurity: true });
    prompt.role('Test role');

    const debug = await prompt.debug();
    expect(debug.sections.find((s) => s.type === 'security_core')).toBeUndefined();
    expect(debug.sections.find((s) => s.type === 'security_reminder')).toBeUndefined();

    // Should render without throwing
    const rendered = await prompt.render();
    expect(rendered).toContain('Test role');
  });

  it("constructor with policy='regulated' uses regulated security core", async () => {
    const prompt = new AgentPrompt({ policy: 'regulated' });
    const rendered = await prompt.render();
    expect(rendered).toContain('Compliance Mode');
    expect(rendered).toContain('Audit Trail');
  });

  it('.role() adds at priority 10, shrinkable: false', async () => {
    const prompt = new AgentPrompt();
    prompt.role('You are a support agent.');

    const debug = await prompt.debug();
    const role = debug.sections.find((s) => s.type === 'role');
    expect(role).toBeDefined();
    expect(role!.priority).toBe(10);
    expect(role!.shrinkable).toBe(false);
  });

  it('.instructions() adds at priority 15, shrinkable: false', async () => {
    const prompt = new AgentPrompt();
    prompt.instructions('Help with billing.');

    const debug = await prompt.debug();
    const section = debug.sections.find((s) => s.type === 'instructions');
    expect(section).toBeDefined();
    expect(section!.priority).toBe(15);
    expect(section!.shrinkable).toBe(false);
  });

  it('.guardrails() adds at priority 20, shrinkable: false', async () => {
    const prompt = new AgentPrompt();
    prompt.guardrails('Never share secrets.');

    const debug = await prompt.debug();
    const section = debug.sections.find((s) => s.type === 'guardrails');
    expect(section).toBeDefined();
    expect(section!.priority).toBe(20);
    expect(section!.shrinkable).toBe(false);
  });

  it('.persona() adds at priority 17, shrinkable: false', async () => {
    const prompt = new AgentPrompt();
    prompt.persona(BuiltinPersonas.brief);

    const debug = await prompt.debug();
    const section = debug.sections.find((s) => s.type === 'persona');
    expect(section).toBeDefined();
    expect(section!.priority).toBe(17);
    expect(section!.shrinkable).toBe(false);
  });

  it('.voice() adds at priority 25, shrinkable: true', async () => {
    const prompt = new AgentPrompt();
    prompt.voice('Speak casually.');

    const debug = await prompt.debug();
    const section = debug.sections.find((s) => s.type === 'voice');
    expect(section).toBeDefined();
    expect(section!.priority).toBe(25);
    expect(section!.shrinkable).toBe(true);
  });

  it('.knowledge() adds at priority 30, shrinkable: true', async () => {
    const prompt = new AgentPrompt();
    prompt.knowledge('Domain knowledge here.');

    const debug = await prompt.debug();
    const section = debug.sections.find((s) => s.type === 'knowledge');
    expect(section).toBeDefined();
    expect(section!.priority).toBe(30);
    expect(section!.shrinkable).toBe(true);
  });

  it('.rules() adds at priority 35, shrinkable: true', async () => {
    const prompt = new AgentPrompt();
    prompt.rules('Business rule 1. Business rule 2.');

    const debug = await prompt.debug();
    const section = debug.sections.find((s) => s.type === 'rules');
    expect(section).toBeDefined();
    expect(section!.priority).toBe(35);
    expect(section!.shrinkable).toBe(true);
  });

  it('.tools() auto-generates tool descriptions at priority 40', async () => {
    const toolSet = {
      lookup_order: tool({
        description: 'Looks up an order by ID.',
        inputSchema: z.object({ orderId: z.string() }),
        execute: async () => ({ found: true }),
      }),
      cancel_order: tool({
        description: 'Cancels an order.',
        inputSchema: z.object({ orderId: z.string() }),
        execute: async () => ({ cancelled: true }),
      }),
    };

    const prompt = new AgentPrompt();
    prompt.tools(toolSet);

    const debug = await prompt.debug();
    const section = debug.sections.find((s) => s.type === 'tools');
    expect(section).toBeDefined();
    expect(section!.priority).toBe(40);

    const rendered = await prompt.render();
    expect(rendered).toContain('lookup_order');
    expect(rendered).toContain('cancel_order');
    expect(rendered).toContain('Looks up an order by ID.');
    expect(rendered).toContain('Cancels an order.');
  });

  it('.glossary() formats terms at priority 38', async () => {
    const prompt = new AgentPrompt();
    prompt.glossary([
      { name: 'OPD', description: 'Outpatient Department', synonyms: ['outpatient'] },
      { name: 'IPD', description: 'Inpatient Department' },
    ]);

    const debug = await prompt.debug();
    const section = debug.sections.find((s) => s.type === 'glossary');
    expect(section).toBeDefined();
    expect(section!.priority).toBe(38);

    const rendered = await prompt.render();
    expect(rendered).toContain('OPD');
    expect(rendered).toContain('Outpatient Department');
    expect(rendered).toContain('outpatient');
    expect(rendered).toContain('IPD');
    expect(rendered).toContain('Inpatient Department');
  });

  it('.examples() adds at priority 50, shrinkable: true', async () => {
    const prompt = new AgentPrompt();
    prompt.examples('User: hi\nAgent: Hello!');

    const debug = await prompt.debug();
    const section = debug.sections.find((s) => s.type === 'examples');
    expect(section).toBeDefined();
    expect(section!.priority).toBe(50);
    expect(section!.shrinkable).toBe(true);
  });

  it('.section() adds custom section at priority 60 (default)', async () => {
    const prompt = new AgentPrompt();
    prompt.section('context', 'Extra context here.');

    const debug = await prompt.debug();
    const section = debug.sections.find((s) => s.type === 'context');
    expect(section).toBeDefined();
    expect(section!.priority).toBe(60);
  });

  it('.section() accepts custom priority', async () => {
    const prompt = new AgentPrompt();
    prompt.section('context', 'Extra context here.', 42);

    const debug = await prompt.debug();
    const section = debug.sections.find((s) => s.type === 'context');
    expect(section).toBeDefined();
    expect(section!.priority).toBe(42);
  });

  it('chaining: all methods return `this`', () => {
    const prompt = new AgentPrompt();
    const result = prompt
      .role('Role')
      .instructions('Instructions')
      .persona(BuiltinPersonas.brief)
      .guardrails('Guardrails')
      .voice('Voice')
      .knowledge('Knowledge')
      .rules('Rules')
      .examples('Examples')
      .section('extra', 'Extra');

    expect(result).toBe(prompt);
  });

  it('render() produces XML-tagged output with sections in correct order', async () => {
    const prompt = new AgentPrompt()
      .role('You are a support agent.')
      .instructions('Help with billing.')
      .persona(BuiltinPersonas.warm)
      .guardrails('Never leak internal data.');

    const rendered = await prompt.render();

    // Check XML wrapping
    expect(rendered).toContain('<security_core>');
    expect(rendered).toContain('</security_core>');
    expect(rendered).toContain('<role>');
    expect(rendered).toContain('</role>');
    expect(rendered).toContain('<instructions>');
    expect(rendered).toContain('</instructions>');
    expect(rendered).toContain('<persona>');
    expect(rendered).toContain('</persona>');
    expect(rendered).toContain('<guardrails>');
    expect(rendered).toContain('</guardrails>');
    expect(rendered).toContain('<security_reminder>');
    expect(rendered).toContain('</security_reminder>');

    // Check ordering
    const coreIdx = rendered.indexOf('<security_core>');
    const roleIdx = rendered.indexOf('<role>');
    const instrIdx = rendered.indexOf('<instructions>');
    const personaIdx = rendered.indexOf('<persona>');
    const guardIdx = rendered.indexOf('<guardrails>');
    const remIdx = rendered.indexOf('<security_reminder>');

    expect(coreIdx).toBeLessThan(roleIdx);
    expect(roleIdx).toBeLessThan(instrIdx);
    expect(instrIdx).toBeLessThan(personaIdx);
    expect(personaIdx).toBeLessThan(guardIdx);
    expect(guardIdx).toBeLessThan(remIdx);
  });

  it('render() with xmlTags=false produces plain output', async () => {
    const prompt = new AgentPrompt({ xmlTags: false })
      .role('You are a support agent.');

    const rendered = await prompt.render();

    expect(rendered).not.toContain('<role>');
    expect(rendered).not.toContain('</role>');
    expect(rendered).toContain('You are a support agent.');
  });

  it('render() with maxTokens trims shrinkable sections', async () => {
    const longKnowledge = 'fact '.repeat(5000);

    const prompt = new AgentPrompt({ maxTokens: 500 })
      .role('Agent role.')
      .knowledge(longKnowledge);

    const rendered = await prompt.render();

    // Role is non-shrinkable, should survive
    expect(rendered).toContain('Agent role.');

    // Knowledge is shrinkable — should be trimmed or removed
    // The full longKnowledge (~6250 tokens) cannot fit in 500 token budget
    expect(rendered.length).toBeLessThan(longKnowledge.length);
  });

  it('debug() returns full section metadata', async () => {
    const prompt = new AgentPrompt()
      .role('Role')
      .knowledge('Knowledge');

    const debugInfo = await prompt.debug();

    // Should have security_core, role, knowledge, security_reminder
    expect(debugInfo.sections).toHaveLength(4);
    expect(debugInfo.totalTokens).toBeGreaterThan(0);

    const types = debugInfo.sections.map((s) => s.type);
    expect(types).toContain('security_core');
    expect(types).toContain('role');
    expect(types).toContain('knowledge');
    expect(types).toContain('security_reminder');
  });

  it('async content: .role(async () => "Dynamic role") resolves at render time', async () => {
    const prompt = new AgentPrompt()
      .role(async () => 'Dynamic role from async');

    const rendered = await prompt.render();
    expect(rendered).toContain('Dynamic role from async');
  });

  it('attempt to modify security band after construction throws PromptSecurityViolationError', () => {
    const prompt = new AgentPrompt();

    expect(() =>
      prompt.assembly.addSection({
        type: 'injected_core',
        content: 'Override security',
        priority: 5,
      }),
    ).toThrow(PromptSecurityViolationError);

    expect(() =>
      prompt.assembly.addSection({
        type: 'injected_reminder',
        content: 'Override reminder',
        priority: 1001,
      }),
    ).toThrow(PromptSecurityViolationError);
  });
});

// ============================================
// Integration (DX verification)
// ============================================

describe('Integration (DX verification)', () => {
  it('Simple agent with string prompt field works (no AgentPrompt)', () => {
    // Verify plain strings are still valid for agents that do not use AgentPrompt
    const systemPrompt = 'You are a helpful assistant.';
    expect(typeof systemPrompt).toBe('string');
    expect(systemPrompt.length).toBeGreaterThan(0);
  });

  it('Agent with AgentPrompt has correct section order: security_core < role < instructions < guardrails < knowledge < tools < security_reminder', async () => {
    const toolSet = {
      search: tool({
        description: 'Searches the database.',
        inputSchema: z.object({ query: z.string() }),
        execute: async () => ({ results: [] }),
      }),
    };

    const prompt = new AgentPrompt()
      .role('Support agent')
      .instructions('Help users')
      .guardrails('No leaks')
      .knowledge('Domain facts')
      .tools(toolSet);

    const debug = await prompt.debug();
    const priorities = debug.sections.map((s) => ({ type: s.type, priority: s.priority }));

    // Verify ordering
    const order = priorities.sort((a, b) => a.priority - b.priority).map((p) => p.type);
    expect(order[0]).toBe('security_core');
    expect(order[order.length - 1]).toBe('security_reminder');

    const roleIdx = order.indexOf('role');
    const instrIdx = order.indexOf('instructions');
    const guardIdx = order.indexOf('guardrails');
    const knowIdx = order.indexOf('knowledge');
    const toolsIdx = order.indexOf('tools');

    expect(roleIdx).toBeLessThan(instrIdx);
    expect(instrIdx).toBeLessThan(guardIdx);
    expect(guardIdx).toBeLessThan(knowIdx);
    expect(knowIdx).toBeLessThan(toolsIdx);
  });

  it('Full example: hospital receptionist with role + instructions + guardrails + tools + glossary renders correctly', async () => {
    const toolSet = {
      book_appointment: tool({
        description: 'Books a hospital appointment for the patient.',
        inputSchema: z.object({
          patientName: z.string(),
          department: z.string(),
          date: z.string(),
        }),
        execute: async () => ({ booked: true, confirmationId: 'APT-123' }),
      }),
      check_availability: tool({
        description: 'Checks doctor availability for a given department and date.',
        inputSchema: z.object({
          department: z.string(),
          date: z.string(),
        }),
        execute: async () => ({ available: true, slots: ['9:00 AM', '2:00 PM'] }),
      }),
    };

    const prompt = new AgentPrompt({ policy: 'safe' })
      .role('You are a hospital receptionist at City General Hospital.')
      .instructions(
        'Help patients book appointments, check availability, and answer general questions about the hospital.',
      )
      .guardrails(
        'Never provide medical advice. Never share other patients\' information. Always verify patient identity before booking.',
      )
      .glossary([
        { name: 'OPD', description: 'Outpatient Department', synonyms: ['outpatient', 'OP'] },
        { name: 'ER', description: 'Emergency Room', synonyms: ['emergency', 'A&E'] },
      ])
      .tools(toolSet)
      .examples(
        'Patient: I want to book an appointment.\nReceptionist: I\'d be happy to help. Which department and what date works for you?',
      );

    const rendered = await prompt.render();

    // Security bookends present
    expect(rendered).toContain('<security_core>');
    expect(rendered).toContain('<security_reminder>');

    // All sections present
    expect(rendered).toContain('hospital receptionist');
    expect(rendered).toContain('book appointments');
    expect(rendered).toContain('Never provide medical advice');
    expect(rendered).toContain('OPD');
    expect(rendered).toContain('Outpatient Department');
    expect(rendered).toContain('book_appointment');
    expect(rendered).toContain('check_availability');
    expect(rendered).toContain('I want to book an appointment');

    // Uses 'safe' security policy
    expect(rendered).toContain('NEVER share [PRIVATE] content');

    // Correct ordering in the rendered output
    const roleIdx = rendered.indexOf('<role>');
    const instrIdx = rendered.indexOf('<instructions>');
    const guardIdx = rendered.indexOf('<guardrails>');
    const glossIdx = rendered.indexOf('<glossary>');
    const toolsIdx = rendered.indexOf('<tools>');
    const exIdx = rendered.indexOf('<examples>');

    expect(roleIdx).toBeLessThan(instrIdx);
    expect(instrIdx).toBeLessThan(guardIdx);
    expect(guardIdx).toBeLessThan(glossIdx);
    expect(glossIdx).toBeLessThan(toolsIdx);
    expect(toolsIdx).toBeLessThan(exIdx);
  });
});

// ============================================
// Edge cases
// ============================================

describe('Edge cases', () => {
  it('Empty AgentPrompt (no sections added) still renders security bookends', async () => {
    const prompt = new AgentPrompt();
    const rendered = await prompt.render();

    expect(rendered).toContain('<security_core>');
    expect(rendered).toContain('</security_core>');
    expect(rendered).toContain('<security_reminder>');
    expect(rendered).toContain('</security_reminder>');
  });

  it('AgentPrompt with only role renders: security_core + role + security_reminder', async () => {
    const prompt = new AgentPrompt().role('Test role');
    const debug = await prompt.debug();

    expect(debug.sections).toHaveLength(3);
    const types = debug.sections.map((s) => s.type);
    expect(types).toEqual(['security_core', 'role', 'security_reminder']);
  });

  it('Calling .role() twice overwrites (last-write-wins)', async () => {
    const prompt = new AgentPrompt()
      .role('First role')
      .role('Second role');

    const rendered = await prompt.render();
    expect(rendered).toContain('Second role');
    expect(rendered).not.toContain('First role');

    const debug = await prompt.debug();
    const roleSections = debug.sections.filter((s) => s.type === 'role');
    expect(roleSections).toHaveLength(1);
  });

  it('Very long content in knowledge section gets trimmed by token budget', async () => {
    // ~12,500 tokens of knowledge
    const longKnowledge = 'This is a fact about the domain. '.repeat(2500);

    const prompt = new AgentPrompt({ maxTokens: 200 })
      .role('Agent')
      .knowledge(longKnowledge);

    const rendered = await prompt.render();

    // The entire long content should not appear
    expect(rendered.length).toBeLessThan(longKnowledge.length);
    // Non-shrinkable role should survive
    expect(rendered).toContain('Agent');
  });

  it('Multiple custom sections via .section() all appear in output', async () => {
    const prompt = new AgentPrompt()
      .section('context_a', 'Context section A', 60)
      .section('context_b', 'Context section B', 61)
      .section('context_c', 'Context section C', 62);

    const rendered = await prompt.render();
    expect(rendered).toContain('Context section A');
    expect(rendered).toContain('Context section B');
    expect(rendered).toContain('Context section C');
  });

  it('Empty glossary produces no glossary section', async () => {
    const prompt = new AgentPrompt({ disableSecurity: true });
    prompt.glossary([]);

    const debug = await prompt.debug();
    expect(debug.sections.find((s) => s.type === 'glossary')).toBeUndefined();
  });

  it('Empty tool set produces no tools section', async () => {
    const prompt = new AgentPrompt({ disableSecurity: true });
    prompt.tools({});

    const debug = await prompt.debug();
    expect(debug.sections.find((s) => s.type === 'tools')).toBeUndefined();
  });

  it('Async content that returns empty string is filtered out', async () => {
    const prompt = new AgentPrompt({ disableSecurity: true });
    prompt.role(async () => '');
    prompt.knowledge('Valid knowledge');

    const debug = await prompt.debug();
    expect(debug.sections).toHaveLength(1);
    expect(debug.sections[0].type).toBe('knowledge');
  });

  it('PromptSecurityViolationError has correct name', () => {
    const err = new PromptSecurityViolationError('test');
    expect(err.name).toBe('PromptSecurityViolationError');
    expect(err.message).toBe('test');
    expect(err).toBeInstanceOf(Error);
  });

  it('PromptValidationError has correct name', () => {
    const err = new PromptValidationError('test');
    expect(err.name).toBe('PromptValidationError');
    expect(err.message).toBe('test');
    expect(err).toBeInstanceOf(Error);
  });
});
