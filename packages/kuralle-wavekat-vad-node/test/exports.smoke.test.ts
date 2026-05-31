import { describe, it, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arch, platform } from 'node:os';

const packageRoot = dirname(fileURLToPath(import.meta.url));

function nativeBinaryPath(): string | null {
  const key = `${platform()}-${arch()}`;
  const map: Record<string, string> = {
    'darwin-arm64': 'kuralle-wavekat-vad-node.darwin-arm64.node',
    'darwin-x64': 'kuralle-wavekat-vad-node.darwin-x64.node',
    'linux-x64': 'kuralle-wavekat-vad-node.linux-x64-gnu.node',
    'linux-arm64': 'kuralle-wavekat-vad-node.linux-arm64-gnu.node',
  };
  const file = map[key];
  if (!file) return null;
  const path = join(packageRoot, '..', file);
  return existsSync(path) ? path : null;
}

const describeIfBinary = nativeBinaryPath() ? describe : describe.skip;

describe('@kuralle-agents/wavekat-vad-node smoke', () => {
  it('index loader resolves on supported platforms', () => {
    expect(existsSync(join(packageRoot, '../index.js'))).toBe(true);
  });

  describeIfBinary('native binding', () => {
    it('loads Vad exports when the platform binary is built', async () => {
      const mod = await import('../index.js');
      expect(typeof mod.Vad).toBe('function');
      expect(mod.VadBackend).toBeDefined();
      expect(mod.WebRtcMode).toBeDefined();
    });
  });
});
