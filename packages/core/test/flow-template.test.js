import test from 'node:test';
import assert from 'node:assert/strict';

import { renderFlowTemplate, compileSanitizePattern } from '../dist/flows/template.js';

test('renderFlowTemplate replaces simple keys', () => {
  const out = renderFlowTemplate('Hello {{name}}!', { name: 'Ada' });
  assert.equal(out, 'Hello Ada!');
});

test('renderFlowTemplate keeps missing placeholders by default', () => {
  const out = renderFlowTemplate('Hello {{missing}}!', { name: 'Ada' });
  assert.equal(out, 'Hello {{missing}}!');
});

test('renderFlowTemplate supports nested keys', () => {
  const out = renderFlowTemplate('Hi {{user.name}}', { user: { name: 'Ada' } });
  assert.equal(out, 'Hi Ada');
});

test('renderFlowTemplate stringifies objects', () => {
  const out = renderFlowTemplate('Data={{obj}}', { obj: { a: 1 } });
  assert.equal(out, 'Data={"a":1}');
});

test('compileSanitizePattern supports /.../flags literals', () => {
  const re = compileSanitizePattern('/foo/g');
  assert.equal(re.source, 'foo');
  assert.equal(re.flags.includes('g'), true);
});

test('compileSanitizePattern defaults to case-insensitive regex', () => {
  const re = compileSanitizePattern('foo');
  assert.equal(re.test('FOO'), true);
});

