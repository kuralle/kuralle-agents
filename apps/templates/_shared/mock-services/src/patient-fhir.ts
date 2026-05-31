/**
 * FHIR-lite patient record mock.
 */
import { z } from 'zod';
import { createTool } from '@kuralle-agents/core';
import { MockStore } from './store.js';

export interface Appointment {
	id: string;
	provider: string;
	type: string;
	scheduledFor: string;
	status: 'scheduled' | 'completed' | 'canceled' | 'no_show';
	location: string;
}

export interface Patient {
	id: string;
	mrn: string;
	name: { given: string; family: string };
	dob: string;
	phone: string;
	primaryProvider: string;
	allergies: string[];
	activeMeds: string[];
	appointments: Appointment[];
}

const SEED: Patient[] = [
	{ id: 'p_chen_amy', mrn: 'MRN-100231', name: { given: 'Amy', family: 'Chen' }, dob: '1981-04-12', phone: '+1-415-555-2208', primaryProvider: 'dr-chen-l', allergies: ['penicillin'], activeMeds: ['lisinopril 10mg'], appointments: [{ id: 'appt_001', provider: 'dr-chen-l', type: 'follow-up', scheduledFor: '2026-05-27T15:00:00Z', status: 'scheduled', location: 'Cedar Health Main Clinic — Room 204' }] },
	{ id: 'p_rivera_jose', mrn: 'MRN-100410', name: { given: 'Jose', family: 'Rivera' }, dob: '1957-09-03', phone: '+1-415-555-2410', primaryProvider: 'dr-park-h', allergies: [], activeMeds: ['metformin 500mg', 'atorvastatin 20mg'], appointments: [{ id: 'appt_002', provider: 'dr-park-h', type: 'annual-physical', scheduledFor: '2026-06-04T14:30:00Z', status: 'scheduled', location: 'Cedar Health Main Clinic — Room 105' }] },
];

const store = new MockStore<Patient>(SEED);

const verifySchema = z.object({ mrn: z.string().min(1), dob: z.string().min(1) });
export const verifyIdentity = createTool({
	description: 'Identity check by MRN + DOB. BOTH args REQUIRED. Returns {verified: bool, patientId?: string, reason?: string}. SOFT check — production verification would also require phone OTP / pin. NEVER call get_patient before this returns verified=true.',
	inputSchema: verifySchema,
	async execute({ mrn, dob }) {
		const p = store.find((x) => x.mrn === mrn);
		if (!p) return { verified: false, reason: 'mrn_not_found' };
		return p.dob === dob ? { verified: true, patientId: p.id } : { verified: false, reason: 'dob_mismatch' };
	},
});

const patientIdSchema = z.object({ patientId: z.string().min(1) });
export const getPatient = createTool({
	description: 'Fetch a patient record by id. REQUIRED arg: `patientId`. Only call after verifyIdentity returns verified=true.',
	inputSchema: patientIdSchema,
	async execute({ patientId }) {
		const p = store.get(patientId);
		return p ?? { error: 'patient-not-found', patientId };
	},
});

export const listAppointments = createTool({
	description: 'List a verified patient\'s appointments (scheduled + completed). REQUIRED arg: `patientId`. Newest first.',
	inputSchema: patientIdSchema,
	async execute({ patientId }) {
		const p = store.get(patientId);
		if (!p) return { error: 'patient-not-found', patientId };
		return { count: p.appointments.length, appointments: p.appointments };
	},
});

const scheduleSchema = z.object({
	patientId: z.string().min(1),
	provider: z.string().min(1),
	type: z.string().min(1),
	scheduledFor: z.string().min(1),
	location: z.string().min(1),
});
export const scheduleAppointment = createTool({
	description: 'Book a new appointment for a verified patient. ALL FIVE args REQUIRED: `patientId`, `provider`, `type` (e.g. "annual-physical", "follow-up"), `scheduledFor` (ISO-8601), `location`. Returns the appointment with its assigned id.',
	inputSchema: scheduleSchema,
	async execute({ patientId, provider, type, scheduledFor, location }) {
		const p = store.get(patientId);
		if (!p) return { error: 'unknown_patient', patientId };
		const id = `appt_${Math.random().toString(36).slice(2, 8)}`;
		const appt: Appointment = { id, provider, type, scheduledFor, status: 'scheduled', location };
		store.update(patientId, { appointments: [...p.appointments, appt] });
		return appt;
	},
});

const rescheduleSchema = z.object({ patientId: z.string().min(1), appointmentId: z.string().min(1), newScheduledFor: z.string().min(1) });
export const rescheduleAppointment = createTool({
	description: 'Move an existing appointment to a new time. ALL THREE args REQUIRED: `patientId`, `appointmentId`, `newScheduledFor` (ISO-8601).',
	inputSchema: rescheduleSchema,
	async execute({ patientId, appointmentId, newScheduledFor }) {
		const p = store.get(patientId);
		if (!p) return { error: 'unknown_patient', patientId };
		const next = p.appointments.map((a) => (a.id === appointmentId ? { ...a, scheduledFor: newScheduledFor } : a));
		store.update(patientId, { appointments: next });
		return next.find((a) => a.id === appointmentId) ?? { error: 'appointment-not-found', appointmentId };
	},
});

const cancelSchema = z.object({ patientId: z.string().min(1), appointmentId: z.string().min(1) });
export const cancelAppointment = createTool({
	description: 'Cancel a scheduled appointment. BOTH args REQUIRED: `patientId`, `appointmentId`.',
	inputSchema: cancelSchema,
	async execute({ patientId, appointmentId }) {
		const p = store.get(patientId);
		if (!p) return { error: 'unknown_patient', patientId };
		const next = p.appointments.map((a) => (a.id === appointmentId ? { ...a, status: 'canceled' as const } : a));
		store.update(patientId, { appointments: next });
		return { ok: true };
	},
});

export const patientFhirTools = { verifyIdentity, getPatient, listAppointments, scheduleAppointment, rescheduleAppointment, cancelAppointment };
