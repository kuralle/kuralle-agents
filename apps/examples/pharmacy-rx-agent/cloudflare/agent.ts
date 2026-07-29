import { createOpenAI } from '@ai-sdk/openai';
import { createModels } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { KuralleAgent, type HarnessConfig } from '@kuralle-agents/cf-agent';
import { sqlFileSystem } from '@kuralle-agents/fs';
import { PiDriver } from '@kuralle-agents/pi-driver';
import { buildPharmacyAgent } from '../src/agent.js';

const models = createModels();
models.setProvider(openaiProvider());

/** One durable coordination atom per chat session, including messages, cart, notes, and traces. */
export class PharmacyAgent extends KuralleAgent<Env> {
  private notesFileSystem() {
    return sqlFileSystem(this.getSqlStorage(), { namespace: 'pharmacy_notes' });
  }

  protected getAgents(): HarnessConfig['agents'] {
    const modelId = this.env.MODEL_ID || 'gpt-4.1-mini';
    const model = createOpenAI({ apiKey: this.env.OPENAI_API_KEY })(modelId);
    return [buildPharmacyAgent({ model, notesFileSystem: this.notesFileSystem() })];
  }

  protected getDefaultAgentId(): string {
    return 'pharmacy';
  }

  protected getRuntimeConfig(): Partial<HarnessConfig> {
    const modelId = this.env.MODEL_ID || 'gpt-4.1-mini';
    const model = models.getModel('openai', modelId);
    if (!model) throw new Error(`Pi model openai:${modelId} is not registered.`);
    return {
      driver: new PiDriver({
        model,
        models,
        getApiKey: () => this.env.OPENAI_API_KEY,
        maxSteps: 18,
      }),
    };
  }
}
