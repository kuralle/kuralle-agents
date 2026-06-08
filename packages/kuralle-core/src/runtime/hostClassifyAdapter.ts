import type { classifyHostTarget, HostSelection, ClassifyHostOptions } from './select.js';
import type { HostGuardVerdict } from './select.js';

export function adaptHostSelect(
  select: typeof import('./select.js').selectHostTarget,
): typeof classifyHostTarget {
  return async (options: ClassifyHostOptions): Promise<HostGuardVerdict> => {
    const selection: HostSelection = await select({
      agent: options.agent,
      run: options.run,
      model: options.model,
      excludeFlowNames: options.excludeFlowNames,
    });
    if (selection.kind === 'keep') {
      return { action: 'keep', confidence: 1 };
    }
    if (selection.kind === 'enterFlow') {
      return { action: 'enterFlow', flowName: selection.flow.name };
    }
    return {
      action: 'transfer',
      targetAgentId: selection.agentId,
      reason: selection.reason,
    };
  };
}
