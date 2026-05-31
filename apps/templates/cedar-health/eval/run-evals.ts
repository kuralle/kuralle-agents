/**
 * Cedar Health eval runner — N=5 per scenario, multi-agent in-process Runtime.
 *
 * Why we don't use EvalRunner.runText directly:
 *   EvalRunner builds a Runtime with `agents: [scenario.agent]` only. Cedar-
 *   health is a multi-agent system with a TriageAgent coordinator that
 *   structurally routes to scheduler / triage-router / billing / rx. To
 *   exercise the real routing surface, we instantiate the same Runtime the
 *   server uses, then drive turns + score with the same scoreTurn() the
 *   framework ships. This is one of the gaps surfaced by this eval (see the
 *   report).
 *
 * Cost: ~45 runs × ~3-7k tokens × $0.15/1M input + $0.60/1M output.
 */
import dotenv from 'dotenv';
import { writeFileSync } from 'node:fs';
import { openai } from '@ai-sdk/openai';
import { createRuntime, scoreTurn } from '@kuralle-agents/core';
import type { HarnessHooks, HarnessStreamPart } from '@kuralle-agents/core';
import { mergeHarnessTools } from '@kuralle-templates/_shared-mock-services/runtime/harnessTools';
import { buildAgents } from '../src/agents.js';
import { knowledgeConfig } from '../src/knowledge.js';
import { scenarios, customChecks, type CedarScenario, type CedarTurn } from './scenarios.js';

dotenv.config({ path: new URL('../.env', import.meta.url).pathname });
if (!process.env.OPENAI_API_KEY) {
	console.error('OPENAI_API_KEY required'); process.exit(1);
}

const N = Number(process.env.EVAL_N ?? 5);
const MODEL_ID = 'gpt-4.1-mini';
// gpt-4.1-mini pricing (USD per 1M tokens, as of 2025/2026):
const PRICE_PER_M_INPUT = 0.40;
const PRICE_PER_M_OUTPUT = 1.60;

interface TurnRunResult {
	turnIndex: number;
	input: string;
	response: string;
	toolsCalled: string[];      // ordered
	agentTrail: string[];       // agent-start sequence
	latencyMs: number;
	inputTokens: number;
	outputTokens: number;
	checks: Array<{ name: string; passed: boolean; detail: string }>;
	passed: boolean;
}

interface ScenarioRunResult {
	runIndex: number;
	turns: TurnRunResult[];
	passed: boolean;
	totalLatencyMs: number;
	totalInputTokens: number;
	totalOutputTokens: number;
}

interface ScenarioAgg {
	scenario: CedarScenario;
	runs: ScenarioRunResult[];
	// per-check pass counts: key = `turn${i}:checkName`
	checkPassByKey: Map<string, { passed: number; total: number; lastDetail?: string }>;
	avgLatencyMs: number;
	avgInputTokens: number;
	avgOutputTokens: number;
	passRateRuns: number; // fraction of runs where every turn passed
}

function scoreCedarTurn(
	turn: CedarTurn,
	response: string,
	toolsCalled: string[],
	transitions: Array<{ from: string; to: string }>,
	agentTrail: string[],
	latencyMs: number,
	scenarioName: string,
	turnIndex: number,
): Array<{ name: string; passed: boolean; detail: string }> {
	// 1) Built-in scorer covers toolCalls (set), noToolCalls, flowTransition,
	//    responseContains, responseNotContains, extractionFields, maxLatencyMs.
	const checks = scoreTurn(turn.expect, response, toolsCalled, transitions, latencyMs, undefined);

	// 2) Cedar extras
	const expectExt = turn.expect as CedarTurn['expect'];
	if (expectExt?.routedTo) {
		const observed = agentTrail[agentTrail.length - 1] ?? '';
		const passed = observed === expectExt.routedTo;
		checks.push({
			name: `routedTo:${expectExt.routedTo}`,
			passed,
			detail: passed
				? `Final agent was ${observed}`
				: `Expected final agent ${expectExt.routedTo}, got ${observed || '(none)'} (trail: ${agentTrail.join('→') || '(empty)'})`,
		});
	}

	if (expectExt?.toolSequenceIncludes && expectExt.toolSequenceIncludes.length > 0) {
		const seq = expectExt.toolSequenceIncludes;
		let cursor = 0;
		for (const t of toolsCalled) {
			if (cursor < seq.length && t === seq[cursor]) cursor++;
		}
		const passed = cursor === seq.length;
		checks.push({
			name: `toolSequence:${seq.join('→')}`,
			passed,
			detail: passed
				? `Saw ordered subsequence ${seq.join('→')}`
				: `Missing ordered subsequence ${seq.join('→')}; observed: ${toolsCalled.join('→') || '(none)'}`,
		});
	}

	// 3) Custom checks from scenarios.ts (substring-OR, regex, etc.)
	const customKey = `${scenarioName}:${turnIndex}`;
	const customs = customChecks[customKey] ?? [];
	for (const fn of customs) {
		checks.push(fn(response, toolsCalled));
	}

	return checks;
}

async function runScenarioOnce(
	scenario: CedarScenario,
	runIndex: number,
): Promise<ScenarioRunResult> {
	let perTurnUsage: Array<{ input: number; output: number }> = [];

	const hooks: HarnessHooks = {
		onTokensUpdate: async (_ctx, turn) => {
			perTurnUsage.push({ input: turn.inputTokens, output: turn.outputTokens });
		},
	};

	const model = openai(MODEL_ID) as any;
	const agentList = buildAgents(model);
	const runtime = createRuntime({
		agents: agentList,
		defaultAgentId: 'coordinator',
		defaultModel: model,
		knowledge: knowledgeConfig,
		hooks,
		tools: mergeHarnessTools(agentList),
	});

	let sessionId: string | undefined;
	const turnResults: TurnRunResult[] = [];
	let allPassed = true;
	let totalLatency = 0;
	let totalIn = 0;
	let totalOut = 0;

	for (let i = 0; i < scenario.turns.length; i++) {
		const turn = scenario.turns[i]!;
		const usageBefore = perTurnUsage.length;
		const startTime = Date.now();
		let response = '';
		const toolsCalled: string[] = [];
		const transitions: Array<{ from: string; to: string }> = [];
		const agentTrail: string[] = [];

		try {
			for await (const part of runtime.stream({ input: turn.input, sessionId })) {
				const p = part as HarnessStreamPart;
				if (p.type === 'text-delta') response += p.text;
				else if (p.type === 'tool-call') {
					// Skip the internal handoff tool — it's an implementation detail of TriageAgent.
					if (p.toolName !== 'handoff_to_agent') toolsCalled.push(p.toolName);
				}
				else if (p.type === 'flow-transition') transitions.push({ from: p.from, to: p.to });
				else if (p.type === 'agent-start') agentTrail.push(p.agentId);
				else if (p.type === 'done') sessionId = p.sessionId;
			}
		} catch (err) {
			response += `\n[stream-error: ${err instanceof Error ? err.message : String(err)}]`;
		}

		const latencyMs = Date.now() - startTime;
		const turnUsage = perTurnUsage.slice(usageBefore);
		const inTok = turnUsage.reduce((s, u) => s + u.input, 0);
		const outTok = turnUsage.reduce((s, u) => s + u.output, 0);

		const checks = scoreCedarTurn(turn, response, toolsCalled, transitions, agentTrail, latencyMs, scenario.name, i);
		const turnPassed = checks.length === 0 ? true : checks.every(c => c.passed);
		if (!turnPassed) allPassed = false;

		turnResults.push({
			turnIndex: i,
			input: turn.input,
			response: response.trim(),
			toolsCalled,
			agentTrail,
			latencyMs,
			inputTokens: inTok,
			outputTokens: outTok,
			checks,
			passed: turnPassed,
		});
		totalLatency += latencyMs;
		totalIn += inTok;
		totalOut += outTok;
	}

	return {
		runIndex,
		turns: turnResults,
		passed: allPassed,
		totalLatencyMs: totalLatency,
		totalInputTokens: totalIn,
		totalOutputTokens: totalOut,
	};
}

function aggregateScenario(scenario: CedarScenario, runs: ScenarioRunResult[]): ScenarioAgg {
	const checkPassByKey = new Map<string, { passed: number; total: number; lastDetail?: string }>();
	for (const run of runs) {
		for (const turn of run.turns) {
			for (const check of turn.checks) {
				const key = `t${turn.turnIndex}:${check.name}`;
				const existing = checkPassByKey.get(key) ?? { passed: 0, total: 0 };
				existing.total++;
				if (check.passed) existing.passed++;
				else existing.lastDetail = check.detail;
				checkPassByKey.set(key, existing);
			}
		}
	}
	const passRateRuns = runs.filter(r => r.passed).length / Math.max(1, runs.length);
	const avgLatency = runs.reduce((s, r) => s + r.totalLatencyMs, 0) / Math.max(1, runs.length);
	const avgIn = runs.reduce((s, r) => s + r.totalInputTokens, 0) / Math.max(1, runs.length);
	const avgOut = runs.reduce((s, r) => s + r.totalOutputTokens, 0) / Math.max(1, runs.length);
	return { scenario, runs, checkPassByKey, avgLatencyMs: avgLatency, avgInputTokens: avgIn, avgOutputTokens: avgOut, passRateRuns };
}

function fmtPct(p: number): string {
	return `${(p * 100).toFixed(0)}%`;
}

function buildReport(aggs: ScenarioAgg[]): string {
	const lines: string[] = [];
	lines.push(`# Cedar-Health Eval Results`);
	lines.push('');
	lines.push(`- Model: \`${MODEL_ID}\``);
	lines.push(`- Runs per scenario: ${N}`);
	lines.push(`- Total scenarios: ${aggs.length}`);
	lines.push(`- Runtime: in-process multi-agent (coordinator → 4 specialists)`);
	lines.push('');

	// 1) Scenario coverage
	lines.push(`## 1. Scenario coverage`);
	lines.push('');
	for (const agg of aggs) {
		lines.push(`### \`${agg.scenario.name}\``);
		lines.push(`${agg.scenario.description}`);
		lines.push('');
		for (let i = 0; i < agg.scenario.turns.length; i++) {
			const turn = agg.scenario.turns[i]!;
			const exp = turn.expect as CedarTurn['expect'];
			const assertions: string[] = [];
			if (exp?.routedTo) assertions.push(`routedTo=\`${exp.routedTo}\``);
			if (exp?.toolCalls) assertions.push(`toolCalls=[${exp.toolCalls.join(', ')}]`);
			if (exp?.toolSequenceIncludes) assertions.push(`toolSeq=[${exp.toolSequenceIncludes.join('→')}]`);
			if (exp?.noToolCalls) assertions.push(`noToolCalls=[${exp.noToolCalls.join(', ')}]`);
			if (exp?.responseContains) assertions.push(`contains=[${exp.responseContains.map(s => `"${s}"`).join(', ')}]`);
			if (exp?.responseNotContains) assertions.push(`notContains=[${exp.responseNotContains.map(s => `"${s}"`).join(', ')}]`);
			const customKey = `${agg.scenario.name}:${i}`;
			const customs = customChecks[customKey];
			if (customs && customs.length > 0) {
				assertions.push(`custom=[${customs.length} regex/OR checks]`);
			}
			lines.push(`- **Turn ${i + 1}**: \`${turn.input}\``);
			lines.push(`  - Assertions: ${assertions.join('; ') || '(none)'}`);
		}
		lines.push('');
	}

	// 2) Per-scenario results matrix
	lines.push(`## 2. Per-scenario results matrix`);
	lines.push('');
	const runHeaders = Array.from({ length: N }, (_, i) => `r${i + 1}`).join(' | ');
	lines.push(`| Scenario | ${runHeaders} | pass% | avg latency | avg tokens (in/out) |`);
	lines.push(`| --- | ${Array(N).fill('---').join(' | ')} | --- | --- | --- |`);
	for (const agg of aggs) {
		const runCells = agg.runs.map(r => (r.passed ? 'PASS' : 'FAIL')).join(' | ');
		lines.push(`| \`${agg.scenario.name}\` | ${runCells} | ${fmtPct(agg.passRateRuns)} | ${agg.avgLatencyMs.toFixed(0)}ms | ${Math.round(agg.avgInputTokens)}/${Math.round(agg.avgOutputTokens)} |`);
	}
	lines.push('');

	// 2b) Per-assertion variance (the real signal)
	lines.push(`### Per-assertion pass counts (N=${N})`);
	lines.push('');
	lines.push(`Assertions below 5/5 are flaky. Detail shown is from the most recent failure.`);
	lines.push('');
	for (const agg of aggs) {
		lines.push(`**${agg.scenario.name}**`);
		const entries = Array.from(agg.checkPassByKey.entries()).sort();
		if (entries.length === 0) {
			lines.push(`- (no assertions)`);
			lines.push('');
			continue;
		}
		for (const [key, val] of entries) {
			const marker = val.passed === val.total ? 'OK' : (val.passed === 0 ? 'FAIL' : 'FLAKY');
			lines.push(`- \`${key}\` — ${val.passed}/${val.total} ${marker}${val.passed < val.total && val.lastDetail ? ` — _${val.lastDetail}_` : ''}`);
		}
		lines.push('');
	}

	// 3) Aggregate pass rate
	const totalRuns = aggs.reduce((s, a) => s + a.runs.length, 0);
	const totalPassed = aggs.reduce((s, a) => s + a.runs.filter(r => r.passed).length, 0);
	const totalChecks = aggs.reduce((s, a) => s + Array.from(a.checkPassByKey.values()).reduce((x, v) => x + v.total, 0), 0);
	const totalChecksPassed = aggs.reduce((s, a) => s + Array.from(a.checkPassByKey.values()).reduce((x, v) => x + v.passed, 0), 0);
	lines.push(`## 3. Aggregate pass rate`);
	lines.push('');
	lines.push(`- Full-run pass rate (every turn + every assertion in a run passed): **${totalPassed}/${totalRuns} = ${fmtPct(totalPassed / Math.max(1, totalRuns))}**`);
	lines.push(`- Per-assertion pass rate (counts each individual check): **${totalChecksPassed}/${totalChecks} = ${fmtPct(totalChecksPassed / Math.max(1, totalChecks))}**`);
	lines.push('');

	// 4) Failure modes
	lines.push(`## 4. Failure modes`);
	lines.push('');
	let anyFailure = false;
	for (const agg of aggs) {
		const failingChecks = Array.from(agg.checkPassByKey.entries()).filter(([, v]) => v.passed < v.total);
		if (failingChecks.length === 0) continue;
		anyFailure = true;
		lines.push(`### \`${agg.scenario.name}\``);
		for (const [key, val] of failingChecks) {
			lines.push(`- \`${key}\` failed ${val.total - val.passed}/${val.total}: ${val.lastDetail ?? '(no detail)'}`);
		}
		// Include the first failing run's full reply for each turn to inspect.
		const firstFailingRun = agg.runs.find(r => !r.passed);
		if (firstFailingRun) {
			lines.push('');
			lines.push(`First failing run (run ${firstFailingRun.runIndex + 1}) replies:`);
			for (const turn of firstFailingRun.turns) {
				const flag = turn.passed ? 'PASS' : 'FAIL';
				lines.push(`- turn ${turn.turnIndex + 1} [${flag}] input: \`${turn.input}\``);
				lines.push(`  - tools: \`${turn.toolsCalled.join('→') || '(none)'}\` | agents: \`${turn.agentTrail.join('→') || '(none)'}\``);
				lines.push(`  - reply: ${JSON.stringify(turn.response.slice(0, 800))}`);
			}
		}
		lines.push('');
	}
	if (!anyFailure) {
		lines.push(`No failing assertions across all ${totalRuns} runs.`);
		lines.push('');
	}

	// 5) Cost
	const totalInputTokens = aggs.reduce((s, a) => s + a.runs.reduce((x, r) => x + r.totalInputTokens, 0), 0);
	const totalOutputTokens = aggs.reduce((s, a) => s + a.runs.reduce((x, r) => x + r.totalOutputTokens, 0), 0);
	const cost = (totalInputTokens / 1e6) * PRICE_PER_M_INPUT + (totalOutputTokens / 1e6) * PRICE_PER_M_OUTPUT;
	lines.push(`## 5. Cost`);
	lines.push('');
	lines.push(`- Total input tokens: ${totalInputTokens.toLocaleString()}`);
	lines.push(`- Total output tokens: ${totalOutputTokens.toLocaleString()}`);
	lines.push(`- Estimated OpenAI spend (gpt-4.1-mini @ $${PRICE_PER_M_INPUT}/M in, $${PRICE_PER_M_OUTPUT}/M out): **$${cost.toFixed(4)}**`);
	lines.push('');

	// 6) Recommendations — leave for the calling agent to fill in based on findings.
	lines.push(`## 6. Recommendations`);
	lines.push('');
	lines.push(`See the agent's summary message — recommendations are derived from observed failure modes above.`);
	lines.push('');

	return lines.join('\n');
}

async function main() {
	console.log(`Running ${scenarios.length} scenarios × ${N} runs each = ${scenarios.length * N} total runs…`);
	const aggs: ScenarioAgg[] = [];
	for (const scenario of scenarios) {
		console.log(`\n--- scenario: ${scenario.name} (${scenario.turns.length} turns) ---`);
		const runs: ScenarioRunResult[] = [];
		for (let i = 0; i < N; i++) {
			process.stdout.write(`  run ${i + 1}/${N}… `);
			const t0 = Date.now();
			try {
				const r = await runScenarioOnce(scenario, i);
				runs.push(r);
				console.log(`${r.passed ? 'PASS' : 'FAIL'} (${Date.now() - t0}ms, in=${r.totalInputTokens} out=${r.totalOutputTokens})`);
			} catch (err) {
				console.log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
				runs.push({
					runIndex: i,
					turns: [],
					passed: false,
					totalLatencyMs: Date.now() - t0,
					totalInputTokens: 0,
					totalOutputTokens: 0,
				});
			}
		}
		aggs.push(aggregateScenario(scenario, runs));
	}

	const report = buildReport(aggs);
	const outPath = '/tmp/cedar-eval-results.md';
	writeFileSync(outPath, report, 'utf8');
	console.log(`\nReport written to ${outPath}`);
	console.log(`\n--- summary ---`);
	for (const agg of aggs) {
		console.log(`  ${agg.scenario.name}: ${fmtPct(agg.passRateRuns)} full-run pass`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
