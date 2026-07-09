import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { OpenAIFamilySessionState } from '../dist/cloudflare/openai-family/session-state.js';

describe('OpenAIFamilySessionState', () => {
  it('starts in IDLE', () => {
    const s = new OpenAIFamilySessionState();
    assert.equal(s.current, 'IDLE');
    assert.equal(s.isActive, false);
    assert.equal(s.isQuiescent, true);
  });

  it('transitions IDLE → CONNECTING → ACTIVE', () => {
    const s = new OpenAIFamilySessionState();
    s.beginConnect('test');
    assert.equal(s.current, 'CONNECTING');
    assert.equal(s.isActive, false);
    assert.equal(s.isQuiescent, false);
    s.markActive();
    assert.equal(s.current, 'ACTIVE');
    assert.equal(s.isActive, true);
    assert.equal(s.isQuiescent, false);
  });

  it('rejects beginConnect from CONNECTING or ACTIVE', () => {
    const s = new OpenAIFamilySessionState();
    s.beginConnect('test');
    assert.throws(() => s.beginConnect('test'), /state=CONNECTING/);
    s.markActive();
    assert.throws(() => s.beginConnect('test'), /state=ACTIVE/);
  });

  it('allows re-connect from CLOSING', () => {
    const s = new OpenAIFamilySessionState();
    s.beginConnect('test');
    s.markActive();
    s.beginClose();
    assert.equal(s.current, 'CLOSING');
    s.beginConnect('test'); // does not throw
    assert.equal(s.current, 'CONNECTING');
  });

  it('reset() returns to IDLE from any state', () => {
    const s = new OpenAIFamilySessionState();
    s.beginConnect('t');
    s.reset();
    assert.equal(s.current, 'IDLE');
  });

  it('onSocketGone() drops ACTIVE → IDLE but keeps CLOSING', () => {
    const a = new OpenAIFamilySessionState();
    a.beginConnect('t');
    a.markActive();
    a.onSocketGone();
    assert.equal(a.current, 'IDLE');

    const b = new OpenAIFamilySessionState();
    b.beginConnect('t');
    b.markActive();
    b.beginClose();
    b.onSocketGone();
    assert.equal(b.current, 'CLOSING');
  });

  it('isQuiescent is true for IDLE and CLOSING', () => {
    const s = new OpenAIFamilySessionState();
    assert.equal(s.isQuiescent, true);
    s.beginConnect('t');
    s.markActive();
    s.beginClose();
    assert.equal(s.isQuiescent, true);
  });
});
