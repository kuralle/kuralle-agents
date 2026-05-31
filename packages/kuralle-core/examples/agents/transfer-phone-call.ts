#!/usr/bin/env node

import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { buildToolSet, defineTool } from '../../src/tools/effect/defineTool.js';
import { loadExampleEnv, runV2Conversation, requireLiveModel } from '../_shared/v2Runner.js';

loadExampleEnv(import.meta.url);
const { model } = requireLiveModel();

const INSTRUCTIONS = `Helpful phone assistant for IVR navigation and call transfer.

- send_dtmf: press menu buttons when navigating automated menus.
- transfer_call: connect to a phone number in E.164 format — always read back the full number and confirm before transferring.
- end_call: natural sign-off when done.

Always explain what you are doing.`;

const sendDtmf = defineTool({
  name: 'send_dtmf',
  description: 'Send a DTMF button press to navigate an IVR menu.',
  input: z.object({ button: z.string().regex(/^[0-9*#]$/) }),
  execute: async ({ button }) => ({ sent: true, button, message: `Pressed ${button}` }),
});

const transferCall = defineTool({
  name: 'transfer_call',
  description: 'Transfer the call to another phone number in E.164 format.',
  input: z.object({ target_phone_number: z.string().min(8), message: z.string().optional() }),
  execute: async ({ target_phone_number, message }) => {
    const normalized = target_phone_number.replace(/[\s()-]/g, '');
    if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
      return { transferred: false, error: 'Invalid number. Use E.164 format like +14155551234' };
    }
    return { transferred: true, target_phone_number: normalized, message: message ?? 'Transferring now.' };
  },
});

const endCall = defineTool({
  name: 'end_call',
  description: 'End the call after a natural sign-off.',
  input: z.object({ message: z.string().optional() }),
  execute: async ({ message }) => ({ endCall: true, message: message ?? 'Thanks for calling. Goodbye!' }),
});

const tools = { send_dtmf: sendDtmf, transfer_call: transferCall, end_call: endCall };

const agent = defineAgent({
  id: 'transfer-phone-call',
  name: 'Transfer Phone Call',
  instructions: INSTRUCTIONS,
  model,
  tools: buildToolSet(tools),
  effectTools: tools,
});

console.log(
  'Intro: Hello! I am your phone assistant. I can help you navigate automated phone menus by pressing buttons, or transfer your call to another number. How can I help?',
);

runV2Conversation({
  title: 'Line transfer_phone_call parity (v2)',
  agent,
  prompts: [
    'I am in an IVR and want customer support.',
    'Please transfer me to +1 415 555 1234.',
    'Thanks bye.',
  ],
  onPart: (part) => {
    if (part.type === 'tool-result') console.log(`[Tool result] ${part.toolName} => ${JSON.stringify(part.result)}`);
  },
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
