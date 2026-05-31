import { config } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageModel } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';

export function loadTemplateEnv(importMetaUrl: string): void {
	const dir = dirname(fileURLToPath(importMetaUrl));
	config({ path: join(dir, '../.env') });
	config({ path: join(dir, '../../../../.env') });
}

export function resolveTemplateModel(): { model: LanguageModel; label: string } {
	const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
	if (googleKey) {
		return {
			model: createGoogleGenerativeAI({ apiKey: googleKey })('gemini-2.0-flash'),
			label: 'google:gemini-2.0-flash',
		};
	}
	const openaiKey = process.env.OPENAI_API_KEY;
	if (openaiKey) {
		return {
			model: createOpenAI({ apiKey: openaiKey })(process.env.OPENAI_MODEL ?? 'gpt-4o-mini'),
			label: `openai:${process.env.OPENAI_MODEL ?? 'gpt-4o-mini'}`,
		};
	}
	throw new Error('GOOGLE_GENERATIVE_AI_API_KEY or OPENAI_API_KEY required for live validation');
}
