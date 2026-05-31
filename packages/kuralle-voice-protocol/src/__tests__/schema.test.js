import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { toolSetToJsonSchema, toLiveKitToolParameters } from '../../dist/schema.js';

describe('toolSetToJsonSchema', () => {
  const toolSet = {
    get_weather: {
      description: 'Get the current weather for a city',
      inputSchema: z.object({
        city: z.string().describe('City name'),
        unit: z.enum(['c', 'f']).optional(),
      }),
    },
    echo: {
      description: 'Echo a value',
      inputSchema: z.object({ value: z.string() }),
    },
  };

  it('returns a declaration per tool for gemini target', () => {
    const decls = toolSetToJsonSchema(toolSet, 'gemini');
    assert.equal(decls.length, 2);
    const names = decls.map(d => d.name).sort();
    assert.deepEqual(names, ['echo', 'get_weather']);
  });

  it('produces identical output across gemini, openai, livekit targets', () => {
    const a = toolSetToJsonSchema(toolSet, 'gemini');
    const b = toolSetToJsonSchema(toolSet, 'openai');
    const c = toolSetToJsonSchema(toolSet, 'livekit');
    assert.deepEqual(a, b);
    assert.deepEqual(b, c);
  });

  it('carries description through to the declaration', () => {
    const [decl] = toolSetToJsonSchema({ x: { description: 'Hi', inputSchema: z.object({}) } }, 'gemini');
    assert.equal(decl.description, 'Hi');
  });

  it('falls back to empty object schema when no inputSchema is present', () => {
    const [decl] = toolSetToJsonSchema({ x: { description: 'Hi' } }, 'gemini');
    assert.equal(decl.parameters.type, 'object');
    assert.deepEqual(decl.parameters.properties, {});
  });

  it('emits openApi3 style JSON schema (no "$ref" at top level)', () => {
    const [decl] = toolSetToJsonSchema(toolSet, 'gemini');
    assert.equal(decl.parameters.type, 'object');
    assert.ok(decl.parameters.properties);
    assert.ok(decl.parameters.properties.city);
  });

  it('reads the `parameters` field when `inputSchema` is absent (livekit-style)', () => {
    const [decl] = toolSetToJsonSchema(
      { x: { description: 'x', parameters: z.object({ k: z.string() }) } },
      'livekit',
    );
    assert.ok(decl.parameters.properties.k);
  });

  it('defaults description to empty string when missing', () => {
    const [decl] = toolSetToJsonSchema({ x: { inputSchema: z.object({}) } }, 'gemini');
    assert.equal(decl.description, '');
  });
});

describe('toLiveKitToolParameters', () => {
  const schema = {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  };

  it("returns the JSON Schema unchanged in 'json-schema' mode", () => {
    const out = toLiveKitToolParameters(schema, 'json-schema');
    assert.equal(out, schema);
  });

  it("returns a passthrough Zod schema in 'passthrough' mode", () => {
    const out = toLiveKitToolParameters(schema, 'passthrough');
    assert.equal(typeof out.parse, 'function');
    const v = out.parse({ anything: 1, goes: 'here' });
    assert.deepEqual(v, { anything: 1, goes: 'here' });
  });

  it("falls back to passthrough when schema is malformed in 'json-schema' mode", () => {
    const malformed = { type: 'array' };
    const out = toLiveKitToolParameters(malformed, 'json-schema');
    assert.equal(typeof out.parse, 'function');
  });

  it('falls back to passthrough when schema is null/undefined', () => {
    const out1 = toLiveKitToolParameters(undefined, 'json-schema');
    const out2 = toLiveKitToolParameters(null, 'json-schema');
    assert.equal(typeof out1.parse, 'function');
    assert.equal(typeof out2.parse, 'function');
  });
});
