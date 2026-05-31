#!/usr/bin/env node

/**
 * Form Filler (Questionnaire) + Memory Demo (v2)
 */

import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { defineAgent } from '../../../src/authoring/defineAgent.js';
import { buildToolSet, defineTool } from '../../../src/tools/effect/defineTool.js';
import { createRuntime } from '../../../src/runtime/Runtime.js';
import { InMemoryMemoryService } from '../../../src/memory/stores/InMemoryMemoryService.js';
import { MemoryStore } from '../../../src/session/stores/MemoryStore.js';
import { loadExampleEnv } from '../../_shared/v2Runner.js';

loadExampleEnv(import.meta.url);

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is required');
  process.exit(1);
}

const USER_ID = 'patient-jordan';
const model = openai(process.env.OPENAI_MODEL ?? 'gpt-4o-mini');

type Question = {
  id: string;
  text: string;
  type: 'string' | 'select';
  options?: Array<{ value: string; text: string }>;
  dependsOn?: { questionId: string; operator?: 'in'; value: string[] };
};

const USER_PROMPT = `You are a friendly medical office assistant helping patients schedule appointments over the phone.
You have long-term memory. When you recall details, confirm them and skip to remaining questions.
Ask ONE question at a time. Call record_answer only with valid answers. Call end_call only after confirmation.`;

const questions: Question[] = [
  { id: 'patient_name', text: 'May I have your full name?', type: 'string' },
  { id: 'date_of_birth', text: 'What is your date of birth?', type: 'string' },
  {
    id: 'visit_type',
    text: 'What type of appointment?',
    type: 'select',
    options: [
      { value: 'annual_physical', text: 'Annual physical' },
      { value: 'sick_visit', text: 'Sick visit' },
      { value: 'follow_up', text: 'Follow-up' },
      { value: 'new_concern', text: 'New concern' },
      { value: 'prescription_refill', text: 'Prescription refill' },
    ],
  },
  {
    id: 'symptoms',
    text: 'Describe your symptoms.',
    type: 'string',
    dependsOn: { questionId: 'visit_type', operator: 'in', value: ['sick_visit', 'new_concern'] },
  },
  {
    id: 'preferred_doctor',
    text: 'Preferred doctor?',
    type: 'select',
    options: [
      { value: 'dr_smith', text: 'Dr. Smith' },
      { value: 'dr_johnson', text: 'Dr. Johnson' },
      { value: 'dr_williams', text: 'Dr. Williams' },
      { value: 'no_preference', text: 'No preference' },
    ],
  },
  { id: 'preferred_date', text: 'Preferred date?', type: 'string' },
  {
    id: 'preferred_time',
    text: 'Morning or afternoon?',
    type: 'select',
    options: [
      { value: 'morning', text: 'Morning' },
      { value: 'afternoon', text: 'Afternoon' },
      { value: 'flexible', text: 'Flexible' },
    ],
  },
  {
    id: 'urgency',
    text: 'How soon do you need to be seen?',
    type: 'select',
    options: [
      { value: 'urgent', text: 'ASAP' },
      { value: 'this_week', text: 'This week' },
      { value: 'next_week', text: 'Next week' },
      { value: 'flexible', text: 'Flexible' },
    ],
  },
  { id: 'insurance_provider', text: 'Insurance provider?', type: 'string' },
  { id: 'callback_number', text: 'Best callback number?', type: 'string' },
  { id: 'additional_notes', text: 'Anything else?', type: 'string' },
];

class FormFiller {
  private answers: Record<string, unknown> = {};
  private index = 0;

  private shouldShow(q: Question): boolean {
    if (!q.dependsOn) return true;
    const answer = this.answers[q.dependsOn.questionId];
    if (answer === undefined) return false;
    if (q.dependsOn.operator === 'in') {
      return q.dependsOn.value.includes(String(answer));
    }
    return true;
  }

  private current(): Question | null {
    while (this.index < questions.length) {
      const q = questions[this.index]!;
      if (this.shouldShow(q)) return q;
      this.index += 1;
    }
    return null;
  }

  getCurrentQuestionId(): string | null {
    return this.current()?.id ?? null;
  }

  getSystemPrompt(): string {
    const q = this.current();
    return `${USER_PROMPT}\n\nCurrent question: ${q?.id ?? 'complete'} — ${q?.text ?? 'Form complete'}\nAnswered: ${Object.keys(this.answers).length}`;
  }

  recordAnswer(answer: string): Record<string, unknown> {
    const q = this.current();
    if (!q) return { success: false, is_complete: true, completed: this.answers };

    if (q.type === 'select' && q.options) {
      const norm = answer.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();
      const match = q.options.find(
        (o) =>
          norm === o.value.toLowerCase() ||
          o.text.toLowerCase().includes(norm) ||
          norm.includes(o.text.toLowerCase()),
      );
      this.answers[q.id] = match?.value ?? answer;
    } else {
      this.answers[q.id] = answer;
    }

    this.index += 1;
    const next = this.current();
    return {
      success: true,
      completed: this.answers,
      next_question: next?.text ?? null,
      current_question_id: next?.id ?? null,
      is_complete: !next,
    };
  }

  getCompletedAnswers(): Record<string, unknown> {
    return { ...this.answers };
  }
}

const memoryService = new InMemoryMemoryService();
const sessionStore = new MemoryStore();

function createFormRuntime(form: FormFiller) {
  const recordAnswerTool = defineTool({
    name: 'record_answer',
    description: 'Record a VALID answer to the current form question.',
    input: z.object({
      question_id: z.string(),
      answer: z.string(),
    }),
    execute: async ({ question_id, answer }) => {
      const currentId = form.getCurrentQuestionId();
      if (currentId !== question_id) {
        return {
          success: false,
          error: `Question mismatch. Expected "${currentId}" but got "${question_id}".`,
          current_question_id: currentId,
        };
      }
      return form.recordAnswer(answer);
    },
  });

  const endCallTool = defineTool({
    name: 'end_call',
    description: 'End the call after form is complete and user confirms.',
    input: z.object({ message: z.string().optional() }),
    execute: async () => ({ endCall: true }),
  });

  const agent = defineAgent({
    id: 'form-filler-agent',
    name: 'Form Filler (Questionnaire + Memory)',
    instructions: () => form.getSystemPrompt(),
    model,
    tools: buildToolSet({ record_answer: recordAnswerTool, end_call: endCallTool }),
    memory: {
      preload: { enabled: true },
      ingest: { enabled: true },
    },
  });

  return createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
    defaultModel: model,
    sessionStore,
    memoryService,
  });
}

function separator(title: string) {
  console.log(`\n${'━'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'━'.repeat(60)}`);
}

async function chat(runtime: ReturnType<typeof createRuntime>, sessionId: string, input: string) {
  let response = '';
  console.log(`\n  User: ${input}`);
  const handle = runtime.run({ sessionId, input, userId: USER_ID });
  for await (const part of handle.events) {
    if (part.type === 'text-delta') response += part.text;
    if (part.type === 'tool-call') console.log(`  [Tool call] ${part.toolName}`);
    if (part.type === 'tool-result') console.log(`  [Tool result] ${part.toolName}`);
  }
  await handle;
  console.log(`  Assistant: ${response.trim()}`);
}

async function main() {
  console.log('=== Form Filler (Questionnaire) + Memory Demo (v2) ===\n');

  separator('SESSION 1: First appointment booking');
  const form1 = new FormFiller();
  const runtime1 = createFormRuntime(form1);

  for (const input of [
    'My name is Jordan Lee',
    'January 1 1989',
    'Sick visit',
    'Sore throat and fever',
    'Dr Smith',
    'Next Tuesday',
    'Morning',
    'This week',
    'BlueCross',
    '415-555-1234',
    'No additional notes',
    'Yes that all looks right, thank you and bye',
  ]) {
    await chat(runtime1, 'session-1', input);
  }

  separator('Session 1 — Completed Answers');
  console.log('  ' + JSON.stringify(form1.getCompletedAnswers(), null, 2).replace(/\n/g, '\n  '));

  const memories = await memoryService.searchMemory({
    userId: USER_ID,
    query: 'Jordan Lee BlueCross appointment',
    limit: 10,
  });
  separator('Ingested Memories');
  console.log(`  Total: ${memories.memories.length} entries`);

  separator('SESSION 2: Return visit');
  const runtime2 = createFormRuntime(new FormFiller());
  for (const input of [
    'Hi, I need to schedule a follow-up appointment.',
    'Dr Johnson please, next Friday afternoon.',
    'Next week urgency.',
    'No additional notes.',
    'Yes that looks correct, thanks!',
  ]) {
    await chat(runtime2, 'session-2', input);
  }

  separator('Done');
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
