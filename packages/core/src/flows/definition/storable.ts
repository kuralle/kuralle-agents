import type { Flow } from '../../types/flow.js';
import type { FlowDefinition } from './types.js';

export const STORABLE_FLOW_DEFINITION = Symbol.for('kuralle.storableFlowDefinition');

type StashHolder = {
  [STORABLE_FLOW_DEFINITION]?: FlowDefinition;
};

export function stashFlowDefinition(flow: Flow, def: FlowDefinition): Flow {
  Object.defineProperty(flow, STORABLE_FLOW_DEFINITION, {
    value: def,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return flow;
}

export function readStashedFlowDefinition(flow: Flow): FlowDefinition | undefined {
  return (flow as Flow & StashHolder)[STORABLE_FLOW_DEFINITION];
}
