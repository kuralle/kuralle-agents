import { openai } from '@ai-sdk/openai';
import { defineAgent, defineFlow, collect, reply } from '@kuralle-agents/core';
import { z } from 'zod';

const confirm = reply({
  id: 'confirm',
  instructions: 'Confirm the booking with the collected date, then end.',
  next: () => ({ end: 'done' }),
});

const getDate = collect({
  id: 'get_date',
  schema: z.object({ date: z.string() }),
  required: ['date'],
  instructions: (missing) => `Ask the user for: ${missing.join(', ')}`,
  onComplete: () => confirm,
});

const agent = defineAgent({
  id: 'booking',
  instructions: 'You are a booking agent.',
  model: openai('gpt-4o-mini'),
  flows: [
    defineFlow({
      name: 'booking',
      description: 'Book an appointment',
      start: getDate,
      nodes: [getDate, confirm],
    }),
  ],
});
