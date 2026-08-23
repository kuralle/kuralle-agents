#!/usr/bin/env bun
import { loadEnvFile } from '@kuralle-agents/client';
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { createClient } from '@kuralle-agents/client';
import { KuralleTui } from './KuralleTui.js';
import { parseCliArgv, resolveLaunchTarget } from './cliArgs.js';

async function main(): Promise<void> {
  // Bun already reads <cwd>/.env, so this is for --env-file and for parity with the agent CLI:
  // both surfaces load the same file from the same place, and dotenv never overrides a real
  // environment variable, so the precedence stays env > --env-file > ./.env.
  const envIndex = process.argv.indexOf('--env-file');
  loadEnvFile(envIndex >= 0 ? process.argv[envIndex + 1] : undefined);

  const launch = parseCliArgv(process.argv.slice(2));
  const resolved = await resolveLaunchTarget(launch);
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  const root = createRoot(renderer);

  if (resolved) {
    const client = createClient(resolved.target);
    const session = launch.sessionId
      ? client.sessions.attach(launch.sessionId)
      : client.sessions.create();
    root.render(
      <KuralleTui
        initialTarget={resolved.target}
        initialConnection={resolved.connection ?? undefined}
        initialClient={client}
        initialSession={session}
        initialTitle={resolved.label}
        userId={launch.userId}
        onQuit={() => {
          renderer.destroy();
          process.exit(0);
        }}
      />,
    );
    return;
  }

  root.render(
    <KuralleTui
      userId={launch.userId}
      onQuit={() => {
        renderer.destroy();
        process.exit(0);
      }}
    />,
  );
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
