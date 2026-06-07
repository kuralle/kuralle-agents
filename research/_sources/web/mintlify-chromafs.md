# How we built a virtual filesystem for our Assistant (Mintlify — ChromaFs)

Source: https://www.mintlify.com/blog/how-we-built-a-virtual-filesystem-for-our-assistant (Dens Sumesh, 2026-03-24, fetched 2026-06-07)

---

RAG is great, until it isn't. Their assistant could only retrieve chunks of text that matched a query. If the answer lived across multiple pages, or the user needed exact syntax that didn't land in a top-K result, it was stuck. They wanted it to **explore docs the way you'd explore a codebase**.

> Agents are converging on filesystems as their primary interface because `grep`, `cat`, `ls`, and `find` are all an agent needs. If each doc page is a file and each section is a directory, the agent can search for exact strings, read full pages, and traverse the structure on its own.

(Cites arxiv.org/abs/2601.11672 on filesystems as agent interface.)

## The Container Bottleneck

The obvious approach: give the agent a real filesystem via an isolated sandbox + cloned repo. Fine for async background agents where latency doesn't matter, but for a frontend assistant with a user watching a spinner it falls apart. **P90 session creation (incl. GitHub clone + setup) was ~46 seconds.**

Beyond latency, dedicated micro-VMs for reading static docs introduced a serious bill. At 850,000 conversations/month, even minimal (1 vCPU, 2 GiB RAM, 5-min lifetime) would be **north of $70,000/year** (Daytona per-second pricing $0.0504/h per vCPU, $0.0162/h per GiB RAM). Longer sessions double it.

Needed the filesystem workflow to be instant and cheap → rethink the filesystem itself.

## Faking a Shell

The agent doesn't need a *real* filesystem; it just needs the *illusion* of one. Docs were already indexed, chunked, and stored in a **Chroma** database powering search. So they built **ChromaFs**: a virtual filesystem that intercepts UNIX commands and translates them into queries against that same database.

- Session creation: ~46s → **~100ms**.
- Marginal per-conversation compute cost: **~$0** (reuses existing DB infra).

> ChromaFs is built on **[just-bash](https://github.com/vercel-labs/just-bash) by Vercel Labs** — a TypeScript reimplementation of bash that supports `grep`, `cat`, `ls`, `find`, and `cd`. just-bash exposes a pluggable **`IFileSystem` interface**, so it handles all the parsing, piping, and flag logic while ChromaFs translates every underlying filesystem call into a Chroma query.

| Metric | Sandbox | ChromaFs |
| --- | --- | --- |
| P90 Boot Time | ~46 seconds | ~100 milliseconds |
| Marginal Compute Cost | ~$0.0137 per conversation | ~$0 (reuses existing DB) |
| Search Mechanism | Linear disk scan (Syscalls) | DB Metadata Query |
| Infrastructure | Daytona or similar | Provisioned DB |

### Bootstrapping the Directory Tree

ChromaFs needs to know what files exist before the agent runs a command. They store the entire file tree as a **gzipped JSON document (`__path_tree__`)** inside the Chroma collection:

```json
{
  "auth/oauth": { "isPublic": true, "groups": [] },
  "auth/api-keys": { "isPublic": true, "groups": [] },
  "internal/billing": { "isPublic": false, "groups": ["admin", "billing"] },
  "api-reference/endpoints/users": { "isPublic": true, "groups": [] }
}
```

On init, the server fetches and decompresses this into two in-memory structures: a `Set<string>` of file paths and a `Map<string, string[]>` mapping directories to children. Once built, `ls`, `cd`, `find` resolve in local memory with **no network calls**. The tree is cached, so subsequent sessions for the same site skip the Chroma fetch entirely.

### Access Control (RBAC)

`isPublic` and `groups` fields in the path tree. Before building the file tree, ChromaFs **prunes slugs using the current user's session token** and applies a matching filter to all subsequent Chroma queries. If a user lacks access to a file, that file is excluded from the tree entirely — the agent can't access or even *reference* a pruned path. In a real sandbox this would need Linux user groups / `chmod` / isolated container images per tier. In ChromaFs it's a few lines of filtering before `buildFileTree` runs.

### Reassembling Pages from Chunks

Pages in Chroma are split into chunks for embedding. When the agent runs `cat /auth/oauth.mdx`, ChromaFs fetches all chunks with a matching `page` slug, sorts by `chunk_index`, joins them into the full page. Results cached so repeated reads during grep workflows never hit the DB twice.

**Lazy file pointers:** not every file needs to exist in Chroma. They register lazy pointers that resolve on access for large OpenAPI specs in customers' S3 buckets. Agent sees `v2.json` in `ls /api-specs/`, but content fetches only on `cat`.

**Read-only:** Every write throws `EROFS` (Read-Only File System). The agent explores freely but can never mutate docs → system is **stateless**, no session cleanup, no risk of one agent corrupting another's view.

## Optimizing Grep (coarse → fine, two-stage)

`grep -r` would be too slow if it naively scanned every file over the network. They intercept just-bash's `grep`, parse flags with `yargs-parser`, translate to a Chroma query (`$contains` for fixed strings, `$regex` for patterns).

- **1. Coarse filter (Chroma):** identifies which files *might* contain the hit; `bulkPrefetch` those matching chunks into a Redis cache.
- **2. Fine filter (in-memory):** rewrite the grep to target only the matched files, hand back to just-bash for in-memory execution. Large recursive queries complete in milliseconds.

## Conclusion

ChromaFs powers the docs assistant for hundreds of thousands of users across 30,000+ conversations/day. Replacing sandboxes with a virtual filesystem over an existing Chroma DB → instant session creation, zero marginal compute cost, built-in RBAC, no new infra.

---

### KEY TAKEAWAYS FOR KURALLE
- The agent interface is `ls/cat/grep/find/cd` over a **pluggable `IFileSystem`**; the backend can be anything (Chroma, S3, memory, real disk).
- just-bash gives the command parsing/piping/flags for free → you only implement the FS adapter.
- Bootstrapping a path-tree manifest separates *structure* (cheap, in-memory) from *content* (lazy, fetched on `cat`).
- RBAC via tree-pruning is cleaner than container permissions.
- Read-only (`EROFS`) → stateless, safe for multi-tenant.
- Two-stage grep (coarse DB filter → fine in-memory) is the performance trick for a knowledge-base FS.
