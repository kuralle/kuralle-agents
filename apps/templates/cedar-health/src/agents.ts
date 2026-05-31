import { tool as aiTool } from 'ai';
import { z } from 'zod';
import {
	action,
	BuiltinPersonas,
	composePersonaPrompt,
	collect,
	defineAgent,
	defineFlow,
	defineTool,
	reply,
	type AgentConfig,
} from '@kuralle-agents/core';
import type { LanguageModel } from 'ai';
import {
	patientFhirService as fhir,
	rxService as rx,
	billingService as billing,
} from '@kuralle-templates/_shared-mock-services';
import { wireTools } from '@kuralle-templates/_shared-mock-services/runtime/v2Tools';

const verifyInsuranceInput = z.object({
	mrn: z.string().min(1),
	dob: z.string().min(1),
	invoiceId: z.string().min(1),
});

const identitySchema = z.object({
	mrn: z.string().describe('Medical record number, e.g. MRN-100231'),
	dob: z.string().describe('Date of birth YYYY-MM-DD'),
});

const appointmentSchema = z.object({
	provider: z.string().describe('Provider id slug, e.g. dr-chen-l'),
	type: z.string().describe('Visit type, e.g. follow-up'),
	scheduledFor: z.string().describe('Appointment time ISO-8601'),
	location: z.string().describe('Clinic location and room'),
});

type IdentityResult = { verified?: boolean; patientId?: string; reason?: string };
type AppointmentList = { count?: number; appointments?: unknown[]; error?: string };
type ScheduledAppointment = { id?: string; error?: string; patientId?: string };

function requireVerifiedPatient(state: Record<string, unknown>): string {
	if (state.verified !== true || typeof state.patientId !== 'string' || !state.patientId) {
		throw new Error('patient-not-verified');
	}
	return state.patientId;
}

function buildVerifyInsuranceTool() {
	return defineTool({
		name: 'run_verify_insurance',
		description:
			'Verify patient identity, invoice ownership, and insurance eligibility. Requires mrn, dob, invoiceId.',
		input: verifyInsuranceInput,
		execute: async (args) => {
			const { mrn, dob, invoiceId } = verifyInsuranceInput.parse(args);
			const identity = (await fhir.verifyIdentity.execute({ mrn, dob }, { toolCallId: '', messages: [] })) as IdentityResult;
			if (!identity.verified || !identity.patientId) {
				throw new Error(identity.reason ?? 'identity-not-verified');
			}
			const invoice = (await billing.getInvoice.execute({ invoiceId }, { toolCallId: '', messages: [] })) as {
				patientId?: string;
				insurance?: { carrier: string; memberId: string; copayUsd: number };
				error?: string;
			};
			if (invoice.error || invoice.patientId !== identity.patientId) {
				throw new Error('invoice-does-not-belong-to-verified-patient');
			}
			const eligibility = (await billing.verifyInsurance.execute({
				carrier: invoice.insurance!.carrier,
				memberId: invoice.insurance!.memberId,
			}, { toolCallId: '', messages: [] })) as { eligible?: boolean; carrier?: string; copayUsd?: number; reason?: string };
			if (!eligibility.eligible) {
				throw new Error(eligibility.reason ?? 'insurance-not-eligible');
			}
			return {
				patientId: identity.patientId,
				invoiceId,
				eligible: true,
				carrier: eligibility.carrier,
				copayUsd: eligibility.copayUsd,
			};
		},
	});
}

function formatAppointmentSummary(state: Record<string, unknown>): string {
	const appts = (state.appointments as Array<Record<string, unknown>> | undefined) ?? [];
	const booked = state.scheduledAppointment as Record<string, unknown> | undefined;
	const lines = appts.map((a, i) => {
		const when = String(a.scheduledFor ?? 'unknown');
		const provider = String(a.provider ?? 'unknown');
		const type = String(a.type ?? 'visit');
		const location = String(a.location ?? 'Cedar Health Main Clinic');
		return `${i + 1}. ${type} with ${provider} on ${when} at ${location}`;
	});
	const bookedLine = booked?.id
		? `Newly booked appointment id ${String(booked.id)} on ${String(booked.scheduledFor ?? 'unknown')}.`
		: '';
	return (
		`You have ${appts.length} appointment(s) on file:\n${lines.join('\n')}` +
		(bookedLine ? `\n${bookedLine}` : '') +
		'\nLet me know if you need anything else.'
	);
}

function buildSchedulingFlow(model: LanguageModel) {
	const verifyFailed = reply({
		id: 'verify-failed',
		instructions:
			'Identity verification failed. Ask the patient to double-check MRN and date of birth, or call the front desk.',
		model,
		next: () => ({ end: 'verify_failed' }),
	});

	const present = action({
		id: 'present',
		run: async (state, ctx) => {
			ctx.emit({ type: 'text-delta', text: formatAppointmentSummary(state) });
			return { end: 'completed' };
		},
	});

	const listAppointments = action({
		id: 'list-appointments',
		run: async (state, ctx) => {
			const patientId = requireVerifiedPatient(state);
			const result = (await ctx.tool('listAppointments', { patientId })) as AppointmentList;
			if (result.error) {
				throw new Error(result.error);
			}
			return { goto: present, data: { appointments: result.appointments ?? [] } };
		},
	});

	const scheduleAppointment = action({
		id: 'schedule-appointment',
		run: async (state, ctx) => {
			const patientId = requireVerifiedPatient(state);
			const provider = String(state.provider ?? 'dr-chen-l');
			const type = String(state.type ?? 'follow-up');
			const scheduledFor = String(state.scheduledFor ?? '2026-06-09T15:00:00Z');
			const location = String(
				state.location ?? 'Cedar Health Main Clinic — Room 204',
			);
			const appt = (await ctx.tool('scheduleAppointment', {
				patientId,
				provider,
				type,
				scheduledFor,
				location,
			})) as ScheduledAppointment;
			if (appt.error || !appt.id) {
				throw new Error(appt.error ?? 'schedule-failed');
			}
			return { goto: listAppointments, data: { scheduledAppointment: appt } };
		},
	});

	const collectAppointment = collect({
		id: 'collect-appointment',
		schema: appointmentSchema,
		required: ['provider', 'type', 'scheduledFor', 'location'],
		maxTurns: 4,
		instructions: (missing) =>
			`Collect appointment details for a verified patient. Missing: ${missing.join(', ') || 'none'}. ` +
			`Map provider names to ids (Dr Chen-L → dr-chen-l). Use ISO-8601 for scheduledFor. ` +
			`Default location: Cedar Health Main Clinic — Room 204 if not specified.`,
		onComplete: (data, state) => {
			Object.assign(state, data as Record<string, unknown>);
			return scheduleAppointment;
		},
	});

	const verifyIdentity = action({
		id: 'verify-identity',
		run: async (state, ctx) => {
			const mrn = String(state.mrn ?? '');
			const dob = String(state.dob ?? '');
			const result = (await ctx.tool('verifyIdentity', { mrn, dob })) as IdentityResult;
			if (!result.verified || !result.patientId) {
				return { goto: verifyFailed, data: { verified: false, verifyReason: result.reason } };
			}
			return {
				goto: collectAppointment,
				data: { verified: true, patientId: result.patientId },
			};
		},
	});

	const collectIdentity = collect({
		id: 'collect-identity',
		schema: identitySchema,
		required: ['mrn', 'dob'],
		maxTurns: 4,
		instructions: (missing) =>
			`Collect MRN and date of birth before scheduling. Missing: ${missing.join(', ') || 'none'}. ` +
			`One short question at a time.`,
		onComplete: (data, state) => {
			Object.assign(state, data as Record<string, unknown>);
			return verifyIdentity;
		},
	});

	return defineFlow({
		name: 'schedule-visit',
		description: 'Verify identity, list appointments, and schedule a visit',
		start: collectIdentity,
		nodes: [
			collectIdentity,
			verifyIdentity,
			verifyFailed,
			collectAppointment,
			scheduleAppointment,
			listAppointments,
			present,
		],
		instructions: 'Verify patient identity then schedule or review appointments.',
	});
}

export function buildAgents(model: LanguageModel): AgentConfig[] {
	const fhirTools = wireTools(fhir.patientFhirTools);
	const rxAgentTools = wireTools({ ...rx.rxTools, ...fhir.patientFhirTools });
	const billingAgentTools = wireTools({
		...billing.billingTools,
		...fhir.patientFhirTools,
	});
	const verifyInsurance = buildVerifyInsuranceTool();
	const schedulingFlow = buildSchedulingFlow(model);

	const scheduler = defineAgent({
		id: 'scheduler',
		name: 'Scheduler',
		model,
		instructions: `${composePersonaPrompt(BuiltinPersonas.warm)}

Handle appointment scheduling for verified patients.

OPERATING RULES:
- Use the schedule-visit flow for booking, rescheduling context, or appointment questions.
- Identity verification and patientId threading are handled by the flow — do not call FHIR tools yourself.`,
		flows: [schedulingFlow],
		effectTools: fhirTools.effectTools,
		knowledge: {},
	});

	const triageRouter = defineAgent({
		id: 'triage-router',
		name: 'Triage Router',
		model,
		instructions: `${composePersonaPrompt(BuiltinPersonas.warm)}

DO NOT DIAGNOSE. Map symptoms to SELF_CARE, SCHEDULE_VISIT, NURSE_LINE, or URGENT_CARE. For emergencies, say call 911 only.`,
		knowledge: {},
	});

	const billingAgent = defineAgent({
		id: 'billing',
		name: 'Billing',
		model,
		instructions: `${composePersonaPrompt(BuiltinPersonas.warm)}

Handle billing for verified patients. Use run_verify_insurance when mrn, dob, invoiceId known. Never quote coverage from memory.`,
		tools: {
			...billingAgentTools.tools,
			run_verify_insurance: aiTool({
				description: verifyInsurance.description,
				inputSchema: verifyInsuranceInput,
			}) as (typeof billingAgentTools.tools)[string],
		},
		effectTools: { ...billingAgentTools.effectTools, run_verify_insurance: verifyInsurance },
		knowledge: {},
	});

	const rxAgent = defineAgent({
		id: 'rx',
		name: 'Pharmacy',
		model,
		instructions: `${composePersonaPrompt(BuiltinPersonas.warm)}

Handle prescription refills. Verify identity first. requestRenewal when no refills remain.`,
		tools: rxAgentTools.tools,
		effectTools: rxAgentTools.effectTools,
		knowledge: {},
	});

	const coordinator = defineAgent({
		id: 'coordinator',
		name: 'Cedar Coordinator',
		model,
		instructions: `${composePersonaPrompt(BuiltinPersonas.warm)}

Route patients to specialists. NEVER diagnose. For life-threatening symptoms, tell them to call 911 immediately.`,
		routes: [
			{ agent: 'scheduler', when: 'Appointment booking, reschedule, cancel.' },
			{ agent: 'triage-router', when: 'Non-emergency symptom routing.' },
			{ agent: 'billing', when: 'Billing, insurance eligibility, disputes.' },
			{ agent: 'rx', when: 'Prescription refills and renewals.' },
		],
		routing: { default: 'scheduler', mode: 'structured' },
		agents: [scheduler, triageRouter, billingAgent, rxAgent],
		memory: { preload: { enabled: true }, ingest: { enabled: true } },
	});

	return [coordinator, scheduler, triageRouter, billingAgent, rxAgent];
}
