/**
 * Owner/key canonicalisation for `PersistentMemoryStore` (layers 1 + 3 of the
 * three-layer fix — see the block stores' own files for layer 2).
 *
 * Layer 1 — validate and reject. `owner` and block `key` values are checked
 * against a shared allow-list; anything outside it throws rather than being
 * silently coerced into some backend's storage key. Rejecting has a property
 * encoding lacks: an owner manufactured by a bug (e.g. an empty-string
 * fallback) fails loudly here instead of getting a tidy, valid row.
 *
 * The allow-list is `^[A-Za-z0-9._@+:~|-]+$`. `:` and `|` stay legal because
 * real user ids use them (`google-oauth2|123`, `tenant:user`); `/`, `\`,
 * whitespace, control characters and glob characters are rejected. Because
 * `:` stays legal, string-keyed backends (Redis, File) still have to encode
 * — this allow-list alone does not make them collision-safe.
 *
 * Layer 3 — encode. `encodeSegment` (canonically defined on
 * `FileExtractedValueStore`, re-exported here) percent-encodes anything
 * outside a conservative filesystem-safe set. Backends that must flatten
 * (scope, owner, key) into one string use it; backends with a real
 * multi-column key (Postgres, SQLite) or a genuine tuple key (a nested Map)
 * never need it.
 *
 * `withOwnerValidation` applies layer 1 to any `PersistentMemoryStore` once,
 * rather than duplicating the check inside every backend — a raw backend
 * class stays exactly as permissive as it always was (constructing one
 * directly and handing it a stray `/` still works, sanitised by its own
 * layer 2/3 fix), and the reject-and-throw guarantee is opt-in at whichever
 * boundary chooses to apply it.
 */
import { encodeSegment as encodeSegmentImpl } from '../extract/FileExtractedValueStore.js';
import type { MemoryBlockScope, PersistentMemoryBlock, PersistentMemoryStore } from './types.js';

const OWNER_KEY_PATTERN = /^[A-Za-z0-9._@+:~|-]+$/;

export class InvalidOwnerError extends Error {
  constructor(owner: string) {
    super(
      `Invalid memory-block owner ${JSON.stringify(owner)}: must match ${OWNER_KEY_PATTERN}`,
    );
    this.name = 'InvalidOwnerError';
  }
}

export class InvalidBlockKeyError extends Error {
  constructor(key: string) {
    super(`Invalid memory-block key ${JSON.stringify(key)}: must match ${OWNER_KEY_PATTERN}`);
    this.name = 'InvalidBlockKeyError';
  }
}

/**
 * Non-throwing form, for a caller that must decide what to do about an invalid
 * owner rather than propagate. `wireWorkingMemory` uses this: an unusable owner
 * drops the memory surface for that session, exactly as an *unresolvable* one
 * already does, instead of throwing through the middle of a turn. Fail closed
 * without taking the conversation down with it.
 */
export function isValidOwner(owner: string): boolean {
  return OWNER_KEY_PATTERN.test(owner);
}

/** Non-throwing form of `assertValidBlockKey`. */
export function isValidBlockKey(key: string): boolean {
  return OWNER_KEY_PATTERN.test(key);
}

/** Throws InvalidOwnerError unless owner matches the allow-list. */
export function assertValidOwner(owner: string): void {
  if (!OWNER_KEY_PATTERN.test(owner)) {
    throw new InvalidOwnerError(owner);
  }
}

/** Throws InvalidBlockKeyError unless key matches the allow-list. */
export function assertValidBlockKey(key: string): void {
  if (!OWNER_KEY_PATTERN.test(key)) {
    throw new InvalidBlockKeyError(key);
  }
}

/** Injective, reversible; the extracted-value namespace's encoder, re-exported. */
export const encodeSegment = encodeSegmentImpl;

/**
 * Percent-encode every byte outside `safe`.
 *
 * Injective for any `safe` set that excludes `%`: `%` itself always encodes to
 * `%25`, so no encoded output can be mistaken for a literal one. Every caller
 * below therefore omits `%` from its set — do not add it.
 *
 * The set is a parameter because **the right set is per-medium, and encoding
 * more than the medium requires is not free**: every character escaped here is
 * a storage key that changes, and a key that changes is data an existing
 * deployment can no longer find. Redis only needs `:` escaped; a filesystem
 * needs the path and Windows-reserved characters. Escaping `@` in Redis, as an
 * earlier revision did, silently orphaned every email-shaped owner's blocks for
 * no collision-safety gain at all.
 */
function encodeWith(part: string, safe: RegExp): string {
  let out = '';
  for (const byte of new TextEncoder().encode(part)) {
    const ch = String.fromCharCode(byte);
    out += safe.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

// Redis composes on ':'. That is the only allow-listed character it must
// escape; '@', '+', '~', '|', '.', '-' and '_' are all inert inside a Redis
// key, so they pass through and those owners keep the key they already have.
const REDIS_SAFE = /[A-Za-z0-9._@+~|-]/;

// A path segment additionally cannot carry '|' or ':' (both illegal on
// Windows, and ':' is a resource fork separator on macOS), so those encode.
const FILE_SAFE = /[A-Za-z0-9._@+~-]/;

/** Encode one segment of a Redis key. Escapes ':' and anything not allow-listed. */
export function encodeRedisSegment(part: string): string {
  return encodeWith(part, REDIS_SAFE);
}

// Windows resolves these names as devices no matter the extension or directory:
// `NUL.md` is the null device, so writes are discarded and reads come back
// empty. Every one of them is a perfectly legal allow-list identifier, and
// `MEMORY`-style block keys make an all-caps name likely rather than exotic.
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/**
 * Encode one path segment.
 *
 * Three names get special handling because a filesystem reads them as something
 * other than a name: `.` and `..` are directory entries, and the Windows device
 * names above are hardware. In each case the first character is escaped, which
 * is enough to make the segment inert while leaving it readable and reversible.
 *
 * **Known limitation — case-insensitive filesystems.** macOS (APFS default) and
 * Windows (NTFS) fold case, so owners differing only by case — `Alice` and
 * `alice` — resolve to one directory here. Encoding the case away would make
 * every ordinary name unreadable (`USER.md` becomes `%55%53%45%52.md`), which
 * costs the human-editable-markdown property this store deliberately offers.
 * Closing it is a layout decision rather than a bug fix; see the board task
 * "Decide how the file memory store survives a case-insensitive filesystem".
 */
export function encodeFileSegment(part: string): string {
  if (part === '.' || part === '..') {
    return part.replace(/\./g, '%2E');
  }
  const encoded = encodeWith(part, FILE_SAFE);
  if (WINDOWS_RESERVED.test(encoded)) {
    const first = new TextEncoder().encode(encoded[0]!)[0]!;
    return `%${first.toString(16).toUpperCase().padStart(2, '0')}${encoded.slice(1)}`;
  }
  return encoded;
}

/**
 * Reverse `encodeFileSegment`, and **never throw**.
 *
 * `decodeURIComponent` raises `URIError` on a bare `%` — `50%.md` is enough —
 * and `listBlocks` decodes every filename in a directory. A single hand-edited
 * or legacy file would otherwise take down listing for that whole (scope,
 * owner), not just its own entry. This store's own docs invite exactly that:
 * blocks are human-editable markdown and admin scripts may seed them.
 *
 * Strict on write, lenient on read: an undecodable name is returned verbatim,
 * which is what a human who created it by hand would expect to see.
 */
export function decodeFileSegment(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * Wraps a `PersistentMemoryStore` so every call validates its owner (and
 * block key, where the method takes one) before reaching the backend.
 */
export function withOwnerValidation(store: PersistentMemoryStore): PersistentMemoryStore {
  return {
    async loadBlock(scope: MemoryBlockScope, owner: string, key: string) {
      assertValidOwner(owner);
      assertValidBlockKey(key);
      return store.loadBlock(scope, owner, key);
    },
    async saveBlock(block: PersistentMemoryBlock, owner: string) {
      assertValidOwner(owner);
      assertValidBlockKey(block.key);
      return store.saveBlock(block, owner);
    },
    async deleteBlock(scope: MemoryBlockScope, owner: string, key: string) {
      assertValidOwner(owner);
      assertValidBlockKey(key);
      return store.deleteBlock(scope, owner, key);
    },
    async listBlocks(scope: MemoryBlockScope, owner: string) {
      assertValidOwner(owner);
      return store.listBlocks(scope, owner);
    },
  };
}
