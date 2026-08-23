import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearHostedConnection,
  connectionFromArgs,
  connectionToTarget,
  inferTargetKind,
  readHostedConnection,
  resolveHostedConnection,
  saveHostedConnection,
} from '../src/target.js';

const previousConfig = process.env.KURALLE_CONFIG;
const configPath = join(mkdtempSync(join(tmpdir(), 'kuralle-hosted-')), 'connection.json');
process.env.KURALLE_CONFIG = configPath;

afterAll(() => {
  if (previousConfig === undefined) delete process.env.KURALLE_CONFIG;
  else process.env.KURALLE_CONFIG = previousConfig;
});

describe('target scheme inference', () => {
  it('maps http and https to http targets', () => {
    expect(connectionToTarget({ server: 'http://agent.example', transport: 'http' })).toEqual({
      kind: 'http',
      url: 'http://agent.example',
    });
    expect(connectionToTarget({ server: 'https://agent.example/', transport: 'http' })).toEqual({
      kind: 'http',
      url: 'https://agent.example',
    });
  });

  it('maps ws and wss to cloudflare targets', () => {
    expect(connectionToTarget({
      server: 'ws://agent.example',
      transport: 'cloudflare',
      agentName: 'pharmacy-agent',
    })).toEqual({
      kind: 'cloudflare',
      url: 'ws://agent.example',
      agentName: 'pharmacy-agent',
    });
    expect(connectionToTarget({
      server: 'wss://agent.example/',
      transport: 'cloudflare',
      agentName: 'pharmacy-agent',
    })).toEqual({
      kind: 'cloudflare',
      url: 'wss://agent.example',
      agentName: 'pharmacy-agent',
    });
  });

  it('infers transport from the scheme when not overridden', () => {
    expect(connectionToTarget({
      server: 'wss://agent.example',
      agentName: 'pharmacy-agent',
    })).toEqual({
      kind: 'cloudflare',
      url: 'wss://agent.example',
      agentName: 'pharmacy-agent',
    });
    expect(connectionFromArgs(['https://agent.example', '--agent-name', 'guide-agent'])).toEqual({
      server: 'https://agent.example',
      transport: 'http',
      agentName: 'guide-agent',
    });
    expect(connectionFromArgs(['wss://agent.example', '--agent-name', 'guide-agent'])).toEqual({
      server: 'wss://agent.example',
      transport: 'cloudflare',
      agentName: 'guide-agent',
    });
  });

  it('lets --transport override scheme inference', () => {
    expect(connectionFromArgs([
      'https://agent.example',
      '--transport',
      'cloudflare',
      '--agent-name',
      'guide-agent',
    ])).toEqual({
      server: 'https://agent.example',
      transport: 'cloudflare',
      agentName: 'guide-agent',
    });
    expect(connectionToTarget({
      server: 'wss://agent.example',
      transport: 'http',
      agentName: 'guide-agent',
    })).toEqual({
      kind: 'http',
      url: 'wss://agent.example',
      agentName: 'guide-agent',
    });
  });

  it('treats filesystem paths as local targets', () => {
    expect(inferTargetKind('./agents/demo.ts')).toBe('local');
    expect(inferTargetKind('/tmp/my-agent')).toBe('local');
    expect(inferTargetKind('agents/demo')).toBe('local');
  });
});

describe('hosted connection persistence', () => {
  it('persists a non-secret default and lets --local opt out', async () => {
    await clearHostedConnection();
    await saveHostedConnection({
      server: 'https://agent.example/',
      transport: 'cloudflare',
      agentName: 'pharmacy-agent',
    });
    expect(await readHostedConnection()).toEqual({
      server: 'https://agent.example',
      transport: 'cloudflare',
      agentName: 'pharmacy-agent',
    });
    expect(await resolveHostedConnection(['chat', '--local'])).toBeUndefined();
    expect(await clearHostedConnection()).toBe(true);
  });
});
