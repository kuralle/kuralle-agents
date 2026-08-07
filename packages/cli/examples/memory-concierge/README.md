# memory-concierge

A CLI agent exercising the extraction chain end to end, **across separate processes**.

```bash
kuralle send --agent packages/cli/examples/memory-concierge/agent.ts --user mithushan --session s1 \
  "I'm Mithushan, I run a bakery in Colombo and I'm allergic to penicillin and shellfish."

kuralle send --agent packages/cli/examples/memory-concierge/agent.ts --user mithushan --session s2 \
  "What do you know about me?"

kuralle send --agent packages/cli/examples/memory-concierge/agent.ts --user mithushan --session s3 \
  "Am I allergic to anything?"
```

The second and third commands are new processes and new sessions. Both recall
the first because both extractors wrote to a `FileExtractedValueStore` on
disk. An in-memory store would make this pass inside one process and fail the
moment it mattered.

The second command is answered by `memory.preload` — it injects the `facts`
slug into the system prompt automatically, every turn. `dietary-profile` is
never preloaded (preload only ever reads `facts`); the only path to it is
`search_memory`. In this three-command flow the model *also* has a second way
to reach it, though: this agent additionally declares `workingMemory`, so in
turn 1 the model chose to write "Allergic to penicillin and shellfish" into
the `USER` block too, and that block is injected into every later prompt
unconditionally — so turn 3 can be answered straight from context, without a
tool call at all. Watch `[events]` in the CLI output to see which happened.

For an unambiguous proof that `search_memory` itself works — no working-memory
block to fall back on — seed only the extractor store for a fresh user and ask
without ever having written anything to a block:

```bash
mkdir -p packages/cli/examples/memory-concierge/.memory/extracted/user/search-demo
cat > packages/cli/examples/memory-concierge/.memory/extracted/user/search-demo/dietary-profile.json <<'JSON'
{"slug":"dietary-profile","scope":"user","value":{"allergies":["peanuts"],"avoids":["dairy"]},"updatedAt":"2026-08-07T00:00:00.000Z"}
JSON

kuralle send --agent packages/cli/examples/memory-concierge/agent.ts --user search-demo --session s1 \
  "Am I allergic to anything?"
```

This prints `[events] tool:search_memory` and answers "peanuts" — the only
place that word exists anywhere in this session.

`--user` is required. Without it the session has no owner, and user-scoped
memory is skipped rather than pooled into a bucket shared with every other
anonymous session — see `resolveWorkingMemoryOwner`.

## What lands on disk

```
.memory/extracted/user/mithushan/facts.json            <- factsExtractor()
.memory/extracted/user/mithushan/dietary-profile.json  <- the custom extractor
.memory/blocks/user/mithushan/USER.md                  <- working memory
```

Two separate trees, two different tools. `memory_block` is an enum over the
declared *blocks* only — it cannot see either extracted-value file. Extracted
values have their own read path, `search_memory`, itself an enum over the
declared *extractors* (`facts`, `dietary-profile`) and nothing else.

## Observed behaviour

**One merged call, two extractors.** Turn 1 wrote both files from a single
structured completion.

**`onExtracted` shapes before storage.** "penicillin and shellfish" persisted as
`["penicillin","shellfish"]` — lowercased, deduped, sorted by the hook.

**Merge replaces, does not append.** After *"I've moved the bakery to Kandy.
Also I'm no longer allergic to shellfish"*:

| | before | after |
| --- | --- | --- |
| facts | `bakery in Colombo` | `bakery in Kandy` |
| dietary-profile | `["penicillin","shellfish"]` | `["penicillin"]` |

The stale entries are gone rather than sitting beside the new ones — that is
`includePrevious` plus the merge instructions doing their job.

**`parallelSafe` as a predicate.** *"Look up orders A-1 and A-2 at the same
time, then mark A-2 as ready"* issues three `orders` calls: two `mode: 'read'`
that batch together, then a `mode: 'write'` that forms a serial barrier. One
tool, two scheduling classes — which a static boolean could not express.

**`search_memory` reaches an extractor preload never does.** With only
`dietary-profile.json` on disk for a user (no `USER.md`, no `facts.json`),
asking "Am I allergic to anything?" prints `[events] tool:search_memory` and
answers correctly — the extractor's value has no other path to the model.
