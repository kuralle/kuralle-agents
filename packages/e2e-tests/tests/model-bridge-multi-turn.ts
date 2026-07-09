#!/usr/bin/env npx tsx
/**
 * @deprecated NON-CANONICAL multi-turn driver — known broken on Gemini 3.1.
 *
 * STATUS: Retired. Do NOT use as a regression gate or model the canonical
 * multi-turn pattern after it.
 *
 * WHY IT FAILS: This test drove `KuralleGeminiRealtimeModel` via a custom
 * WebSocket bridge that called `model.session()` directly, bypassing
 * `voice.AgentSession`. Two stacked issues collide:
 *
 *   1. Architectural — the raw bridge skips lifecycle wrapping that
 *      `voice.AgentSession` provides (handle management, audio-input
 *      subscription, turn-completion edges, pre-attach tool prep). Even on
 *      Gemini 2.5 the test produced only 2/9 successful turns.
 *
 *   2. Gemini 3.1 specific — the Live API rejects `generate_reply`,
 *      `update_instructions`, `update_chat_ctx` mid-session, and
 *      `send_client_content` returns 1007 after turn 1. The custom bridge
 *      attached tools after Gemini connected, hitting all three
 *      restrictions. Result: 0/9 turns succeeded on 3.1.
 *
 * CANONICAL ALTERNATIVES (all green on Gemini 3.1):
 *
 *   - tests/agentsession-realtime-authority-gemini-e2e.ts   (148 chunks/2 turns)
 *   - tests/sip-realtime-authority-e2e.ts                   (96+62 RTP chunks)
 *   - tests/agentsession-e2e.ts                             (single agent)
 *   - tests/agentsession-tools-e2e.ts                       (multi-tool)
 *   - tests/agentsession-flow-e2e.ts                        (flow + handoff)
 *
 * All five exercise multi-turn through `voice.AgentSession` +
 * `createKuralleRealtimeAgent` (the production path) and demonstrate the
 * same coverage this test was attempting (single, flow, triage, tools).
 *
 * REFERENCES:
 *
 *   - GitHub issue #30 (this retirement)
 *   - GitHub issue #17 (root-cause analysis)
 *
 * If you find yourself reaching for `model.session()` + custom WS bridge
 * for a new test, STOP and use one of the canonical paths above instead.
 */

const DEPRECATION_NOTICE = [
  '',
  'model-bridge-multi-turn.ts is retired (GH #30).',
  '',
  'This entry point exercised a non-canonical raw model.session() + WS bridge',
  'pattern that fails 0/9 turns on Gemini 3.1. Use the canonical multi-turn',
  'drivers instead — they cover the same scenarios and are green on 3.1:',
  '',
  '  npx tsx packages/e2e-tests/tests/agentsession-realtime-authority-gemini-e2e.ts',
  '  npx tsx packages/e2e-tests/tests/sip-realtime-authority-e2e.ts',
  '  npx tsx packages/e2e-tests/tests/agentsession-e2e.ts',
  '  npx tsx packages/e2e-tests/tests/agentsession-tools-e2e.ts',
  '  npx tsx packages/e2e-tests/tests/agentsession-flow-e2e.ts',
  '',
  'See the file header above for the full rationale.',
  '',
].join('\n');

console.warn(DEPRECATION_NOTICE);
process.exit(0);
