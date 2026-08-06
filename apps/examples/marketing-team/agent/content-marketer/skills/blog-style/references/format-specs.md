# Blog format specs

Concrete limits and targets for quick reference. Only the numbers below are sourced; don't add
others without a source. These are guardrails, not goals: match depth and length to what the
reader's question actually needs.

## SEO metadata

| Thing | Target |
| --- | --- |
| Title tag length | ~50–60 characters (under ~600px); keyword near the front |
| Meta description length | ~150 chars or under; mobile truncates ~120 |
| Slug | short, lowercase, hyphenated, keyword in it, no dates/stop words |
| Title tags per page | one unique title per post |

A title over ~600px or ~60 characters gets truncated in results, and Google rewrites titles most
of the time, so lead with the key information rather than chasing an exact count. The meta
description is not a ranking factor; it earns the click.

**None of this metadata goes in the body.** `create_content` and `update_content` take
`metaDescription` and `targetQuery` as their own arguments — pass them there. The body field is
for the body, and it rejects markdown that carries metadata either as a YAML front matter block
at the top or as a `Meta description: …` trailer at the bottom, because both get stored and
rendered as prose the reader sees.

Internal links belong inline in the body as ordinary markdown links, at the point where they are
relevant. A list of suggested links at the end is not internal linking; it is a note to yourself.
