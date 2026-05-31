import { defineAgent, type AgentConfig } from '@kuralle-agents/core';
import type { LanguageModel } from 'ai';
import {
	oktaService as okta,
	notionService as notion,
	linearService as linear,
} from '@kuralle-templates/_shared-mock-services';
import { wireTools } from '@kuralle-templates/_shared-mock-services/runtime/v2Tools';

const opsTools = wireTools({
	...okta.oktaTools,
	...notion.notionTools,
	...linear.linearTools,
});

export function buildAgents(model: LanguageModel): AgentConfig[] {
	const opsAgent = defineAgent({
		id: 'ops',
		name: 'Ops Bot',
		model,
		instructions: `You are the IT operations bot for Acme. Help employees with
access requests, software, password issues, on-call escalations, and
policy questions.

OPERATING RULES (strict):
- ALWAYS file a Linear ticket (createIssue) when an action needs human
  approval — never just acknowledge and forget.
- Cite policy by NAME when you reference one (read it via searchPages
  + getPage). Reference policy snippets included in the system prompt
  when possible.
- For "I forgot my password" → point to the self-service Okta flow
  from the password-reset policy; only file an IT ticket if they can't
  complete self-serve.
- For staging DB access → require: requester's manager approval + a
  Linear ticket in the SECURITY project with migration scope. File the
  ticket; tell them their manager will be tagged.
- For new software → check the approved-tools list first; only file a
  ticket for unlisted software.
- Keep replies short and direct (2-3 sentences).
- When in doubt, escalate by filing a ticket — don't make the call yourself.`,
		tools: opsTools.tools,
		effectTools: opsTools.effectTools,
		knowledge: {},
		memory: { preload: { enabled: true }, ingest: { enabled: true } },
	});

	return [opsAgent];
}
