/**
 * Shared live-model selector for smoke tests.
 *
 * The repo `.env` keys rotate; OpenAI is currently 401 while Google + xAI are live.
 * Smoke tests must verify a REAL turn against a REAL provider — which provider is
 * incidental. This returns the first provider whose key is present, in order
 * Google → xAI → OpenAI, so smoke tests survive any single key going stale.
 */
import { config } from 'dotenv';
import { resolve } from 'node:path';
import type { LanguageModel } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createXai } from '@ai-sdk/xai';
import { createOpenAI } from '@ai-sdk/openai';

config({ path: resolve(import.meta.dir, '../../.env') });
config({ path: resolve(import.meta.dir, '../../../../.env') });

export interface LiveModel {
  model: LanguageModel;
  label: string;
}

/** First provider with a present API key, or null if none are configured. */
export function liveModel(): LiveModel | null {
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
  const openai = process.env.OPENAI_API_KEY;
  if (openai) {
    return { model: createOpenAI({ apiKey: openai })('gpt-4o-mini'), label: 'openai:gpt-4o-mini' };
  }
  return null;
}
