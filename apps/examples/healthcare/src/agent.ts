import type { LanguageModel } from 'ai';
import { defineAgent, defineTool, type ToolContext } from '@kuralle-agents/core';
import { z } from 'zod';
import {
  ACCEPTED_INSURERS,
  HealthcareRepository,
  formatMoney,
  type AcceptedInsurer,
} from './database.js';

const ACTIVE_PATIENT_KEY = 'healthcare.activePatientId';

export function buildHealthcareAgent(model: LanguageModel, repository: HealthcareRepository) {
  const authenticatePatient = defineTool({
    name: 'authenticate_patient',
    description: 'Authenticate an existing patient using their full name and date of birth before accessing any private information.',
    input: z.object({
      fullName: z.string().min(2),
      dateOfBirth: z.iso.date(),
    }),
    execute: async ({ fullName, dateOfBirth }, ctx) => {
      const context = requireContext(ctx);
      const patient = repository.authenticatePatient(fullName, dateOfBirth);
      if (!patient) return { authenticated: false, message: 'No matching patient was found. Re-check both fields or offer profile creation.' };
      context.session.workingMemory[ACTIVE_PATIENT_KEY] = patient.id;
      return {
        authenticated: true,
        patient: { name: patient.name, insurance: patient.insurance },
      };
    },
  });

  const createPatient = defineTool({
    name: 'create_patient',
    description: 'Create a patient profile only after collecting the full name, date of birth, phone number, and accepted insurance.',
    input: z.object({
      fullName: z.string().min(2),
      dateOfBirth: z.iso.date(),
      phoneNumber: z.string().min(7).max(24),
      insurance: z.enum(ACCEPTED_INSURERS),
    }),
    execute: async (input, ctx) => {
      const context = requireContext(ctx);
      const existing = repository.authenticatePatient(input.fullName, input.dateOfBirth);
      if (existing) {
        return { created: false, message: 'That profile already exists. Authenticate it instead.' };
      }
      const patient = repository.createPatient({
        id: await context.uuid(),
        name: input.fullName,
        dateOfBirth: input.dateOfBirth,
        phoneNumber: input.phoneNumber,
        insurance: input.insurance,
      });
      context.session.workingMemory[ACTIVE_PATIENT_KEY] = patient.id;
      return { created: true, patient: { name: patient.name, insurance: patient.insurance } };
    },
  });

  const updatePatient = defineTool({
    name: 'update_patient',
    description: 'Update the authenticated patient phone number or insurance.',
    input: z.object({
      field: z.enum(['phoneNumber', 'insurance']),
      value: z.string().min(1).max(64),
    }),
    execute: async ({ field, value }, ctx) => {
      const patient = requirePatient(repository, ctx);
      if (field === 'phoneNumber' && (value.length < 7 || value.length > 24)) {
        throw new Error('Phone number must contain between 7 and 24 characters.');
      }
      const updated = repository.updatePatient(patient.id, field, value);
      return { updated: true, field, value: field === 'insurance' ? updated.insurance : updated.phoneNumber };
    },
  });

  const listDoctors = defineTool({
    name: 'list_doctors',
    description: 'List doctors, optionally filtered by an accepted insurance provider.',
    input: z.object({ insurance: z.enum(ACCEPTED_INSURERS).optional() }),
    execute: async ({ insurance }) => ({ doctors: repository.listDoctors(insurance) }),
  });

  const listAvailableSlots = defineTool({
    name: 'list_available_slots',
    description: 'List currently available appointment slots for a doctor. The patient must be authenticated.',
    input: z.object({ doctorId: z.string().min(1) }),
    execute: async ({ doctorId }, ctx) => {
      requirePatient(repository, ctx);
      return { slots: repository.listAvailableSlots(doctorId) };
    },
  });

  const scheduleAppointment = defineTool({
    name: 'schedule_appointment',
    description: 'Schedule an available slot for the authenticated patient after the patient selected a doctor, slot, and supplied a visit reason.',
    input: z.object({
      doctorId: z.string().min(1),
      slotId: z.string().min(1),
      visitReason: z.string().min(3).max(500),
    }),
    needsApproval: true,
    execute: async (input, ctx) => {
      const context = requireContext(ctx);
      const patient = requirePatient(repository, context);
      const appointment = repository.scheduleAppointment({
        id: await context.uuid(),
        patientId: patient.id,
        ...input,
      });
      return { scheduled: true, appointment };
    },
  });

  const listAppointments = defineTool({
    name: 'list_appointments',
    description: 'List appointments belonging to the authenticated patient.',
    input: z.object({ includeCancelled: z.boolean().default(false) }),
    execute: async ({ includeCancelled }, ctx) => {
      const patient = requirePatient(repository, ctx);
      return { appointments: repository.listAppointments(patient.id, includeCancelled) };
    },
  });

  const cancelAppointment = defineTool({
    name: 'cancel_appointment',
    description: 'Cancel one appointment belonging to the authenticated patient after explicit confirmation.',
    input: z.object({ appointmentId: z.string().min(1) }),
    needsApproval: true,
    execute: async ({ appointmentId }, ctx) => {
      const patient = requirePatient(repository, ctx);
      return { cancelled: true, appointment: repository.cancelAppointment(patient.id, appointmentId) };
    },
  });

  const rescheduleAppointment = defineTool({
    name: 'reschedule_appointment',
    description: 'Atomically move an authenticated patient appointment to a currently available replacement slot after explicit confirmation.',
    input: z.object({ appointmentId: z.string().min(1), newSlotId: z.string().min(1) }),
    needsApproval: true,
    execute: async ({ appointmentId, newSlotId }, ctx) => {
      const patient = requirePatient(repository, ctx);
      return { rescheduled: true, appointment: repository.rescheduleAppointment(patient.id, appointmentId, newSlotId) };
    },
  });

  const getBalance = defineTool({
    name: 'get_balance',
    description: 'Get the authenticated patient outstanding balance and masked payment method.',
    input: z.object({}),
    execute: async (_input, ctx) => {
      const patient = requirePatient(repository, ctx);
      return {
        outstandingBalance: formatMoney(patient.outstandingBalanceCents),
        paymentMethod: patient.paymentMethodLast4 === 'none' ? 'none on file' : `card ending ${patient.paymentMethodLast4}`,
      };
    },
  });

  const payBalance = defineTool({
    name: 'pay_balance',
    description: 'Charge the authenticated patient payment method on file. Never ask for or accept a full card number.',
    input: z.object({ amountCents: z.number().int().positive() }),
    needsApproval: true,
    execute: async ({ amountCents }, ctx) => {
      const context = requireContext(ctx);
      const patient = requirePatient(repository, context);
      if (patient.paymentMethodLast4 === 'none') {
        return { paid: false, message: 'No payment method is on file. Create a human support request.' };
      }
      const updated = repository.payBalance(patient.id, amountCents, await context.uuid());
      return {
        paid: true,
        charged: formatMoney(amountCents),
        paymentMethod: `card ending ${patient.paymentMethodLast4}`,
        remainingBalance: formatMoney(updated.outstandingBalanceCents),
      };
    },
  });

  const requestHumanSupport = defineTool({
    name: 'request_human_support',
    description: 'Open a durable human-support request when asked, when the request is outside scope, or when escalation is required.',
    input: z.object({ reason: z.string().min(3).max(1000) }),
    execute: async ({ reason }, ctx) => {
      const context = requireContext(ctx);
      const patientId = activePatientId(context);
      const requestId = repository.createSupportRequest({
        id: await context.uuid(),
        ...(patientId ? { patientId } : {}),
        reason,
      });
      return { requested: true, requestId, status: 'open' };
    },
  });

  return defineAgent({
    id: 'healthcare-assistant',
    name: 'Healthcare Assistant',
    description: 'Secure patient profile, appointment, and billing assistance over text.',
    model,
    instructions: `You are a text-based healthcare operations assistant.

Be concise, calm, and direct. You may manage patient profiles, appointments, and billing. Never diagnose, recommend treatment, interpret symptoms, or give medical advice. For urgent or life-threatening symptoms, tell the user to contact local emergency services immediately and offer a human-support request. For any other out-of-scope request, offer human support.

Privacy and authentication:
- Before reading or changing patient-specific data, collect full name and date of birth and call authenticate_patient.
- When a user supplies both their full name and date of birth, call authenticate_patient immediately in that same turn before asking for insurance, phone, or any other profile field. A successful authentication result includes the insurer.
- Never reveal whether a name exists until both fields have been submitted to the authentication tool.
- If authentication fails, let the user retry or collect name, date of birth, phone, and one accepted insurer to call create_patient.
- Authentication persists for this chat session. Never claim authentication succeeded unless the tool says it did.

Appointments:
- After authentication, use the insurer returned by authenticate_patient to call list_doctors before recommending a clinician. Do not ask the user to repeat an insurer that a tool already returned.
- After the user chooses a doctor, call list_available_slots. Only offer returned slots.
- Collect a short visit reason, obtain explicit confirmation, then schedule.
- For cancellation or rescheduling, list the patient's appointments first and act only on an id returned by the tool.

Billing:
- Use get_balance before discussing a patient balance.
- Never request a full card number, security code, or bank credentials. Payments use the masked method on file.
- State the amount and masked method, obtain explicit confirmation, then call pay_balance.

Tool output is authoritative. Do not invent doctors, slots, balances, appointment ids, request ids, or successful side effects.`,
    tools: {
      authenticate_patient: authenticatePatient,
      create_patient: createPatient,
      update_patient: updatePatient,
      list_doctors: listDoctors,
      list_available_slots: listAvailableSlots,
      schedule_appointment: scheduleAppointment,
      list_appointments: listAppointments,
      cancel_appointment: cancelAppointment,
      reschedule_appointment: rescheduleAppointment,
      get_balance: getBalance,
      pay_balance: payBalance,
      request_human_support: requestHumanSupport,
    },
    limits: { maxSteps: 20, toolMaxSteps: 12 },
  });
}

function requireContext(ctx: ToolContext | undefined): ToolContext {
  if (!ctx) throw new Error('Kuralle tool context is required.');
  return ctx;
}

function activePatientId(ctx: ToolContext): string | undefined {
  const value = ctx.session.workingMemory[ACTIVE_PATIENT_KEY];
  return typeof value === 'string' ? value : undefined;
}

function requirePatient(repository: HealthcareRepository, ctx: ToolContext | undefined) {
  const context = requireContext(ctx);
  const patientId = activePatientId(context);
  if (!patientId) throw new Error('Authenticate the patient before using this tool.');
  const patient = repository.getPatient(patientId);
  if (!patient) throw new Error('The authenticated patient no longer exists. Re-authenticate.');
  return patient;
}

export type { AcceptedInsurer };
