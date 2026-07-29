import type { FileSystem, SkillStoreLike } from '@kuralle-agents/core';
import { fsSkillStore } from '@kuralle-agents/core';
import {
  CompositeFileSystem,
  InMemoryFs,
  readOnlyFileSystem,
} from '@kuralle-agents/fs';

const KNOWLEDGE_FILES = {
  '/formulary/common-medicines.md': `# Demonstration formulary

This is sample commerce data, not prescribing guidance.

| Medicine | Strength | Form | Price (LKR) | Stock |
| --- | --- | --- | ---: | ---: |
| Amoxicillin | 500 mg | capsule | 42.00 | 36 |
| Paracetamol | 500 mg | tablet | 8.50 | 120 |
| Metformin | 500 mg | tablet | 18.00 | 64 |
| Cetirizine | 10 mg | tablet | 14.00 | 48 |
| Salbutamol | 100 mcg | inhaler | 1,450.00 | 8 |
`,
  '/policies/prescription-safety.md': `# Prescription safety boundary

- Never diagnose, prescribe, change a dose, or interpret ambiguous handwriting as certain.
- Ask the customer to confirm any unclear medicine name, strength, form, or quantity.
- A pharmacist must review prescription-only orders before fulfilment.
- For severe symptoms or emergencies, direct the customer to local emergency care.
- Do not expose internal stock counts, customer notes, or system identifiers.
`,
  '/policies/fulfilment.md': `# Fulfilment

- Demo opening hours: 08:00–20:00 Asia/Colombo.
- Same-day delivery is available only after pharmacist review and address confirmation.
- Cold-chain, controlled, and unavailable medicines require human pharmacy follow-up.
- Quote only prices returned by an inventory tool or the current formulary.
`,
} as const;

const SKILL_FILES = {
  '/skills/prescription-intake/SKILL.md': `---
name: prescription-intake
description: Use when a customer shares or describes a prescription and needs safe medicine identification or availability checking.
allowed-tools: [workspace, search_inventory, record_case_note]
---
# Prescription intake

Reference: when you need the six intake questions, call read_skill_resource with name \`prescription-intake\` and path \`references/clarification-checklist.md\`.

1. Inspect the prescription text or image carefully. Treat uncertain characters as uncertain.
2. Call the workspace tool with op read/cat and absolute path /knowledge/policies/prescription-safety.md before handling an ambiguous or prescription-only request. Do not use read_skill_resource for /knowledge paths.
3. Extract medicine, strength, form, and quantity separately. Ask one concise clarification for anything ambiguous.
4. Call search_inventory only for customer-confirmed details. Never invent a match.
5. Call record_case_note with a minimal, non-diagnostic summary when follow-up is needed.
6. Explain that availability is not dispensing approval; a pharmacist performs the final review.
`,
  '/skills/prescription-intake/references/clarification-checklist.md': `# Clarification checklist

- Medicine name readable?
- Strength and unit readable?
- Dosage form clear?
- Quantity clear?
- Prescription-only or controlled item?
- Any urgent symptom requiring emergency redirection?
`,
  '/skills/order-fulfilment/SKILL.md': `---
name: order-fulfilment
description: Use when a customer asks to add, remove, review, or prepare medicines for pharmacy fulfilment.
allowed-tools: [search_inventory, add_to_cart, remove_from_cart, view_cart, record_case_note, workspace]
---
# Order fulfilment

1. Load current inventory before adding an item; tool output is authoritative.
2. Add only an item the customer explicitly named and confirmed.
3. Use view_cart before summarising the order. Never reconstruct it from conversation prose.
4. State that prescription-only orders remain pending pharmacist review.
5. Use workspace op read/cat on /knowledge/policies/fulfilment.md for hours and delivery questions. Do not use read_skill_resource for /knowledge paths.
6. Keep internal stock counts and note paths private.
`,
} as const;

export const PHARMACY_WORKSPACE_INSTRUCTIONS =
  'Read-only pharmacy references are mounted at /knowledge. Durable private working notes are mounted at /notes. ' +
  'Search before reading whole files. Never expose note paths or internal stock counts. Only mutate /notes.';

export function createPharmacyWorkspace(notes: FileSystem): CompositeFileSystem {
  return new CompositeFileSystem({
    mounts: {
      '/knowledge': readOnlyFileSystem(new InMemoryFs(KNOWLEDGE_FILES)),
      '/notes': notes,
    },
  });
}

/** Skills live outside the model-traversable workspace and disclose progressively. */
export function createPharmacySkillStore(): SkillStoreLike {
  const skillFs = new InMemoryFs(SKILL_FILES);
  return fsSkillStore(skillFs, ['/skills']);
}

export function knowledgeFixture(): FileSystem {
  return readOnlyFileSystem(new InMemoryFs(KNOWLEDGE_FILES));
}
