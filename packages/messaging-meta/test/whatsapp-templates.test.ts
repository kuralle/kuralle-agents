import { describe, it, expect } from 'bun:test';
import { buildTemplateSendPayload, buildTemplatePayload } from '../src/whatsapp/templates.ts';

describe('buildTemplateSendPayload', () => {
  it('builds a simple body-only template', () => {
    const result = buildTemplateSendPayload({
      name: 'hello_world',
      language: 'en_US',
      body: [{ type: 'text', text: 'John' }],
    });

    expect(result.name).toBe('hello_world');
    expect(result.language).toEqual({ code: 'en_US' });
    expect(result.components).toHaveLength(1);
    expect(result.components![0].type).toBe('body');
    expect(result.components![0].parameters).toEqual([{ type: 'text', text: 'John' }]);
  });

  it('builds a template with text header', () => {
    const result = buildTemplateSendPayload({
      name: 'welcome',
      language: 'en',
      header: { type: 'text', text: 'Welcome!' },
    });

    expect(result.components).toHaveLength(1);
    expect(result.components![0].type).toBe('header');
    expect(result.components![0].parameters).toEqual([{ type: 'text', text: 'Welcome!' }]);
  });

  it('builds a template with image header', () => {
    const result = buildTemplateSendPayload({
      name: 'promo',
      language: 'en',
      header: { type: 'image', image: { link: 'https://example.com/img.jpg' } },
    });

    expect(result.components).toHaveLength(1);
    expect(result.components![0].type).toBe('header');
    expect(result.components![0].parameters![0].type).toBe('image');
    expect(result.components![0].parameters![0].image?.link).toBe('https://example.com/img.jpg');
  });

  it('builds a template with body parameters', () => {
    const result = buildTemplateSendPayload({
      name: 'order_update',
      language: 'en_US',
      body: [
        { type: 'text', text: 'Alice' },
        { type: 'text', text: 'ORD-999' },
      ],
    });

    const bodyComp = result.components!.find((c) => c.type === 'body');
    expect(bodyComp).toBeDefined();
    expect(bodyComp!.parameters).toHaveLength(2);
    expect(bodyComp!.parameters![0].text).toBe('Alice');
    expect(bodyComp!.parameters![1].text).toBe('ORD-999');
  });

  it('builds a template with buttons', () => {
    const result = buildTemplateSendPayload({
      name: 'track_order',
      language: 'en',
      buttons: [
        {
          type: 'button',
          subType: 'url',
          index: 0,
          parameters: [{ type: 'text', text: '/track/123' }],
        },
      ],
    });

    const btnComp = result.components!.find((c) => c.type === 'button');
    expect(btnComp).toBeDefined();
    expect(btnComp!.sub_type).toBe('url');
    expect(btnComp!.index).toBe(0);
    expect(btnComp!.parameters![0].text).toBe('/track/123');
  });

  it('builds a full template with header + body + buttons', () => {
    const result = buildTemplateSendPayload({
      name: 'full_template',
      language: 'en_US',
      header: { type: 'text', text: 'Header Text' },
      body: [{ type: 'text', text: 'Body Param' }],
      buttons: [
        {
          type: 'button',
          subType: 'quick_reply',
          index: 0,
          parameters: [{ type: 'payload', payload: 'YES' }],
        },
      ],
    });

    expect(result.components).toHaveLength(3);
    expect(result.components![0].type).toBe('header');
    expect(result.components![1].type).toBe('body');
    expect(result.components![2].type).toBe('button');
  });

  it('returns no components array when no optional fields provided', () => {
    const result = buildTemplateSendPayload({
      name: 'simple',
      language: 'en',
    });

    expect(result.name).toBe('simple');
    expect(result.language).toEqual({ code: 'en' });
    expect(result.components).toBeUndefined();
  });
});

describe('buildTemplatePayload', () => {
  it('passes through name and language', () => {
    const result = buildTemplatePayload({
      name: 'raw_template',
      language: { code: 'es', policy: 'deterministic' },
      components: [],
    });

    expect(result.name).toBe('raw_template');
    expect(result.language).toEqual({ code: 'es', policy: 'deterministic' });
  });

  it('passes through components unchanged', () => {
    const components = [
      { type: 'body' as const, parameters: [{ type: 'text' as const, text: 'Hello' }] },
    ];

    const result = buildTemplatePayload({
      name: 'passthrough',
      language: { code: 'en' },
      components,
    });

    expect(result.components).toBe(components); // Same reference
    expect(result.components).toEqual(components);
  });
});
