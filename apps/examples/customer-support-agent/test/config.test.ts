import { describe, expect, it } from 'bun:test';
import { supportConfig } from '../support.config.js';
import { defineSupportConfig, publicSupportConfig } from '../src/config.js';

describe('customer-owned support configuration', () => {
  it('exposes only browser-safe brand and starter data', () => {
    const publicConfig = publicSupportConfig(supportConfig);
    expect(publicConfig.brand.companyName).toBe('Northstar');
    expect(publicConfig.starterPrompts).toHaveLength(4);
    expect(publicConfig).not.toHaveProperty('knowledge');
    expect(publicConfig).not.toHaveProperty('behavior');
  });

  it('fails fast when the knowledge corpus is missing', () => {
    expect(() => defineSupportConfig({ ...supportConfig, knowledge: [] })).toThrow();
  });
});
