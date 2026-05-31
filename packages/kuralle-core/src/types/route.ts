import type { LanguageModel } from 'ai';
import type { HandoffInputFilter } from '../runtime/handoffFilters.js';

export interface Route {
  agent?: string;
  flow?: string;
  when: string;
  filter?: HandoffInputFilter;
}

export interface RoutingPolicy {
  mode?: 'structured' | 'llm';
  model?: LanguageModel;
  default?: string;
  always?: boolean;
}

export type { HandoffInputFilter } from '../runtime/handoffFilters.js';
