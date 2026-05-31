/**
 * Prescription / Rx system mock.
 */
import { z } from 'zod';
import { createTool } from '@kuralle-agents/core';
import { MockStore } from './store.js';

export interface Prescription {
	id: string;
	patientId: string;
	medication: string;
	prescriber: string;
	writtenOn: string;
	refillsRemaining: number;
	lastFilledAt: string;
	pharmacy: string;
	status: 'active' | 'needs_renewal' | 'expired' | 'discontinued';
}

const SEED: Prescription[] = [
	{ id: 'rx_chen_lisinopril', patientId: 'p_chen_amy', medication: 'lisinopril 10mg', prescriber: 'dr-chen-l', writtenOn: '2026-02-14', refillsRemaining: 3, lastFilledAt: '2026-04-20T16:00:00Z', pharmacy: 'CVS — 24th & Mission', status: 'active' },
	{ id: 'rx_rivera_metformin', patientId: 'p_rivera_jose', medication: 'metformin 500mg', prescriber: 'dr-park-h', writtenOn: '2026-01-30', refillsRemaining: 5, lastFilledAt: '2026-05-01T11:00:00Z', pharmacy: 'Walgreens — Cesar Chavez', status: 'active' },
	{ id: 'rx_rivera_atorvastatin', patientId: 'p_rivera_jose', medication: 'atorvastatin 20mg', prescriber: 'dr-park-h', writtenOn: '2026-01-30', refillsRemaining: 0, lastFilledAt: '2026-05-01T11:00:00Z', pharmacy: 'Walgreens — Cesar Chavez', status: 'needs_renewal' },
];

const store = new MockStore<Prescription>(SEED);

const patientIdSchema = z.object({ patientId: z.string().min(1) });
export const listForPatient = createTool({
	description: 'List every prescription for a patient. REQUIRED arg: `patientId`. Returns id + medication + status + refillsRemaining + lastFilledAt + pharmacy per rx.',
	inputSchema: patientIdSchema,
	async execute({ patientId }) {
		const hits = store.list().filter((r) => r.patientId === patientId);
		return { count: hits.length, prescriptions: hits };
	},
});

const refillSchema = z.object({ prescriptionId: z.string().min(1) });
export const requestRefill = createTool({
	description: 'Request a refill for a prescription. REQUIRED arg: `prescriptionId`. Succeeds only if refillsRemaining > 0; otherwise returns {error: "no_refills_remaining", nextStep: "request_renewal"} so the agent routes to renewal.',
	inputSchema: refillSchema,
	async execute({ prescriptionId }) {
		const rx = store.get(prescriptionId);
		if (!rx) return { error: 'unknown_prescription', prescriptionId };
		if (rx.refillsRemaining <= 0) {
			return {
				error: 'no_refills_remaining',
				nextStep: 'request_renewal',
				prescriber: rx.prescriber,
				pharmacy: rx.pharmacy,
			};
		}
		return store.update(prescriptionId, {
			refillsRemaining: rx.refillsRemaining - 1,
			lastFilledAt: new Date().toISOString(),
		});
	},
});

const renewalSchema = z.object({ prescriptionId: z.string().min(1), notesForPrescriber: z.string().optional() });
export const requestRenewal = createTool({
	description: 'Request a renewal — routes to the prescriber. REQUIRED arg: `prescriptionId`. Optional `notesForPrescriber`. Returns a renewal request id + prescriber + pharmacy + medication. (Mock always succeeds.)',
	inputSchema: renewalSchema,
	async execute({ prescriptionId }) {
		const rx = store.get(prescriptionId);
		if (!rx) return { error: 'unknown_prescription', prescriptionId };
		return {
			ok: true,
			renewalRequestId: `rrq_${Math.random().toString(36).slice(2, 10)}`,
			prescriber: rx.prescriber,
			pharmacy: rx.pharmacy,
			medication: rx.medication,
		};
	},
});

export const rxTools = { listForPatient, requestRefill, requestRenewal };
