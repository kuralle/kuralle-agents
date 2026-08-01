import { KuralleThreadAgent } from '@kuralle-agents/cf-agent';
import { routeAgentRequest } from 'agents';

export default function createHost() {
  class TestThreadAgent extends KuralleThreadAgent<Record<string, unknown>> {
    protected authorizeThreadInitialization(): boolean { return false; }
    protected async assignThread(): Promise<never> { throw new Error('test host'); }
    protected async bindPinnedAgent(): Promise<never> { throw new Error('test host'); }
  }

  return {
    agent: TestThreadAgent,
    worker: {
      async fetch(request: Request, env: unknown): Promise<Response> {
        return (await routeAgentRequest(request, env)) ?? new Response('Not found', { status: 404 });
      },
    },
  };
}
