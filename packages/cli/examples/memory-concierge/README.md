# memory-concierge

A CLI agent exercising the extraction chain end to end, **across separate processes**.

```bash
kuralle send --agent packages/cli/examples/memory-concierge/agent.ts --user mithushan --session s1 \
  "I'm Mithushan, I run a bakery in Colombo and I'm allergic to penicillin and shellfish."

kuralle send --agent packages/cli/examples/memory-concierge/agent.ts --user mithushan --session s2 \
  "What do you know about me?"
```

The second command is a new process and a new session. It recalls the first
because both extractors wrote to a `FileExtractedValueStore` on disk. An
in-memory store would make this pass inside one process and fail the moment it
mattered.

`--user` is required. Without it the session has no owner, and user-scoped
memory is skipped rather than pooled into a bucket shared with every other
anonymous session — see `resolveWorkingMemoryOwner`.

## What lands on disk

```
.memory/extracted/user/mithushan/facts.json            <- factsExtractor()
.memory/extracted/user/mithushan/dietary-profile.json  <- the custom extractor
.memory/blocks/user/mithushan/USER.md                  <- working memory
```

Two separate trees. Extracted values are not in the block namespace, and no tool
can address them — `memory_block` is an enum over the declared blocks only.

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
