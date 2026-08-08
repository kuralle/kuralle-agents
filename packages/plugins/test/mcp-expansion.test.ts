import { describe, expect, it } from 'bun:test';
import { expandPluginPlaceholders } from '../src/mcp.js';

describe('MCP placeholder expansion', () => {
  it('does not recursively expand placeholders introduced by replacement', () => {
    const pluginRoot = '/plugins/pkg-with-literal';
    const pluginDataRoot = '/plugins/data/pkg-with-literal';

    const input = '${PLUGIN_ROOT}';
    const pluginRootValue = '/installed/${PLUGIN_DATA}/nested';

    const expanded = expandPluginPlaceholders(
      input,
      pluginRootValue,
      pluginDataRoot,
    );

    expect(expanded).toBe('/installed/${PLUGIN_DATA}/nested');
    expect(expanded).not.toBe('/installed/plugins/data/pkg-with-literal/nested');
  });
});
