import type { LanguageModel } from 'ai';
import type { HandoffInputFilter } from '../runtime/handoffFilters.js';

export interface Route {
  agent?: string;
  flow?: string;
  when: string;
  filter?: HandoffInputFilter;
}

export interface RoutingPolicy {
  /** `'tools'` folds flow entry into the speaking turn via an `enter_flow` tool
   *  (no upfront `generateObject` selector on keep turns). `'structured'`/`'llm'`
   *  run the classic pre-generation host selector. Default: legacy selector. */
  mode?: 'structured' | 'llm' | 'tools';
  model?: LanguageModel;
  default?: string;
  always?: boolean;
}

export type { HandoffInputFilter } from '../runtime/handoffFilters.js';
