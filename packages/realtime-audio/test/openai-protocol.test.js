import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSessionUpdate,
  formatToMime,
  geminiDeclToOpenAITool,
  OPENAI_REALTIME_CAPABILITIES,
} from '../dist/openai/protocol.js';

describe('OpenAI Realtime protocol — buildSessionUpdate', () => {
  it('emits a session.update envelope with the configured model', () => {
    const out = buildSessionUpdate(
      { systemInstruction: 'be brief' },
      { defaultModel: 'gpt-realtime' },
    );
    assert.equal(out.type, 'session.update');
    assert.equal(out.session.model, 'gpt-realtime');
    assert.equal(out.session.instructions, 'be brief');
  });

  it("defaults audio formats to pcm16 when not provided", () => {
    const out = buildSessionUpdate(
      { systemInstruction: 'x' },
      { defaultModel: 'gpt-realtime' },
    );
    assert.equal(out.session.audio.input.format.type, 'audio/pcm16');
    assert.equal(out.session.audio.output.format.type, 'audio/pcm16');
  });

  it('honors explicit pcmu telephony formats for SIP zero-resample', () => {
    const out = buildSessionUpdate(
      {
        systemInstruction: 'x',
        audio: { inputFormat: 'pcmu', outputFormat: 'pcmu' },
      },
      { defaultModel: 'gpt-realtime' },
    );
    assert.equal(out.session.audio.input.format.type, 'audio/pcmu');
    assert.equal(out.session.audio.output.format.type, 'audio/pcmu');
  });

  it('omits voice when not configured, includes it when set', () => {
    const a = buildSessionUpdate({ systemInstruction: 'x' }, { defaultModel: 'gpt-realtime' });
    assert.equal(a.session.audio.output.voice, undefined);
    const b = buildSessionUpdate(
      { systemInstruction: 'x', voice: 'alloy' },
      { defaultModel: 'gpt-realtime' },
    );
    assert.equal(b.session.audio.output.voice, 'alloy');
  });

  it('emits tools array + tool_choice only when tools are present', () => {
    const a = buildSessionUpdate({ systemInstruction: 'x' }, { defaultModel: 'gpt-realtime' });
    assert.equal(a.session.tools, undefined);
    assert.equal(a.session.tool_choice, undefined);
    const b = buildSessionUpdate(
      {
        systemInstruction: 'x',
        tools: [
          { name: 'echo', description: 'e', parameters: { type: 'object', properties: {} } },
        ],
      },
      { defaultModel: 'gpt-realtime' },
    );
    assert.equal(b.session.tools.length, 1);
    assert.equal(b.session.tool_choice, 'auto');
    assert.equal(b.session.tools[0].type, 'function');
    assert.equal(b.session.tools[0].name, 'echo');
  });

  it('prefers config.model over defaultModel', () => {
    const out = buildSessionUpdate(
      { systemInstruction: 'x', model: 'gpt-realtime-2025-08-28' },
      { defaultModel: 'gpt-realtime' },
    );
    assert.equal(out.session.model, 'gpt-realtime-2025-08-28');
  });

  it('uses semantic_vad turn_detection by default', () => {
    const out = buildSessionUpdate({ systemInstruction: 'x' }, { defaultModel: 'gpt-realtime' });
    assert.equal(out.session.audio.input.turn_detection.type, 'semantic_vad');
    assert.equal(out.session.audio.input.turn_detection.eagerness, 'medium');
  });
});

describe('formatToMime', () => {
  it('maps pcm16/pcmu/pcma to MIME', () => {
    assert.equal(formatToMime('pcm16'), 'audio/pcm16');
    assert.equal(formatToMime('pcmu'), 'audio/pcmu');
    assert.equal(formatToMime('pcma'), 'audio/pcma');
  });
});

describe('geminiDeclToOpenAITool', () => {
  it('wraps name/description/parameters in OpenAI function envelope', () => {
    const out = geminiDeclToOpenAITool({
      name: 'lookup',
      description: 'lookup a thing',
      parameters: { type: 'object', properties: { id: { type: 'string' } } },
    });
    assert.equal(out.type, 'function');
    assert.equal(out.name, 'lookup');
    assert.equal(out.description, 'lookup a thing');
    assert.deepEqual(out.parameters, { type: 'object', properties: { id: { type: 'string' } } });
  });
});

describe('OPENAI_REALTIME_CAPABILITIES', () => {
  it('declares mid-session updates + tool support', () => {
    assert.equal(OPENAI_REALTIME_CAPABILITIES.midSessionInstructionsUpdate, true);
    assert.equal(OPENAI_REALTIME_CAPABILITIES.midSessionToolsUpdate, true);
    assert.equal(OPENAI_REALTIME_CAPABILITIES.manualFunctionCalls, true);
  });
});
