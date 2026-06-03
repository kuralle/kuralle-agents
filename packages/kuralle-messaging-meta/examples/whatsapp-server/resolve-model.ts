import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createXai } from '@ai-sdk/xai';
import type { LanguageModel } from 'ai';

export interface LiveModel {
  model: LanguageModel;
  label: string;
}

type ExampleProvider = 'openai' | 'google' | 'xai';

function resolveExampleProviderOverride(): ExampleProvider | null {
  const raw = process.env.KURALLE_EXAMPLE_PROVIDER?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'openai' || raw === 'google' || raw === 'xai') return raw;
  throw new Error(
    `Invalid KURALLE_EXAMPLE_PROVIDER="${process.env.KURALLE_EXAMPLE_PROVIDER}" (expected openai, google, or xai)`,
  );
}

function liveModelForProvider(provider: ExampleProvider): LiveModel {
  if (provider === 'google') {
    const google = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!google) {
      throw new Error(
        'KURALLE_EXAMPLE_PROVIDER=google but GOOGLE_GENERATIVE_AI_API_KEY is not set',
      );
    }
    return {
      model: createGoogleGenerativeAI({ apiKey: google })('gemini-2.0-flash'),
      label: 'google:gemini-2.0-flash',
    };
  }
  if (provider === 'xai') {
    const xai = process.env.XAI_API_KEY;
    if (!xai) {
      throw new Error('KURALLE_EXAMPLE_PROVIDER=xai but XAI_API_KEY is not set');
    }
    return { model: createXai({ apiKey: xai })('grok-2-1212'), label: 'xai:grok-2-1212' };
  }
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    throw new Error('KURALLE_EXAMPLE_PROVIDER=openai but OPENAI_API_KEY is not set');
  }
  return {
    model: createOpenAI({ apiKey: openaiKey })(process.env.OPENAI_MODEL ?? 'gpt-4o-mini'),
    label: `openai:${process.env.OPENAI_MODEL ?? 'gpt-4o-mini'}`,
  };
}

export function resolveLiveModel(): LiveModel | null {
  const override = resolveExampleProviderOverride();
  if (override) {
    return liveModelForProvider(override);
  }

  const google = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (google) {
    return {
      model: createGoogleGenerativeAI({ apiKey: google })('gemini-2.0-flash'),
      label: 'google:gemini-2.0-flash',
    };
  }
  const xai = process.env.XAI_API_KEY;
  if (xai) {
    return { model: createXai({ apiKey: xai })('grok-2-1212'), label: 'xai:grok-2-1212' };
  }
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    return {
      model: createOpenAI({ apiKey: openaiKey })(process.env.OPENAI_MODEL ?? 'gpt-4o-mini'),
      label: `openai:${process.env.OPENAI_MODEL ?? 'gpt-4o-mini'}`,
    };
  }
  return null;
}
