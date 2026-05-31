#!/usr/bin/env bun

import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { defineFlow, reply } from '../../src/authoring/nodes.js';
import { buildToolSet, defineTool } from '../../src/tools/effect/defineTool.js';
import { loadExampleEnv, requireLiveModel, runV2Conversation } from '../_shared/v2Runner.js';

loadExampleEnv(import.meta.url);
const { model } = requireLiveModel();

const introRole =
  "You are a warm, engaging podcast host with a natural conversational style. You're genuinely curious about your guests and skilled at making them feel comfortable while drawing out interesting insights. Your questions flow naturally, and you listen actively, building on what your guest shares.";

const end = reply({
  id: 'final',
  instructions:
    'Thank the guest one final time for joining you and for sharing their insights. End the conversation on a positive, warm note.',
  model,
  next: () => ({ end: 'interview_completed' }),
});

const conclusion = reply({
  id: 'conclusion',
  instructions:
    "Express genuine appreciation for the conversation and the insights your guest shared. Summarize 2-3 key takeaways or memorable points from your discussion in a warm, conversational way—this helps reinforce the value of the conversation. Then, ask your guest if they have any final thoughts, a last word, or anything else they'd like to add. Wait for their response, then use the end_interview function to wrap up.",
  model,
  tools: buildToolSet({
    end_interview: defineTool({
      name: 'end_interview',
      description: 'Use this after the guest has shared their final thoughts.',
      input: z.object({}),
      execute: async () => ({ done: true }),
    }),
  }),
  next: (turn) => (turn.toolResults.some((r) => r.name === 'end_interview') ? end : 'stay'),
});

const interview = reply({
  id: 'interview',
  instructions:
    "You're now in the heart of the interview. Start by introducing the topic with enthusiasm, then dive deep into one key aspect at a time. Ask open-ended, thoughtful questions that invite storytelling and personal insights. Listen actively to responses and ask natural follow-up questions that build on what your guest shares—dig deeper into interesting points, ask for examples, or explore the 'why' behind their answers. Keep the conversation flowing naturally, like a genuine dialogue between friends. Once you've thoroughly explored an aspect (typically after 3-5 exchanges), use the next_question function to smoothly transition to the next key aspect. After covering 3 key aspects of the topic, use the wrap_up function to conclude the interview.",
  model,
  tools: buildToolSet({
    next_question: defineTool({
      name: 'next_question',
      description: "Use this after you've thoroughly explored the current aspect with multiple questions and follow-ups.",
      input: z.object({}),
      execute: async (_args, ctx) => ({
        aspects_covered: ((ctx!.runState.state.aspects_covered as number) ?? 0) + 1,
      }),
    }),
    wrap_up: defineTool({
      name: 'wrap_up',
      description: "Use this when you've gathered substantial insights and are ready to wrap up.",
      input: z.object({}),
      execute: async () => ({ wrap: true }),
    }),
  }),
  next: (turn) => {
    if (turn.toolResults.some((r) => r.name === 'wrap_up')) return conclusion;
    const nextQ = turn.toolResults.find((r) => r.name === 'next_question');
    if (nextQ?.result) {
      return { goto: interview, data: nextQ.result as Record<string, unknown> };
    }
    return 'stay';
  },
});

const topic = reply({
  id: 'topic',
  instructions:
    "Now that you know who the guest is, help them choose the topic they'd like to explore. Refer back to their introduction to personalize the transition. Ask what topic, story, or challenge they're excited to discuss today. Show genuine interest and, if needed, ask a clarifying question to make sure you understand the angle they want to take. Once the topic feels clear and specific enough to dive into, use the start_interview function.",
  model,
  tools: buildToolSet({
    start_interview: defineTool({
      name: 'start_interview',
      description: 'Use this when the guest has shared a clear topic they want to explore.',
      input: z.object({ topic: z.string().describe('The topic the guest wants to discuss') }),
      execute: async ({ topic: t }) => ({ topic: t, aspects_covered: 0 }),
    }),
  }),
  next: (turn) => {
    const r = turn.toolResults.find((t) => t.name === 'start_interview');
    if (r?.result) return { goto: interview, data: r.result as Record<string, unknown> };
    return 'stay';
  },
});

const introduction = reply({
  id: 'introduction',
  instructions: `${introRole}\n\nWelcome the guest warmly and enthusiastically. Focus this exchange on getting to know who they are. Invite them to briefly introduce themselves—name, role, current focus, or anything fun they'd like to share. Ask one follow-up question if it helps clarify or highlight something interesting about them. Once you feel you have a clear introduction, use the proceed_to_topic function to move into topic selection.`,
  model,
  tools: buildToolSet({
    proceed_to_topic: defineTool({
      name: 'proceed_to_topic',
      description: 'Use after the guest has introduced themselves.',
      input: z.object({
        guest_summary: z.string().describe('A quick summary of who the guest is (name, role, area of expertise, etc.)'),
      }),
      execute: async ({ guest_summary }) => ({ guest_summary }),
    }),
  }),
  next: (turn) => {
    const r = turn.toolResults.find((t) => t.name === 'proceed_to_topic');
    if (r?.result) return { goto: topic, data: r.result as Record<string, unknown> };
    return 'stay';
  },
});

const agent = defineAgent({
  id: 'podcast-interview-flow',
  name: 'Podcast Interview (Pipecat parity)',
  instructions: introRole,
  model,
  flows: [
    defineFlow({
      name: 'interview',
      description: 'Podcast interview flow',
      start: introduction,
      nodes: [introduction, topic, interview, conclusion, end],
      maxOscillations: 10,
    }),
  ],
});

runV2Conversation({
  title: 'Pipecat Podcast Interview (v2)',
  agent,
  prompts: [
    'Hi, I am Sam, product designer focused on creative tooling.',
    'Let us talk about designing delightful AI interfaces.',
    'First aspect is reducing friction in onboarding. Move to the next aspect after this.',
    'Second aspect is building trust with transparent controls. Move to the next aspect.',
    'Third aspect is balancing speed and craft. Please wrap up after this.',
    'My final thought is to keep listening to users. You can end the interview.',
  ],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
