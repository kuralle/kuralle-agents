// FINDING 5: instructions-only or tools-only agents derive to free-conversation shape; precedence routes -> flows -> free | anchor src/runtime/deriveAgent.ts:68, :84 | why this proves it
import { describe, expect, it } from 'bun:test';
import type { AgentConfig } from '../../src/types/agentConfig.js';
import { deriveAgentCapabilities, deriveAgentShape } from '../../src/runtime/deriveAgent.js';

describe('F5: agent shape and capability precedence defaults', () => {
  it('instructions-only agent is answering agent without local procedure', () => {
    const agent = { instructions: 'hi' } as unknown as AgentConfig;
    const shape = deriveAgentShape(agent);

    expect(shape.isAnsweringAgent).toBe(true);
    expect(shape.hasLocalProcedure).toBe(false);
    expect(shape.isPureDispatcher).toBe(false);
  });

  it('tools-only agent is answering agent without local procedure', () => {
    const agent = { tools: { x: {} } } as unknown as AgentConfig;
    const shape = deriveAgentShape(agent);

    expect(shape.isAnsweringAgent).toBe(true);
    expect(shape.hasLocalProcedure).toBe(false);
    expect(shape.isPureDispatcher).toBe(false);
  });

  it('capability precedence is routes -> flows -> free for single-field agents', () => {
    const instructionsOnly = { instructions: 'hi' } as unknown as AgentConfig;
    expect(deriveAgentCapabilities(instructionsOnly).precedence).toBe('free');

    const flowsOnly = {
      flows: [{ name: 'f', nodes: [], start: 's' }],
    } as unknown as AgentConfig;
    expect(deriveAgentCapabilities(flowsOnly).precedence).toBe('flows');

    const routesOnly = {
      routes: [{ intent: 'x', agent: 'a' }],
    } as unknown as AgentConfig;
    expect(deriveAgentCapabilities(routesOnly).precedence).toBe('routes');
  });

  it('routes win over flows when both are present', () => {
    const mixed = {
      routes: [{ intent: 'x', agent: 'a' }],
      flows: [{ name: 'f', nodes: [], start: 's' }],
    } as unknown as AgentConfig;
    expect(deriveAgentCapabilities(mixed).precedence).toBe('routes');
  });

  it('flows win over free answering surface when both are present', () => {
    const mixed = {
      flows: [{ name: 'f', nodes: [], start: 's' }],
      instructions: 'hi',
    } as unknown as AgentConfig;
    expect(deriveAgentCapabilities(mixed).precedence).toBe('flows');
  });
});