# Hotel receptionist

A production-oriented, text-first Kuralle hotel agent for room inventory and bookings, dining, billing, concierge operations, privacy-sensitive guest messaging, and emergency dispatch. It runs in the repository CLI TUI and persists operational data in local SQLite.

## Run

Copy the variables from `.env.example` into the repository root `.env`, then run:

```bash
bun install
bun run --filter @kuralle-examples/hotel-receptionist chat
```

Pi is the default speaking and typed-flow driver. To use Core's built-in AI SDK driver instead:

```bash
bun run --filter @kuralle-examples/hotel-receptionist chat:default
```

The CLI stores resumable chat state and traces under `runs/`. The application database defaults to `data/hotel.sqlite`; override it with `HOTEL_DATABASE_PATH`.

## Demo bookings

Use one of these intentionally synthetic identities to exercise verified workflows:

| Guest | Confirmation | Card last four | Scenario |
|---|---|---|---|
| Mei Chen | `HTL-MN42` | `4477` | upcoming king booking |
| Marcus Johnson | `HTL-CD34` | `1881` | upcoming family booking |
| Kenji Tanaka | `HTL-RT88` | `7782` | seeded room conflict |
| Jonathan Pierce | `HTL-JP65` | `5151` | current/recent stay |

A booking lookup requires the last name plus either confirmation code or card last four. The agent never accepts a full payment card, security code, passport number, or bank credential.

## Behavioral boundaries

- Policy answers come from the checked-in handbook; availability, rates, identifiers, and successful actions come only from tools.
- Room allocation and modifications use overlap-safe SQLite transactions. Pet stays are restricted to pet-friendly inventory.
- Every persistent action pauses for CLI approval except emergency dispatch, where delay would be unsafe.
- Guest-presence requests never disclose whether someone is staying, even under claimed authority. Messages expose only a neutral receipt.
- Private functions remain confidential. Resent documents can go only to the verified email already on file.
- Medical, fire, and security emergencies dispatch hotel staff immediately and direct the caller to call 911; the agent gives no treatment instructions.

## Operations

```bash
bun run --filter @kuralle-examples/hotel-receptionist test
bun run --filter @kuralle-examples/hotel-receptionist typecheck
```

SQLite enables foreign keys, a five-second busy timeout, and WAL mode for file-backed databases. Back up the application database and CLI session/trace store together when conversational and operational recovery must be consistent.
