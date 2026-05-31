/**
 * Simple Voice Agent Example
 *
 * Demonstrates VoiceEngine usage with Gemini Live Native Audio.
 *
 * Prerequisites:
 * - GOOGLE_API_KEY environment variable set
 * - A WebSocket server to pipe audio
 *
 * Usage:
 *   npx tsx examples/simple-voice-agent/run.ts
 */

import { tool } from 'ai';
import { z } from 'zod';
import { createFoundation } from '@kuralle-agents/core/foundation';
import { VoiceEngine } from '../../src/index.js';

const checkAvailability = tool({
  description: 'Check appointment availability for a given date',
  inputSchema: z.object({
    date: z.string().describe('Date in YYYY-MM-DD format'),
    department: z.string().describe('Hospital department'),
  }),
  execute: async (args) => ({
    date: args.date,
    department: args.department,
    available_slots: ['09:00', '10:30', '14:00', '15:30'],
  }),
});

const bookAppointment = tool({
  description: 'Book an appointment at the hospital',
  inputSchema: z.object({
    date: z.string().describe('Date in YYYY-MM-DD format'),
    time: z.string().describe('Time in HH:MM format'),
    department: z.string().describe('Hospital department'),
    patient_name: z.string().describe('Patient full name'),
  }),
  execute: async (args) => ({
    confirmation_id: `APT-${Date.now()}`,
    date: args.date,
    time: args.time,
    department: args.department,
    patient_name: args.patient_name,
    status: 'confirmed',
  }),
});

const foundation = createFoundation({
  defaultAgentId: 'hospital-assistant',
});

const engine = new VoiceEngine({
  foundation,
  agents: [
    {
      id: 'hospital-assistant',
      name: 'Hospital Voice Assistant',
      instructions: `You are a helpful hospital appointment assistant.
You help patients check availability and book appointments.
Be concise and friendly. Confirm details before booking.`,
      tools: { check_availability: checkAvailability, book_appointment: bookAppointment },
      voice: 'Kore',
    },
  ],
  defaultAgentId: 'hospital-assistant',
  gemini: {
    apiKey: process.env.GOOGLE_API_KEY!,
    model: 'gemini-2.5-flash-native-audio-preview',
  },
});

console.log('VoiceEngine created. Ready to accept calls.');
console.log('Connect a WebSocket transport to start a voice call.');
