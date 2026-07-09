import { describe, it, expect } from 'bun:test';
import { WidgetClient } from '../src/client/WidgetClient.js';

describe('@kuralle-agents/widget smoke', () => {
  it('WidgetClient constructs with agent url and id', () => {
    const client = new WidgetClient('https://agent.example.com/', 'support');
    expect(client).toBeInstanceOf(WidgetClient);
  });
});
