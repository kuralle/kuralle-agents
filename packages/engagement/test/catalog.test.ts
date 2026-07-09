import { describe, it, expect } from 'bun:test';
import type { TemplateInfo } from '@kuralle-agents/messaging-meta/whatsapp';

import { whatsappTemplateCatalog } from '../src/catalog.js';

function fixture(
  overrides: Partial<TemplateInfo> & Pick<TemplateInfo, 'name' | 'status'>,
): TemplateInfo {
  return {
    id: overrides.id ?? `id-${overrides.name}`,
    name: overrides.name,
    language: overrides.language ?? 'en',
    status: overrides.status,
    category: overrides.category ?? 'UTILITY',
    components: overrides.components ?? [
      { type: 'BODY', text: 'Hello {{1}}, order {{2}}' },
    ],
    quality: overrides.quality,
    paused: overrides.paused,
  };
}

describe('catalog_filters_approved_nonpaused', () => {
  it('returns only APPROVED non-paused templates', async () => {
    const templates: TemplateInfo[] = [
      fixture({ name: 'good_one', status: 'APPROVED', quality: 'GREEN' }),
      fixture({ name: 'pending_one', status: 'PENDING' }),
      fixture({ name: 'rejected_one', status: 'REJECTED' }),
      fixture({ name: 'paused_flag', status: 'APPROVED', paused: true }),
      fixture({ name: 'paused_quality', status: 'APPROVED', quality: 'PAUSED' }),
    ];

    let listCalls = 0;
    const catalog = whatsappTemplateCatalog({
      wabaId: 'waba-123',
      client: {
        templates: {
          list: async () => {
            listCalls += 1;
            return templates;
          },
        },
      },
    });

    const approved = await catalog.approved();
    expect(listCalls).toBe(1);
    expect(approved.map((t) => t.name)).toEqual(['good_one']);
    expect(approved[0]?.status).toBe('APPROVED');
    expect(approved[0]?.quality).toBe('GREEN');
    expect(approved[0]?.params).toEqual([
      { key: '1', required: true },
      { key: '2', required: true },
    ]);
  });
});

describe('catalog_caches_approved', () => {
  it('does not refetch on a second approved() call', async () => {
    let listCalls = 0;
    const catalog = whatsappTemplateCatalog({
      wabaId: 'waba-456',
      client: {
        templates: {
          list: async () => {
            listCalls += 1;
            return [fixture({ name: 'cached_tpl', status: 'APPROVED' })];
          },
        },
      },
    });

    await catalog.approved();
    await catalog.approved();
    expect(listCalls).toBe(1);
  });
});

describe('validateParams', () => {
  it('accepts required params and rejects missing or unknown keys', async () => {
    const catalog = whatsappTemplateCatalog({
      wabaId: 'waba-789',
      client: {
        templates: {
          list: async () => [
            fixture({
              name: 'order_update',
              status: 'APPROVED',
              components: [{ type: 'BODY', text: 'Hi {{name}}, ref {{ref}}' }],
            }),
          ],
        },
      },
    });

    await catalog.approved();

    expect(catalog.validateParams('order_update', { name: 'Ada', ref: '42' })).toEqual({
      ok: true,
    });
    expect(catalog.validateParams('order_update', { name: 'Ada' }).ok).toBe(false);
    expect(catalog.validateParams('missing_tpl', { name: 'x' })).toEqual({
      ok: false,
      errors: ['unknown template'],
    });
    expect(catalog.validateParams('order_update', { name: 'Ada', ref: '1', extra: 'nope' }).ok).toBe(
      false,
    );
  });
});
