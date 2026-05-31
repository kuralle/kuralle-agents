# Triage protocols (non-emergency)

The runtime emergency guard catches life-threatening keywords BEFORE the
LLM is invoked. The protocols below are for everything else — the LLM's
`triage-router` role uses these to map a symptom description to a care
level.

## Tiers (least → most urgent)

### SELF_CARE
Common, mild, self-resolving. Examples:
- Mild cough, sore throat, runny nose < 5 days
- Bug bite without rapid swelling
- Minor scrape, no active bleeding
- Mild headache, no associated symptoms
- Constipation (24-48h, no severe pain)
- Heartburn

Action: provide common self-care guidance (rest, fluids, OTC). Don't
schedule. Suggest the patient call back if symptoms worsen.

### SCHEDULE_VISIT
Non-urgent but needs provider judgment. Examples:
- Sore throat lasting > 5 days
- Recurring headaches over 2+ weeks
- Skin issue not resolving over a week
- Sleep concerns
- Medication side-effect questions (non-acute)
- Follow-up after recent visit

Action: route to the patient's primary provider for a routine
appointment within 2 weeks.

### NURSE_LINE
Needs same-day clinical judgment. Examples:
- New rash with fever
- Wound showing infection signs
- Persistent vomiting (no dehydration signs yet)
- Worsening symptoms after recent illness
- Medication confusion (took 2x dose)
- Headache that's worse than usual

Action: route to the nurse-triage queue. Same-day callback target ≤ 4 hours.

### URGENT_CARE
Needs care today. Examples:
- Wound needing stitches
- Suspected sprain/fracture (limited mobility, swelling)
- Eye injury (non-chemical)
- Persistent vomiting WITH dehydration signs
- Migraine without typical pattern
- High fever (≥ 103°F adult, ≥ 102°F child) > 48h

Action: route to urgent-care clinic; provide the nearest location;
estimated wait info.

### EMERGENCY
**The runtime guard catches these BEFORE the LLM. This entry exists for
documentation only — the LLM never makes this decision.**

Patterns: chest pain, can't breathe, unconscious, suicidal ideation,
heavy bleeding, stroke symptoms, overdose, severe allergic reaction.

## When in doubt

Escalate one tier. The nurse line handles "I'm not sure if this is
urgent" calls all day. False positives are cheap; missed positives are
expensive.
