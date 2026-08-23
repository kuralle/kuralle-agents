import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testRender } from '@opentui/react/test-utils';
import {
  hostedConfigPath,
  saveHostedConnection,
  type Client,
  type Target,
} from '@kuralle-agents/client';
import { KuralleTui } from '../src/KuralleTui.js';
import { MockSession } from './helpers.js';
import { fileURLToPath } from 'node:url';

const previousConfig = process.env.KURALLE_CONFIG;
const configDir = mkdtempSync(join(tmpdir(), 'kuralle-tui-connect-'));
process.env.KURALLE_CONFIG = join(configDir, 'connection.json');

afterAll(() => {
  if (previousConfig === undefined) delete process.env.KURALLE_CONFIG;
  else process.env.KURALLE_CONFIG = previousConfig;
});

beforeEach(async () => {
  await saveHostedConnection({
    server: 'https://saved.example',
    transport: 'cloudflare',
    agentName: 'saved-agent',
  });
});

function mockCreateClient(): (target: Target) => Client {
  return (target) => ({
    sessions: {
      create: () => new MockSession({ id: `mock-${target.kind}` }),
      attach: (sessionId) => new MockSession({ id: sessionId }),
    },
  });
}

async function renderConnectTui(createClientFn = mockCreateClient()) {
  return testRender(
    <KuralleTui terminalWidth={90} terminalHeight={24} createClientFn={createClientFn} />,
    { width: 90, height: 24 },
  );
}

async function renderConnectedTui(createClientFn = mockCreateClient()) {
  const target: Target = { kind: 'http', url: 'http://bootstrap.example' };
  const client = createClientFn(target);
  return testRender(
    <KuralleTui
      terminalWidth={90}
      terminalHeight={24}
      createClientFn={createClientFn}
      initialTarget={target}
      initialClient={client}
      initialSession={client.sessions.create()}
      initialTitle="http://bootstrap.example"
    />,
    { width: 90, height: 24 },
  );
}

describe('connect screen', () => {
  it('shows the connect screen and saved connection when launched without a target', async () => {
    const setup = await renderConnectTui();
    try {
      await setup.waitForVisualIdle({ maxPasses: 100 });
      await setup.waitFor(
        () => setup.captureCharFrame().includes('https://saved.example'),
        { maxPasses: 200 },
      );
      const frame = setup.captureCharFrame();
      expect(frame).toContain('Connect');
      expect(frame).toContain('https://saved.example');
      expect(frame).toContain('saved-agent');
    } finally {
      setup.renderer.destroy();
    }
  });

  it('connects to the saved target when auto-connect runs on the connect screen', async () => {
    const setup = await testRender(
      <KuralleTui terminalWidth={90} terminalHeight={24} createClientFn={mockCreateClient()} autoConnectSaved />,
      { width: 90, height: 24 },
    );
    try {
      await setup.waitFor(
        () => {
          const frame = setup.captureCharFrame();
          return frame.includes('https://saved.example') && !frame.includes('Command');
        },
        { maxPasses: 400 },
      );
      const frame = setup.captureCharFrame();
      expect(frame).toContain('mock-clo');
    } finally {
      setup.renderer.destroy();
    }
  });
});

// Absolute, from this file — never from the cwd, which differs between a package-local run and
// the monorepo-wide one.
const fixtureAgent = fileURLToPath(new URL('./fixtures/local-agent.ts', import.meta.url));

/**
 * Poll the frame while yielding to the macrotask queue.
 *
 * `waitFor` and `waitForVisualIdle` advance render passes without yielding, so a promise that is
 * waiting on a macrotask never settles inside them. `/agent` resolves its target through a dynamic
 * import(), which is exactly that — so the frame stayed on the previous target through all 400
 * passes. A fixed sleep long enough to cover the import would pass today and flake on a slower
 * machine, so this yields repeatedly until the frame agrees or the wall clock runs out.
 */
async function settleFrame(
  setup: Awaited<ReturnType<typeof renderConnectedTui>>,
  predicate: (frame: string) => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await setup.waitForVisualIdle({ maxPasses: 50 });
    if (predicate(setup.captureCharFrame())) return;
  }
  throw new Error(`frame never satisfied the predicate:\n${setup.captureCharFrame()}`);
}

describe('/connect target resolution', () => {
  const cases = [
    {
      name: 'http://',
      command: '/connect http://agent.example',
      expectInFrame: 'agent.example',
    },
    {
      name: 'https://',
      command: '/connect https://agent.example',
      expectInFrame: 'agent.example',
    },
    {
      name: 'ws://',
      command: '/connect ws://agent.example --agent-name pharmacy-agent',
      expectInFrame: 'pharmacy-agent',
    },
    {
      name: 'wss://',
      command: '/connect wss://agent.example --agent-name pharmacy-agent',
      expectInFrame: 'pharmacy-agent',
    },
    {
      // A filesystem path is /agent's job — /connect takes a URL. The scheme inference that picks
      // between them is asserted directly in packages/client/test/target-scheme.test.ts.
      name: 'filesystem path',
      command: `/agent ${fixtureAgent} --model gpt-4.1-mini`,
      expectInFrame: 'local-agent',
    },
    {
      name: '--transport override',
      command: '/connect https://agent.example --transport cloudflare --agent-name pharmacy-agent',
      expectInFrame: 'pharmacy-agent',
    },
  ] as const;

  for (const testCase of cases) {
    it(`resolves ${testCase.name} via /connect`, async () => {
      const setup = await renderConnectedTui();
      try {
        await setup.waitForVisualIdle({ maxPasses: 100 });
        await setup.mockInput.typeText(testCase.command);
        await setup.mockInput.pressEnter();
        // `/agent` resolves its target through a dynamic import(). waitFor and waitForVisualIdle
        // advance render passes without yielding to the macrotask queue, so that promise never
        // settles inside them and the frame stays on the previous target forever. One real tick
        // lets it land; the assertions below are unchanged.
        await new Promise((resolve) => setTimeout(resolve, 25));
        await setup.waitFor(
          () => {
            const frame = setup.captureCharFrame();
            return frame.includes(testCase.expectInFrame) && !frame.includes('bootstrap.example');
          },
          { maxPasses: 400 },
        ).catch(() => { console.log('FRAME>>>\n' + setup.captureCharFrame() + '\n<<<END'); throw new Error('x'); });
        const frame = setup.captureCharFrame();
        expect(frame).toContain(testCase.expectInFrame);
        expect(frame).not.toContain('bootstrap.example');
      } finally {
        setup.renderer.destroy();
      }
    });
  }

  it('persists /save without writing a token to the connection file', async () => {
    process.env.KURALLE_TOKEN = 'secret-token-should-not-persist';
    let runSlash: (command: string) => Promise<boolean> = async () => false;
    const target: Target = { kind: 'http', url: 'http://bootstrap.example' };
    const client = mockCreateClient()(target);
    const setup = await testRender(
      <KuralleTui
        terminalWidth={90}
        terminalHeight={24}
        createClientFn={mockCreateClient()}
        initialTarget={target}
        initialClient={client}
        initialSession={client.sessions.create()}
        initialTitle="http://bootstrap.example"
        exposeSlash={(fn) => {
          runSlash = fn;
        }}
      />,
      { width: 90, height: 24 },
    );
    try {
      await setup.waitForVisualIdle({ maxPasses: 100 });
      await runSlash('/connect https://p.ex --agent-name pa');
      await setup.waitFor(() => setup.captureCharFrame().includes('p.ex'), { maxPasses: 400 });
      await runSlash('/save');
      await setup.waitForVisualIdle({ maxPasses: 100 });

      const saved = JSON.parse(await readFile(hostedConfigPath(), 'utf8')) as Record<string, unknown>;
      expect(saved.server).toBe('https://p.ex');
      expect(saved.agentName).toBe('pa');
      expect(Object.keys(saved).some((key) => /token|secret|auth|credential/i.test(key))).toBe(false);
    } finally {
      delete process.env.KURALLE_TOKEN;
      setup.renderer.destroy();
    }
  });
});
