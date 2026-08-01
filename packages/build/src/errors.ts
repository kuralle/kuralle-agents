import type { BuildDiagnostic } from './types.js';

export class AgentBuildError extends Error {
  constructor(readonly diagnostics: BuildDiagnostic[]) {
    super(`agent build failed with ${diagnostics.length} diagnostic${diagnostics.length === 1 ? '' : 's'}`);
    this.name = 'AgentBuildError';
  }
}
