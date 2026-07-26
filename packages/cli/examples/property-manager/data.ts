/**
 * Fake backend + workspace content for the property-manager example.
 *
 * Modelled on AppFolio's Realm-X (a LangGraph production case study): a conversational
 * interface over units, residents, vendors and work orders. The shapes are small but the
 * relationships are real — a unit has a resident and a lease, a work order has a vendor and
 * a cost, and the spend cap is what makes approval matter.
 */

export interface Unit {
  id: string;
  address: string;
  resident: string;
  residentPhone: string;
  leaseEnds: string;
  owner: string;
  /** Owner-set cap. A dispatch above this needs the owner to approve. */
  approvalThresholdUsd: number;
}

export interface Vendor {
  id: string;
  name: string;
  trade: 'plumbing' | 'electrical' | 'hvac' | 'general' | 'locksmith';
  calloutUsd: number;
  emergency: boolean;
}

export const UNITS: Record<string, Unit> = {
  'A-101': {
    id: 'A-101',
    address: '14 Maple Court, Apt A-101',
    resident: 'Dana Whitfield',
    residentPhone: '+1-415-555-0142',
    leaseEnds: '2027-03-31',
    owner: 'Kestrel Holdings',
    approvalThresholdUsd: 400,
  },
  'A-204': {
    id: 'A-204',
    address: '14 Maple Court, Apt A-204',
    resident: 'Marcus Oyelaran',
    residentPhone: '+1-415-555-0188',
    leaseEnds: '2026-11-30',
    owner: 'Kestrel Holdings',
    approvalThresholdUsd: 250,
  },
  'B-12': {
    id: 'B-12',
    address: '9 Sycamore Row, Unit B-12',
    resident: 'Priya Raghunathan',
    residentPhone: '+1-415-555-0107',
    leaseEnds: '2026-08-15',
    owner: 'Bellweather Trust',
    approvalThresholdUsd: 1000,
  },
};

export const VENDORS: Vendor[] = [
  { id: 'v-plumb-1', name: 'Ridgeline Plumbing', trade: 'plumbing', calloutUsd: 180, emergency: true },
  { id: 'v-plumb-2', name: 'Bayfront Drain Co', trade: 'plumbing', calloutUsd: 95, emergency: false },
  { id: 'v-elec-1', name: 'Kilowatt Electric', trade: 'electrical', calloutUsd: 240, emergency: true },
  { id: 'v-hvac-1', name: 'Northgate HVAC', trade: 'hvac', calloutUsd: 320, emergency: true },
  { id: 'v-gen-1', name: 'Trellis Handyman', trade: 'general', calloutUsd: 75, emergency: false },
  { id: 'v-lock-1', name: 'Anchor Locksmith', trade: 'locksmith', calloutUsd: 130, emergency: true },
];

/** Mutable so the example can show state actually changing across turns. */
export const WORK_ORDERS: Array<{
  id: string;
  unitId: string;
  issue: string;
  urgency: string;
  status: string;
  vendorId?: string;
  estimateUsd?: number;
}> = [
  { id: 'WO-1041', unitId: 'A-204', issue: 'Bedroom window latch broken', urgency: 'routine', status: 'open' },
  { id: 'WO-1039', unitId: 'B-12', issue: 'Dishwasher not draining', urgency: 'routine', status: 'awaiting_vendor' },
];

/** Counts real executions, so replay/exactly-once can be observed rather than asserted. */
export const sideEffects = { dispatches: 0, workOrdersCreated: 0, messagesSent: 0 };

/** Called after the counter increments, so the first created order is WO-1042. */
export function nextWorkOrderId(): string {
  return `WO-${1041 + sideEffects.workOrdersCreated}`;
}

/**
 * The workspace filesystem: policy as markdown the agent greps, not prompt text.
 * Keeping it out of the prompt is the point — the prompt says *how to look things up*,
 * the filesystem holds *what is true*, and it can change without redeploying the agent.
 */
export const WORKSPACE_FILES: Record<string, string> = {
  '/policy/maintenance.md': `# Maintenance policy

## Urgency tiers
- **emergency** — risk to health, safety, or active property damage. Dispatch immediately,
  no spend cap applies. Examples: burst pipe, no heat below 55F, gas smell, no working lock
  on an exterior door, sewage backup, electrical burning smell.
- **urgent** — habitability affected but no active damage. Target 24 hours.
  Examples: no hot water, refrigerator failure, single-room heat loss, toilet not flushing
  where it is the only toilet.
- **routine** — everything else. Target 5 business days.

## Spend approval
Every unit has an owner-set approval threshold. A vendor dispatch whose estimate is at or
below the threshold proceeds. **Above the threshold it requires owner approval before the
vendor is dispatched.** Emergencies are exempt from the threshold but must still be logged.

## After-hours
Routine work is not dispatched outside 08:00-18:00 local. Emergencies always are.
`,

  '/policy/lease-terms.md': `# Standard lease terms (excerpt)

## Repairs and responsibility
- Landlord is responsible for structural, plumbing, electrical, heating, and appliances
  supplied with the unit.
- Resident is responsible for damage caused by negligence or misuse, and for consumables:
  light bulbs, filters, batteries in resident-owned devices.
- Resident-caused damage is billed back to the resident at cost plus a 10% coordination fee.

## Entry notice
24 hours written notice is required for non-emergency entry. Emergency entry requires no
notice but must be logged with the reason and the time.

## Rent and fees
Rent is due on the 1st. A late fee applies after the 5th. Fee amounts are set per lease and
are NOT listed in this document — look them up per unit rather than quoting a number.
`,

  '/policy/escalation.md': `# When to escalate to a human property manager

Escalate — do not attempt to resolve — when any of these appear:

- The resident threatens legal action, mentions a lawyer, or references a habitability claim.
- A dispute about who is liable for a cost, where the resident disagrees with the assessment.
- Anything involving eviction, non-payment, or lease termination.
- Injury to a person, or a claim of injury.
- The resident asks for a rent reduction, credit, or waiver.
- Repeat failure: the same issue reported a third time in 60 days.

Escalating is not a failure. It is the correct outcome for these cases.
`,

  '/skills/triage-work-order/SKILL.md': `---
name: triage-work-order
description: Classify a maintenance issue into emergency, urgent, or routine and pick the trade. Use when a resident or manager reports a maintenance problem and the urgency is not already established.
---

# Triaging a maintenance report

Work the classification in this order. Stop at the first tier that matches.

## 1. Is it an emergency?
Ask: is someone at risk, or is the property actively being damaged right now?
Signals: water actively flowing, no heat in freezing conditions, gas, smoke, burning smell,
exposed live wiring, unsecured exterior door, sewage inside the unit.
If yes -> **emergency**. No spend cap applies. Do not wait for approval.

## 2. Is habitability affected?
Ask: can the resident reasonably live in the unit tonight without this?
Signals: no hot water, no working toilet (and it is the only one), refrigerator dead,
no heat in one room, no working stove.
If yes -> **urgent**.

## 3. Otherwise
-> **routine**.

## Picking the trade
- water, drains, toilets, leaks -> plumbing
- outlets, breakers, lighting, wiring -> electrical
- heat, cooling, ventilation -> hvac
- locks, keys, entry -> locksmith
- anything else -> general

## What NOT to infer
Do not guess the cost. Do not promise a time window beyond the policy target. Do not decide
liability (landlord vs resident) — that is in the lease terms, and disputes escalate.
`,
};
