/**
 * Prompt-injection scanner for persistent memory block writes.
 *
 * Persistent blocks get injected into the system prompt verbatim every
 * session. An attacker who can persuade the agent to call
 * `memory_block({action:'add', content: 'ignore previous instructions...'})`
 * effectively rewrites the system prompt for all future sessions of
 * that user. The scanner blocks the most common shapes.
 *
 * Pattern source: aligned with hermes-agent `tools/memory_tool.py`
 * `_MEMORY_THREAT_PATTERNS`, simplified to the highest-signal subset.
 * The `(?:\\w+\\s+)*` between key tokens prevents trivial bypass via
 * filler words ("ignore all PRIOR instructions" matches "ignore prior
 * instructions" matches "ignore the previous given instructions").
 *
 * Failure mode: false positives cost the user a write attempt — the
 * tool returns a structured error and the agent can retry with
 * different wording. False negatives let through a real injection, so
 * we err on the side of catching more.
 */

const INJECTION_PATTERNS: Array<{ pattern: RegExp; id: string }> = [
  {
    pattern: /ignore\s+(?:\w+\s+){0,3}(previous|all|above|prior|the)\s+(?:\w+\s+){0,3}instructions/i,
    id: 'prompt_injection_ignore_instructions',
  },
  {
    pattern: /disregard\s+(?:\w+\s+){0,3}(previous|all|above|prior)\s+(?:\w+\s+){0,3}(rules|guidelines|instructions)/i,
    id: 'prompt_injection_disregard_rules',
  },
  {
    pattern: /you\s+are\s+now\s+(a\s+|an\s+)?(?:helpful\s+)?(jailbroken|unrestricted|uncensored|admin|dan)\b/i,
    id: 'prompt_injection_role_swap',
  },
  {
    pattern: /forget\s+(everything|all|your)\s+(?:\w+\s+){0,3}(instructions|training|trained|guidelines|rules)/i,
    id: 'prompt_injection_forget',
  },
  {
    pattern: /system\s*[:>]\s*you\s+(must|will|shall|are)\b/i,
    id: 'prompt_injection_fake_system_marker',
  },
  {
    pattern: /<\s*\/?\s*(system|instructions?|admin|jailbreak)\s*>/i,
    id: 'prompt_injection_fake_tag',
  },
];

export interface SafetyScanResult {
  safe: boolean;
  /** When unsafe: the id of the matched pattern. */
  matchedPattern?: string;
  /** When unsafe: the substring of the input that triggered the match. */
  matchedText?: string;
}

/**
 * Scan a candidate write for prompt-injection patterns. Returns
 * `{ safe: true }` if no patterns matched, or `{ safe: false, matchedPattern, matchedText }`.
 */
export function scanMemoryWrite(content: string): SafetyScanResult {
  if (!content || typeof content !== 'string') {
    return { safe: true };
  }
  for (const { pattern, id } of INJECTION_PATTERNS) {
    const m = pattern.exec(content);
    if (m) {
      return {
        safe: false,
        matchedPattern: id,
        matchedText: m[0],
      };
    }
  }
  return { safe: true };
}
