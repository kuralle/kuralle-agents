import type { AgentConfig } from '../types/agentConfig.js';
import type { DriverOutputCapability } from '../types/channel.js';

export type DispatchMode = 'strict' | 'relaxed';

export function resolveDispatchMode(
  agent: AgentConfig,
  capability: DriverOutputCapability,
): DispatchMode {
  if (agent.routing?.dispatch === 'strict') {
    return 'strict';
  }
  switch (capability) {
    case 'kuralle-controlled-text':
      return 'relaxed';
    case 'kuralle-controlled-tts':
      return 'strict';
    case 'native-realtime':
      return 'strict';
    default:
      return 'relaxed';
  }
}

export function isAdvisoryDispatch(capability: DriverOutputCapability): boolean {
  return capability === 'native-realtime';
}
