import { defineAgent, type AgentConfig } from '@kuralle-agents/core';
import type { LanguageModel } from 'ai';
import {
	subscriptionService as subs,
	orderService as orders,
} from '@kuralle-templates/_shared-mock-services';
import { wireTools } from '@kuralle-templates/_shared-mock-services/runtime/v2Tools';

export function buildAgents(model: LanguageModel): AgentConfig[] {
	const generalTools = wireTools({
		lookupSubscription: subs.lookupSubscription,
		skipWeek: subs.skipWeek,
		pauseSubscription: subs.pauseSubscription,
		updateAddress: subs.updateAddress,
	});

	const retentionTools = wireTools({
		lookupSubscription: subs.lookupSubscription,
		skipWeek: subs.skipWeek,
		pauseSubscription: subs.pauseSubscription,
		cancelSubscription: subs.cancelSubscription,
	});

	const boxIssueTools = wireTools({
		lookupOrder: orders.lookupOrder,
		listOrdersByUser: orders.listOrdersByUser,
		reportIssue: orders.reportIssue,
		issueRefund: subs.issueRefund,
	});

	const general = defineAgent({
		id: 'general',
		name: 'General Support',
		model,
		instructions: `You handle non-cancellation, non-box-issue subscription support for Hearth meal-kit customers.

OPERATING RULES:
- If the customer gives an email, call lookupSubscription({email}) first.
- For skip-week / pause / address-change: act via the tool, then confirm in ONE short sentence.
- If they ask to cancel, say you'll get the retention team to help.`,
		tools: generalTools.tools,
		effectTools: generalTools.effectTools,
		knowledge: {},
	});

	const retention = defineAgent({
		id: 'retention',
		name: 'Retention Specialist',
		model,
		instructions: `You are Hearth's retention specialist. The customer is cancelling.

OPERATING RULES:
- ONE empathetic acknowledgement, then ONE relevant offer.
- Call lookupSubscription({email}) FIRST for tenure-based offers.
- If they say "just cancel", call cancelSubscription without an offer.`,
		tools: retentionTools.tools,
		effectTools: retentionTools.effectTools,
		knowledge: {},
	});

	const boxIssue = defineAgent({
		id: 'box-issue',
		name: 'Box Issue Specialist',
		model,
		instructions: `You handle Hearth box issues — damaged, missing, spoiled, or wrong-items deliveries.

OPERATING RULES:
- Look up the order, file via reportIssue.
- CAP refunds at $50 without escalation.`,
		tools: boxIssueTools.tools,
		effectTools: boxIssueTools.effectTools,
		knowledge: {},
	});

	const coordinator = defineAgent({
		id: 'coordinator',
		name: 'Hearth Coordinator',
		model,
		instructions: `Route Hearth meal-kit customers to the right specialist. For greetings, reply briefly.`,
		routes: [
			{ agent: 'retention', when: 'Cancellation attempts or wanting to cancel subscription.' },
			{ agent: 'box-issue', when: 'Damaged, missing, spoiled, or wrong-items delivery problems.' },
			{ agent: 'general', when: 'Skip week, pause, address change, plan questions, other support.' },
		],
		routing: { default: 'general', mode: 'structured' },
		agents: [general, retention, boxIssue],
		memory: { preload: { enabled: true }, ingest: { enabled: true } },
	});

	return [coordinator, general, retention, boxIssue];
}
