import type { TemplateInfo } from '@kuralle-agents/messaging-meta/whatsapp';

import type { TemplateCatalog, TemplateDescriptor } from './strategist.js';

export interface WhatsAppTemplateCatalogClient {
  templates: {
    list(wabaId: string): Promise<TemplateInfo[]>;
  };
}

const PLACEHOLDER_RE = /\{\{([^}]+)\}\}/g;

function mapStatus(status: string): TemplateDescriptor['status'] {
  const upper = status.toUpperCase();
  if (upper === 'APPROVED' || upper === 'PENDING' || upper === 'REJECTED') {
    return upper;
  }
  return 'PENDING';
}

function mapCategory(category: string): TemplateDescriptor['category'] {
  const lower = category.toLowerCase();
  if (lower === 'authentication' || lower === 'marketing' || lower === 'utility') {
    return lower;
  }
  return 'utility';
}

function mapQuality(quality?: string): TemplateDescriptor['quality'] {
  if (!quality) return 'UNKNOWN';
  const upper = quality.toUpperCase();
  if (
    upper === 'GREEN' ||
    upper === 'YELLOW' ||
    upper === 'RED' ||
    upper === 'PAUSED' ||
    upper === 'DISABLED'
  ) {
    return upper;
  }
  return 'UNKNOWN';
}

function deriveParams(info: TemplateInfo): TemplateDescriptor['params'] {
  const keys = new Set<string>();
  for (const component of info.components) {
    const text = component.text;
    if (!text) continue;
    for (const match of text.matchAll(PLACEHOLDER_RE)) {
      const key = match[1]?.trim();
      if (key) keys.add(key);
    }
  }
  return [...keys].map((key) => ({ key, required: true }));
}

export function mapTemplateInfoToDescriptor(info: TemplateInfo): TemplateDescriptor {
  return {
    name: info.name,
    language: info.language,
    category: mapCategory(info.category),
    status: mapStatus(info.status),
    quality: mapQuality(info.quality),
    params: deriveParams(info),
  };
}

export function isApprovedNonPaused(descriptor: TemplateDescriptor, info: TemplateInfo): boolean {
  if (descriptor.status !== 'APPROVED') return false;
  if (info.paused === true) return false;
  if (descriptor.quality === 'PAUSED' || descriptor.quality === 'DISABLED') return false;
  return true;
}

export function whatsappTemplateCatalog(opts: {
  client: WhatsAppTemplateCatalogClient;
  wabaId: string;
}): TemplateCatalog {
  let approvedCache: TemplateDescriptor[] | null = null;
  let descriptorByName: Map<string, TemplateDescriptor> | null = null;

  async function ensureLoaded(): Promise<void> {
    if (approvedCache !== null) return;
    const rows = await opts.client.templates.list(opts.wabaId);
    const byName = new Map<string, TemplateDescriptor>();
    const approved: TemplateDescriptor[] = [];
    for (const info of rows) {
      const descriptor = mapTemplateInfoToDescriptor(info);
      byName.set(descriptor.name, descriptor);
      if (isApprovedNonPaused(descriptor, info)) {
        approved.push(descriptor);
      }
    }
    descriptorByName = byName;
    approvedCache = approved;
  }

  return {
    async approved() {
      await ensureLoaded();
      return approvedCache!;
    },
    validateParams(name, params) {
      if (!descriptorByName) {
        return { ok: false, errors: ['unknown template'] };
      }
      const descriptor = descriptorByName.get(name);
      if (!descriptor) {
        return { ok: false, errors: ['unknown template'] };
      }
      const errors: string[] = [];
      for (const { key, required } of descriptor.params) {
        if (required && (params[key] === undefined || params[key] === '')) {
          errors.push(`missing required param: ${key}`);
        }
      }
      const declared = new Set(descriptor.params.map((p) => p.key));
      for (const key of Object.keys(params)) {
        if (!declared.has(key)) {
          errors.push(`unknown param: ${key}`);
        }
      }
      return errors.length > 0 ? { ok: false, errors } : { ok: true };
    },
  };
}
