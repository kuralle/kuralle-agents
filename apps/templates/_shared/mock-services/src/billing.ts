/**
 * Billing + insurance mock.
 */
import { z } from 'zod';
import { createTool } from '@kuralle-agents/core';
import { MockStore } from './store.js';

export interface InvoiceLineItem {
	code: string;
	description: string;
	amountUsd: number;
}

export interface Invoice {
	id: string;
	patientId: string;
	issuedAt: string;
	amountUsd: number;
	dueDate: string;
	status: 'unpaid' | 'paid' | 'overdue' | 'in_dispute';
	insurance: { carrier: string; memberId: string; copayUsd: number };
	lineItems: InvoiceLineItem[];
}

const SEED: Invoice[] = [
	{ id: 'inv_chen_2025_06', patientId: 'p_chen_amy', issuedAt: '2026-05-01T00:00:00Z', amountUsd: 142.5, dueDate: '2026-06-01', status: 'unpaid', insurance: { carrier: 'BlueShield CA', memberId: 'BS-44129-AC', copayUsd: 25 }, lineItems: [{ code: '99213', description: 'Office visit — established patient, 20-29 min', amountUsd: 142.5 }] },
	{ id: 'inv_rivera_2025_05', patientId: 'p_rivera_jose', issuedAt: '2026-04-15T00:00:00Z', amountUsd: 320, dueDate: '2026-05-15', status: 'paid', insurance: { carrier: 'Medicare', memberId: 'MED-7714-JR', copayUsd: 0 }, lineItems: [{ code: '99214', description: 'Office visit — established patient, 30-39 min', amountUsd: 200 }, { code: '85025', description: 'CBC w/ differential', amountUsd: 120 }] },
];

const store = new MockStore<Invoice>(SEED);

const listSchema = z.object({
	patientId: z.string().min(1),
	status: z.enum(['unpaid', 'paid', 'overdue', 'in_dispute']).optional(),
});
export const listInvoicesForPatient = createTool({
	description: 'List invoices for a patient. REQUIRED arg: `patientId`. Optional `status` filter.',
	inputSchema: listSchema,
	async execute({ patientId, status }) {
		const hits = store.list().filter((i) => i.patientId === patientId && (!status || i.status === status));
		return { count: hits.length, invoices: hits };
	},
});

const idSchema = z.object({ invoiceId: z.string().min(1) });
export const getInvoice = createTool({
	description: 'Fetch a single invoice by id. REQUIRED arg: `invoiceId`.',
	inputSchema: idSchema,
	async execute({ invoiceId }) {
		const i = store.get(invoiceId);
		return i ?? { error: 'invoice-not-found', invoiceId };
	},
});

const verifySchema = z.object({ carrier: z.string().min(1), memberId: z.string().min(1) });
export const verifyInsurance = createTool({
	description: 'Run an insurance eligibility check (mock). BOTH args REQUIRED: `carrier`, `memberId`. Returns {eligible: bool, copayUsd?, reason?}.',
	inputSchema: verifySchema,
	async execute({ carrier, memberId }) {
		const inv = store.find((i) => i.insurance.carrier === carrier && i.insurance.memberId === memberId);
		if (!inv) return { eligible: false, reason: 'no_record' };
		return { eligible: true, copayUsd: inv.insurance.copayUsd, carrier, memberId };
	},
});

const disputeSchema = z.object({ invoiceId: z.string().min(1), reason: z.string().min(1) });
export const fileDispute = createTool({
	description: 'Flag an invoice as in-dispute (routes to billing team). BOTH args REQUIRED: `invoiceId`, `reason`.',
	inputSchema: disputeSchema,
	async execute({ invoiceId }) {
		const i = store.get(invoiceId);
		if (!i) return { error: 'invoice-not-found', invoiceId };
		return store.update(invoiceId, { status: 'in_dispute' });
	},
});

export const billingTools = { listInvoicesForPatient, getInvoice, verifyInsurance, fileDispute };
