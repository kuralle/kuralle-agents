import type { LanguageModel } from 'ai';
import type { HandoffInputFilter } from '../runtime/handoffFilters.js';

export interface Route {
  agent?: string;
  flow?: string;
  when: string;
  filter?: HandoffInputFilter;
}

export interface RoutingPolicy {
  /** Model for control-path reasoning (guard, pure-dispatcher classifier). */
  model?: LanguageModel;
  /** Buffer text until guard/control resolves (compliance text). Default: relaxed cancel-on-late-control. */
  dispatch?: 'strict';
}

export type { HandoffInputFilter } from '../runtime/handoffFilters.js';
