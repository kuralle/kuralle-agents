# campus-bot

University student-relationship assistant on kuralle. **Ported from the
Floe template** as the first port in `apps/templates/`. Demonstrates the
runtime-in-control pattern with a `routing agent` coordinator + 4 specialists,
including a deterministic `flow agent` for course add/drop.

## What it does

- **academic-advisor** — degree planning, GPA inquiries, course selection
- **financial-aid** — aid packages, SAP, payment plans, scholarships
- **wellbeing** — counseling, crisis support (surfaces Campus Care Line 1-800-555-CARE for distress signals)
- **add-drop-flow** — `flow agent` with deterministic expression transitions: extract `(courseCode, action)` → route by current term week → emit the correct reply (clean drop / drop-with-W / window-closed / late-add)

Mock data for two students:
- `s_001` Maya Tan — junior CS, GPA 3.42, good standing
- `s_002` Jordan Park — sophomore undeclared, GPA 1.78, SAP warning

## Why this matters (vs the Floe original)

The Floe campus-bot needed three runtime patches to stop:
1. Host LLM filler leaking before flow replies
2. Citation hallucinations (`[checkPlanPricing]`)
3. Empty-tool-arg calls from gpt-4.1-mini

**The kuralle port needs none of those.** The `routing agent` does
deterministic routing (runtime decides, not LLM). The `flow agent` uses
expression transitions that fire **before** LLM inference — there's no
host-narration surface to leak. Tool schemas with `z.string().min(1)`
get enforced by the runtime adapter before user code runs.

## Run it

```bash
cd apps/templates/campus-bot
# Set OPENAI_API_KEY in .env
pnpm install
pnpm dev
```

Listens on `http://localhost:3110`. Endpoints:
- `GET  /` — health
- `POST /api/chat`        — JSON (non-streaming)
- `POST /api/chat/stream` — chunked
- `POST /api/chat/sse`    — Server-Sent Events
- `WS   /agents/chat/:sessionId` — widget WebSocket

## Smoke

```bash
curl -N -X POST http://localhost:3110/api/chat/sse \
  -H 'content-type: application/json' \
  -d '{"message":"I am s_001. What is my GPA?","sessionId":"smoke-1"}'
```

Other prompts to exercise different paths:
- `"What aid deadlines are coming up?"` — financial-aid handoff
- `"Drop CS 351 for me"` — add-drop-flow with deterministic routing
- `"I've been feeling really overwhelmed"` — wellbeing role, surfaces Care Line
- `"I'm s_002. Am I in trouble academically?"` — academic-advisor + booking offer

## Files

```
src/
├── tools.ts            6 createTool() definitions + mock student/enrollment/aid data
├── flows/add-drop.ts   FlowConfig with expression-routed transitions (runtime-in-control)
├── agents.ts           routing agent coordinator + 3 LLM specialists + flow agent
├── knowledge.ts        Loads 3 .md docs as compiled knowledge for all agents
└── server.ts           Hono server with kuralle chat router
knowledge/
├── academic-policies.md
├── financial-aid.md
└── wellbeing-resources.md
```

## Production swap path

- Replace inline `STUDENTS`/`ENROLLMENTS`/`AID_PACKAGES`/`COURSE_CATALOG`/`DEADLINES`
  in `src/tools.ts` with real SIS / Banner / Workday reads
- Replace `currentWeek()` in `src/flows/add-drop.ts` with a real term-calendar lookup
- Wire crisis lines (1-800-555-CARE / 1-800-555-SAFE) to your campus's actual numbers
- For voice: add `@kuralle-agents/livekit-plugin-transport-twilio` and a voice channel mount
