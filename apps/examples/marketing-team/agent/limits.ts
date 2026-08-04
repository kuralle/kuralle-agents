import type { Limits } from '@kuralle-agents/core';

/**
 * How many model/tool steps one agent gets inside a single turn.
 *
 * The framework default is 5, and the specialists here blow through that on ordinary work: a
 * social post is `get_brand_context` + `load_skill` × 2 + `read_skill_resource` +
 * `build_tracked_link` + `create_content` + `lint_against_style` before a word is written, and
 * the lead has already spent steps grounding and routing before the specialist starts.
 *
 * Running out is no longer silent — `AiSdkModelTurnLoop` makes a final tool-less wrap-up call so
 * the turn always answers — but a wrap-up is a truncation: the agent writes its summary from
 * wherever it happened to be, having been cut off mid-chain. The budget should be high enough
 * that real work finishes inside it and the backstop stays a backstop.
 *
 * 25 is chosen to be comfortably clear of the longest observed chain (about 10), not as a
 * tuned optimum. It is a ceiling against runaway loops, not a target to spend.
 */
export const AGENT_LIMITS: Limits = { maxSteps: 25 };
