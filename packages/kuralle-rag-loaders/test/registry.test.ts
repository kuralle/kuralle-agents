import { describe, test, expect, beforeEach } from 'bun:test';

import {
  registerLoader,
  loadForPath,
  clearRegistry,
  registeredExtensions,
} from '../src/registry.js';

describe('loader registry', () => {
  beforeEach(() => clearRegistry());

  test('registerLoader + loadForPath dispatch by extension', async () => {
    registerLoader('txt', (path) => ({
      load: async () => [{ id: path, text: `loaded ${path}` }],
    }));
    const docs = await loadForPath('/tmp/a.txt');
    expect(docs.length).toBe(1);
    expect(docs[0]!.text).toBe('loaded /tmp/a.txt');
  });

  test('extension match is case-insensitive', async () => {
    registerLoader('pdf', (path) => ({
      load: async () => [{ id: path, text: 'pdf' }],
    }));
    const docs = await loadForPath('/tmp/a.PDF');
    expect(docs[0]!.text).toBe('pdf');
  });

  test('leading dot on extension is stripped on registration', async () => {
    registerLoader('.md', (path) => ({
      load: async () => [{ id: path, text: 'md' }],
    }));
    expect(registeredExtensions()).toContain('md');
  });

  test('options are passed through to the factory', async () => {
    registerLoader('json', (path, options) => ({
      load: async () => [{ id: path, text: JSON.stringify(options) }],
    }));
    const docs = await loadForPath('/tmp/a.json', { tag: 'x' });
    expect(docs[0]!.text).toBe(JSON.stringify({ tag: 'x' }));
  });

  test('unregistered extension throws with a useful message', async () => {
    await expect(loadForPath('/tmp/x.exotic')).rejects.toThrow(/No loader registered/);
  });

  test('paths with no extension throw', async () => {
    await expect(loadForPath('/tmp/no-ext')).rejects.toThrow(/No loader registered/);
  });

  test('clearRegistry removes all factories', async () => {
    registerLoader('a', (path) => ({ load: async () => [] }));
    registerLoader('b', (path) => ({ load: async () => [] }));
    clearRegistry();
    expect(registeredExtensions()).toEqual([]);
  });
});
