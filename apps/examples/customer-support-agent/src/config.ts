import { z } from 'zod';

const knowledgeArticleSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  title: z.string().min(3).max(120),
  body: z.string().min(20).max(20_000),
  url: z.string().url().optional(),
  lastModified: z.string().date().optional(),
  tags: z.array(z.string().min(1).max(40)).max(12).default([]),
});

const supportConfigSchema = z.object({
  brand: z.object({
    companyName: z.string().min(2).max(60),
    agentName: z.string().min(2).max(60),
    productName: z.string().min(2).max(80),
    tagline: z.string().min(8).max(180),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }),
  behavior: z.object({
    voice: z.string().min(20).max(800),
    scope: z.string().min(20).max(1_500),
    unavailableMessage: z.string().min(12).max(300),
  }),
  humanSupport: z.object({
    hours: z.string().min(3).max(120),
    timezone: z.string().min(3).max(80),
    estimatedWaitMinutes: z.number().int().positive().max(1_440),
  }),
  orderIdPattern: z.string().min(2).max(120),
  starterPrompts: z.array(z.string().min(3).max(180)).min(3).max(6),
  knowledge: z.array(knowledgeArticleSchema).min(1).max(500),
});

export type SupportTemplateConfig = z.infer<typeof supportConfigSchema>;
export type KnowledgeArticle = z.infer<typeof knowledgeArticleSchema>;

/**
 * Validates customer-owned configuration at module load, so a bad deployment
 * fails before it can answer with incomplete or malformed policy data.
 */
export function defineSupportConfig(config: SupportTemplateConfig): SupportTemplateConfig {
  return supportConfigSchema.parse(config);
}

export function publicSupportConfig(config: SupportTemplateConfig) {
  return {
    brand: config.brand,
    humanSupport: config.humanSupport,
    starterPrompts: config.starterPrompts,
  };
}

export type PublicSupportConfig = ReturnType<typeof publicSupportConfig>;
