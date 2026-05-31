/**
 * Reusable assertion helpers for WS transport e2e tests.
 */

import { TraceCollector } from './trace_collector.js';

export interface AssertionResult {
  name: string;
  pass: boolean;
  detail: string;
}

/**
 * Run a set of named assertions and return results.
 */
export function runAssertions(
  checks: Array<{ name: string; check: () => { pass: boolean; detail: string } }>,
): AssertionResult[] {
  return checks.map(({ name, check }) => {
    try {
      const { pass, detail } = check();
      return { name, pass, detail };
    } catch (err) {
      return {
        name,
        pass: false,
        detail: `Exception: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });
}

/**
 * Print assertion results in a formatted table.
 */
export function printAssertionResults(results: AssertionResult[]): boolean {
  console.log('\n  ┌────────────────────────────────────────────────────');
  console.log('  │ ASSERTION RESULTS');
  console.log('  ├────────────────────────────────────────────────────');

  let allPass = true;
  for (const r of results) {
    const icon = r.pass ? '✓' : '✗';
    console.log(`  │ ${icon} ${r.name}: ${r.detail}`);
    if (!r.pass) allPass = false;
  }

  console.log('  └────────────────────────────────────────────────────');
  console.log(`\n  ${allPass ? '✓ ALL ASSERTIONS PASSED' : '✗ SOME ASSERTIONS FAILED'}`);
  return allPass;
}

// ─── Common Assertion Checks ─────────────────────────────────────────────

export function assertSessionStarted(trace: TraceCollector): { pass: boolean; detail: string } {
  const msgs = trace.getMessages('session_started');
  if (msgs.length === 0) return { pass: false, detail: 'No session_started message received' };
  const sessionId = msgs[0].sessionId;
  return { pass: true, detail: `sessionId=${String(sessionId)}` };
}

export function assertAgentTextReceived(trace: TraceCollector): { pass: boolean; detail: string } {
  const msgs = trace.getMessages('agent_text');
  if (msgs.length === 0) return { pass: false, detail: 'No agent_text messages received' };
  const textMsgs = msgs.filter((m) => typeof m.text === 'string' && m.text.length > 0);
  return {
    pass: textMsgs.length > 0,
    detail: `${textMsgs.length} agent_text messages with content`,
  };
}

export function assertBinaryAudioReceived(trace: TraceCollector): { pass: boolean; detail: string } {
  const count = trace.binaryChunks.length;
  const bytes = trace.totalBinaryBytes;
  return {
    pass: count > 0,
    detail: `${count} binary chunks (${bytes} bytes)`,
  };
}

export function assertNoUnexpectedClose(trace: TraceCollector): { pass: boolean; detail: string } {
  const closeEntries = trace.entries.filter((e) => e.type === 'ws:close');
  if (closeEntries.length === 0) return { pass: true, detail: 'No WS close events' };
  const codes = closeEntries.map((e) => e.data.code);
  const hasAbnormal = codes.some((c) => c !== 1000 && c !== 1001);
  return {
    pass: !hasAbnormal,
    detail: `Close codes: ${codes.join(', ')}${hasAbnormal ? ' (ABNORMAL)' : ''}`,
  };
}
