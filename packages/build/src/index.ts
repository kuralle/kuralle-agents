export { compileAgentDirectory } from './compiler.js';
export { generateCapabilityRegistrySource } from './codegen.js';
export { AgentBuildError } from './errors.js';
export { analyzeModule } from './module-analysis.js';
export {
  DEFAULT_BUILD_QUOTAS,
  type BuildDiagnostic,
  type BuildDiagnosticCode,
  type BuildQuotas,
  type BuildTarget,
  type CapabilityModule,
  type CompileAgentDirectoryOptions,
  type CompiledAgentProject,
  type SerializableAgentFile,
} from './types.js';
