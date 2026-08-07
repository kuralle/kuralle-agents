---
'@kuralle-agents/core': minor
---

**New — a `search_memory` tool over `ExtractedValueStore`.**

Memory now has two read paths, not one. `memory.preload` was already automatic
and `facts`-only: it scores the `facts` slug against the user's latest message
and injects the top matches every turn, but nothing could read any *other*
declared extractor — a value from `defineExtractor` was written every turn and
read by nothing, ever.

Declaring `memory.extract` now also wires a `search_memory` tool, mirroring
`memory_block`'s addressing pattern: its `slug` argument is a `z.enum` built
from the extractors the agent declares, so an undeclared slug is not rejected
at runtime, it cannot be expressed. `ExtractedValueStore` still has no
`list()` — the enum is what makes enumeration unnecessary.

```ts
defineAgent({
  memory: {
    preload: { enabled: true },
    extract: [factsExtractor(), dietaryProfile], // dietaryProfile was write-only before this
  },
})
// model-initiated:
// search_memory({ query: "shellfish allergy" })
// search_memory({ query: "shellfish allergy", slug: "dietary-profile" })
// -> { results: [{ slug: 'dietary-profile', entry: 'allergies: shellfish', score: 0.5 }] }
```

The tool is withheld — not present with an empty result — when no declared
extractor is addressable in the session (no `userId`, same as the rest of
user-scoped memory) or when the agent declares no extractors at all.

A query matching nothing returns `{ results: [] }`, deliberately unlike
`preload`, which falls back to showing everything when nothing scores. An
explicit question deserves an honest "not found" over unrelated facts.

`lexicalScore` — the ranking function — moved to its own module
(`packages/core/src/memory/lexicalScore.ts`) so both read paths rank
identically, and gained a same-length-prefix fallback (6+ chars) alongside its
existing substring match, so a query like "allergic" can find a value stored
under the field name `allergies` — a derivational pair substring matching never
bridges.

**This changes automatic recall, not only search.** The match set only grows, but
`preloadMemoryContext` uses `score > 0` as a *membership filter*: a fact that
scored 0 under substring-only matching, and so was excluded from the prompt, may
now score above 0 and be injected. It also makes preload's "nothing matched, so
show everything" fallback fire less often. Existing agents will therefore see a
different — generally more relevant — selection of facts in their system prompt
after upgrading. Nothing that was injected before stops being injected.

Calling this "purely additive" would be true of the matcher and misleading about
the feature, which is why it is spelled out here.
