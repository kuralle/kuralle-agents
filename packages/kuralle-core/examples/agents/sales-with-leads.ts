#!/usr/bin/env node

import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import {
  buildMissingFieldsMessage,
  computeMissingFields,
  extractStructuredFields,
  mergeExtractionData,
} from '../../src/flows/extraction.js';
import { buildToolSet, defineTool } from '../../src/tools/effect/defineTool.js';
import { loadExampleEnv, runV2Conversation, requireLiveModel } from '../_shared/v2Runner.js';

loadExampleEnv(import.meta.url);
const { model } = requireLiveModel();

interface LeadsState {
  name: string;
  company: string;
  email: string;
  phone: string;
  interest_level: 'high' | 'medium' | 'low' | 'unknown';
  pain_points: string[];
  budget_mentioned: boolean;
  next_steps: string;
  notes: string;
}

const INSTRUCTIONS = `Warm Cartesia sales rep on a phone call. Keep responses 1-3 sentences (<60 words).

Weave in: name, Cartesia overview, use-case discovery, contact info (name, company, phone), goodbye.

Call extract_leads after EVERY user response. Use research_company when you learn a company name.
Use end_call only after answering questions, collecting contact info, and explicit wrap-up.`;

const leadsExtractionSchema = z.object({
  name: z.string().optional(),
  company: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  interest_level: z.enum(['high', 'medium', 'low', 'unknown']).optional(),
  pain_points: z.array(z.string()).optional(),
  budget_mentioned: z.boolean().optional(),
  next_steps: z.string().optional(),
  notes: z.string().optional(),
});

const leads: LeadsState = {
  name: '',
  company: '',
  email: '',
  phone: '',
  interest_level: 'unknown',
  pain_points: [],
  budget_mentioned: false,
  next_steps: '',
  notes: '',
};

const researchedCompanies = new Set<string>();
const companyResearch: Record<string, unknown> = {};

function mergeLeads(extracted: Partial<LeadsState>): string[] {
  const updated: string[] = [];
  if (extracted.name && !leads.name) { leads.name = extracted.name; updated.push('name'); }
  if (extracted.company && !leads.company) { leads.company = extracted.company; updated.push('company'); }
  if (extracted.email && !leads.email) { leads.email = extracted.email; updated.push('email'); }
  if (extracted.phone && !leads.phone) { leads.phone = extracted.phone; updated.push('phone'); }
  if (extracted.interest_level && extracted.interest_level !== 'unknown') {
    leads.interest_level = extracted.interest_level;
    if (!updated.includes('interest_level')) updated.push('interest_level');
  }
  for (const p of extracted.pain_points ?? []) {
    if (p && !leads.pain_points.includes(p)) {
      leads.pain_points.push(p);
      if (!updated.includes('pain_points')) updated.push('pain_points');
    }
  }
  if (extracted.budget_mentioned && !leads.budget_mentioned) { leads.budget_mentioned = true; updated.push('budget_mentioned'); }
  if (extracted.next_steps && !leads.next_steps) { leads.next_steps = extracted.next_steps; updated.push('next_steps'); }
  if (extracted.notes) { leads.notes = leads.notes ? `${leads.notes}; ${extracted.notes}` : extracted.notes; updated.push('notes'); }
  return updated;
}

function latestUserMessage(ctx: { session: { messages: unknown[] } }): string {
  for (let i = ctx.session.messages.length - 1; i >= 0; i -= 1) {
    const m = ctx.session.messages[i] as { role?: string; content?: unknown };
    if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) return m.content.trim();
  }
  return '';
}

const extractLeads = defineTool({
  name: 'extract_leads',
  description: 'Extract and track lead information from the latest user message.',
  input: z.object({ conversation_summary: z.string().optional() }),
  execute: async ({ conversation_summary }, ctx) => {
    const message = latestUserMessage(ctx!) || conversation_summary || '';
    let extracted: Partial<LeadsState> = {};
    try {
      const structured = await extractStructuredFields({
        model,
        schema: leadsExtractionSchema,
        userMessage: message,
        systemPrompt: 'Extract only explicitly stated lead fields from the latest message.',
      });
      extracted = mergeExtractionData({}, structured as Record<string, unknown>) as Partial<LeadsState>;
    } catch {
      const lc = message.toLowerCase();
      extracted = { pain_points: [], notes: message.slice(0, 180) };
      const nameMatch = message.match(/(?:my name is|i am|this is)\s+([A-Za-z]+(?:\s+[A-Za-z]+){0,2})/i);
      if (nameMatch?.[1]) extracted.name = nameMatch[1].trim();
      const companyMatch = message.match(/(?:i work at|i am from|from)\s+([A-Za-z][A-Za-z0-9&\-\s]{1,60})/i);
      if (companyMatch?.[1]) extracted.company = companyMatch[1].trim();
      if (/budget|cost|pricing/.test(lc)) extracted.budget_mentioned = true;
      if (/urgent|asap|this quarter/.test(lc)) extracted.interest_level = 'high';
    }
    const updated = mergeLeads(extracted);
    const missingRequired = computeMissingFields(leads as unknown as Record<string, unknown>, ['name', 'company', 'phone']);
    return {
      updated_fields: updated,
      current_leads: { ...leads },
      missing_required: missingRequired,
      missing_message: buildMissingFieldsMessage(missingRequired),
      is_complete: missingRequired.length === 0,
      company_research: companyResearch,
    };
  },
});

const researchCompany = defineTool({
  name: 'research_company',
  description: 'Research a company for sales-relevant insights.',
  input: z.object({ company_name: z.string(), contact_name: z.string().optional() }),
  execute: async ({ company_name, contact_name }) => {
    const key = company_name.trim().toLowerCase();
    if (researchedCompanies.has(key)) {
      return { status: 'already_researched', company: company_name, research: companyResearch[key] };
    }
    const companyInfo = {
      company_overview: `${company_name} appears to be an organization where real-time voice workflows can improve customer communication.`,
      pain_points: ['Potentially high call handling costs', 'Variable response latency during peak hours'],
      key_people: contact_name ? [contact_name] : ['Leadership team not specified in this local parity demo'],
      sales_opportunities: ['Automate repetitive inbound voice interactions', 'Reduce wait times with low-latency AI voice agents'],
    };
    companyResearch[key] = companyInfo;
    researchedCompanies.add(key);
    return { status: 'success', company: company_name, company_info: companyInfo };
  },
});

const endCall = defineTool({
  name: 'end_call',
  description: 'End the sales call after contact details collected and user confirms.',
  input: z.object({ message: z.string().optional() }),
  execute: async ({ message }) => ({ endCall: true, message: message ?? 'Thanks for your time. We will follow up shortly.' }),
});

const tools = { extract_leads: extractLeads, research_company: researchCompany, end_call: endCall };

const agent = defineAgent({
  id: 'sales-with-leads',
  name: 'Sales With Leads Agent',
  instructions: INSTRUCTIONS,
  model,
  tools: buildToolSet(tools),
  effectTools: tools,
});

runV2Conversation({
  title: 'Line sales_with_leads parity (v2)',
  agent,
  prompts: [
    'Hi, my name is Samir Patel from Northstar Logistics.',
    'We are exploring AI voice agents because our call wait times are high.',
    'My phone is +1 415 555 0100 and email is samir@northstarlogistics.com',
    'We want to pilot this quarter if pricing works.',
    'Thanks, that is enough for now. Bye.',
  ],
  onPart: (part) => {
    if (part.type === 'tool-result') console.log(`[Tool result] ${part.toolName} => ${JSON.stringify(part.result)}`);
  },
}).then(() => {
  console.log('\nFinal leads state: ' + JSON.stringify(leads, null, 2));
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
