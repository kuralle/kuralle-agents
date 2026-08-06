import { createOpenAI } from '@ai-sdk/openai';
import { createXai } from '@ai-sdk/xai';
import type { LanguageModel } from 'ai';

/**
 * The one place this example decides which model its agents run on.
 *
 * Both entry points — the Hono server and the live e2e scenario — need the same choice, and
 * for a while each carried its own copy behind a different environment variable
 * (`MARKETING_TEAM_PROVIDER` and `E2E_PROVIDER`). Two names for one concept is a trap: you set
 * the one you remember, the other entry point silently keeps the old vendor, and the resulting
 * "but I switched providers" confusion costs more than the duplication ever saved.
 *
 * Provider is selected rather than assumed because pinning to one vendor makes an exhausted
 * quota fatal. That is not hypothetical: `OPENAI_API_KEY` hit `credit_balance_exhausted`
 * mid-verification on 2026-08-04 while a working `XAI_API_KEY` sat unused in the same
 * environment, and the server — hardcoded to OpenAI — exited rather than degrade. Both are
 * real providers behind the same AI SDK `LanguageModel` interface; nothing else in the runtime
 * wiring changes when you switch.
 */
export type MarketingProvider = 'openai' | 'xai';

/** Default model per provider. Override either with `OPENAI_MODEL` / `XAI_MODEL`. */
const DEFAULT_MODEL: Record<MarketingProvider, string> = {
  openai: 'gpt-4.1-mini',
  xai: 'grok-4-fast',
};

/**
 * Resolves the configured provider. OpenAI unless `MARKETING_TEAM_PROVIDER=xai`.
 *
 * An unrecognised value throws rather than falling back: silently running on a vendor the
 * operator did not ask for is precisely the failure this module exists to prevent.
 */
export function selectProvider(): MarketingProvider {
  const raw = process.env.MARKETING_TEAM_PROVIDER?.trim().toLowerCase();
  if (!raw) return 'openai';
  if (raw === 'openai' || raw === 'xai') return raw;
  throw new Error(
    `MARKETING_TEAM_PROVIDER="${raw}" is not a known provider. Use "openai" or "xai".`,
  );
}

/** The `LanguageModel` every agent in this example is built with. */
export function selectModel(): LanguageModel {
  const provider = selectProvider();

  if (provider === 'xai') {
    const apiKey = process.env.XAI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error('MARKETING_TEAM_PROVIDER=xai but XAI_API_KEY is not set.');
    }
    return createXai({ apiKey })(process.env.XAI_MODEL?.trim() || DEFAULT_MODEL.xai);
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY is required. Add it to apps/examples/marketing-team/.env (see ' +
        '.env.example), or set MARKETING_TEAM_PROVIDER=xai with XAI_API_KEY.',
    );
  }
  return createOpenAI({ apiKey })(process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL.openai);
}
