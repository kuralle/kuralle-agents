#!/usr/bin/env npx tsx
/**
 * Deploy the AgentSession direct transport (Path D) scenario.
 * Uses @livekit/agents-plugin-google RealtimeModel + voice.Agent + llm.tool.
 */

import { deploy } from './deploy.js';

deploy('agentsession').catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
