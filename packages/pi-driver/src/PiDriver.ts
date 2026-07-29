import {
  TextDriver,
  type ChannelDriver,
  type DecideNode,
  type ResolvedNode,
  type RunContext,
  type TurnResult,
  type UserSignal,
} from '@kuralle-agents/core';
import { PiModelTurnLoop } from './PiModelTurnLoop.js';
import { PiStructuredRunner } from './PiStructuredRunner.js';
import type { PiDriverConfig } from './types.js';

/**
 * Kuralle channel driver whose speaking model/tool loop is powered by Pi.
 * Kuralle remains the sole owner of flows, policy, durable effects, and output.
 */
export class PiDriver implements ChannelDriver {
  readonly outputCapability = 'kuralle-controlled-text' as const;
  private readonly speakingDriver: TextDriver;
  private readonly typedFlowDriver: TextDriver;
  private readonly structuredRunner?: PiStructuredRunner;

  constructor(config: PiDriverConfig) {
    const typedFlows = config.typedFlows ?? 'pi';
    this.speakingDriver = new TextDriver({
      toolDefs: config.toolDefs,
      maxSteps: config.maxSteps,
      modelLoop: new PiModelTurnLoop(config),
    });
    this.typedFlowDriver = typedFlows === 'pi'
      ? this.speakingDriver
      : new TextDriver({ toolDefs: config.toolDefs, maxSteps: config.maxSteps });
    this.structuredRunner = typedFlows === 'pi' ? new PiStructuredRunner(config) : undefined;
  }

  runAgentTurn(node: ResolvedNode, ctx: RunContext): Promise<TurnResult> {
    return this.speakingDriver.runAgentTurn(node, ctx);
  }

  runExtraction(node: ResolvedNode, ctx: RunContext): Promise<TurnResult> {
    return this.typedFlowDriver.runExtraction(node, ctx);
  }

  runStructured(node: DecideNode, ctx: RunContext): Promise<unknown> {
    return this.structuredRunner?.run(node, ctx) ?? this.typedFlowDriver.runStructured(node, ctx);
  }

  awaitUser(ctx: RunContext): Promise<UserSignal> {
    return this.speakingDriver.awaitUser(ctx);
  }
}
