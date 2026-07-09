import type { PromptTemplate } from './types.js';
import { BUILTIN_TEMPLATES } from './templates.js';

// Global template registry
const templateRegistry: Record<string, PromptTemplate> = { ...BUILTIN_TEMPLATES };

export function getTemplate(id: string): PromptTemplate | undefined {
  return templateRegistry[id];
}

export function registerTemplate(template: PromptTemplate): void {
  templateRegistry[template.id] = template;
}

export function listTemplates(): string[] {
  return Object.keys(templateRegistry);
}

export function getAllTemplates(): Record<string, PromptTemplate> {
  return { ...templateRegistry };
}
