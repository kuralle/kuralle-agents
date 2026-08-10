# Healthcare assistant

A production-oriented, text-first Kuralle agent for patient authentication, appointment management, billing, and human-support escalation. It runs in the repository CLI TUI and persists operational data in local SQLite.

## Run

Copy the environment variables from `.env.example` into the repository root `.env`, then run:

```bash
bun install
bun run --filter @kuralle-examples/healthcare chat
```

## Drivers

This example runs on the **Pi driver** by default.

| Driver | Command |
| --- | --- |
| Pi — the default | `bun run --filter @kuralle-examples/healthcare chat` |
| Core's built-in AI SDK driver | `bun run --filter @kuralle-examples/healthcare chat:ai-sdk` |

Both run the same agent. Set `KURALLE_DRIVER=pi` or `KURALLE_DRIVER=ai-sdk` to choose one
directly. The switch lives in `src/production-runtime.ts`, in this example — nothing is shared with the
other examples, so you can read the whole wiring in one folder.

The CLI stores resumable chat state and traces under `runs/`. The application database defaults to `data/healthcare.sqlite`; override it with `HEALTHCARE_DATABASE_PATH`.

## Demo identities

| Patient | Date of birth | Insurance | Payment method |
|---|---|---|---|
| Mary Jane | `2001-06-10` | Anthem | card ending 4242 |
| Peter Parker | `2001-08-10` | Aetna | card ending 1881 |

These records exist only to make the example operable immediately. New profiles start with no balance and no payment method.

## Behavioral boundaries

- A name and date-of-birth pair is required before any patient-specific read or mutation.
- Appointment slots are claimed transactionally. Cancellation restores inventory; rescheduling claims the replacement before releasing the old slot.
- Consequential scheduling, cancellation, rescheduling, and payment tools pause for CLI approval.
- The agent never accepts complete payment-card data. It can charge only the masked demo method already on file.
- It gives no diagnosis or medical advice. Emergencies are directed to local emergency services; other escalations create durable support requests.
- Tool results are authoritative: the model cannot invent clinicians, slots, balances, identifiers, or successful writes.

## Operations

```bash
bun run --filter @kuralle-examples/healthcare test
bun run --filter @kuralle-examples/healthcare typecheck
```

SQLite runs with foreign keys, a five-second busy timeout, and WAL mode for file-backed databases. Back up the database file and the CLI session/trace store together when conversational and operational recovery must be consistent.
