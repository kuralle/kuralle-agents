/**
 * Local chat-context mirror for OpenAI-family realtime clients.
 *
 * OpenAI Realtime has no server-side session resume. When the WS drops,
 * Kuralle must hold the conversation and replay it via `conversation.item.create`
 * on reconnect. This class is the authoritative mirror: it mutates on every
 * observed `conversation.item.added` / transcript-complete frame, and emits
 * frames in chain order on replay.
 *
 * Verified against LiveKit's `RemoteChatContext` (realtime_model.ts:413, 994-1003)
 * and Pipecat's `_create_response` replay path.
 */

import { buildItemCreate } from './protocol.js';

export type ChatCtxRole = 'user' | 'assistant' | 'system';

export interface ChatCtxItem {
  /** OpenAI-assigned item id. Used to chain `previous_item_id` on replay. */
  itemId: string;
  role: ChatCtxRole;
  /** Message kind. `function_call` items are intentionally excluded from replay. */
  kind: 'message' | 'function_call_output';
  /** Content parts; shape depends on kind. For messages: `[{ type: 'input_text' | 'output_text', text }]`. */
  content: unknown[];
  /** Monotonic insert position used for SQLite ordering + `previous_item_id` resolution. */
  position: number;
}

/**
 * Append-only mirror with upsert semantics. Items arrive via
 * `conversation.item.added` (id + initial shape) and may be mutated by later
 * transcript-complete events that fill in text content.
 */
export class ChatCtxMirror {
  #items: ChatCtxItem[] = [];
  #byId = new Map<string, ChatCtxItem>();
  #nextPosition = 0;

  size(): number {
    return this.#items.length;
  }

  snapshot(): ChatCtxItem[] {
    // Defensive copy — replay is read-only; callers should not mutate.
    return this.#items.map((i) => ({ ...i, content: [...(i.content as unknown[])] }));
  }

  /** Insert a new item (from `conversation.item.added`) or no-op if already tracked. */
  upsert(item: {
    id?: string;
    type?: string;
    role?: string;
    content?: unknown[];
  }): void {
    if (!item.id) return;
    const existing = this.#byId.get(item.id);
    if (existing) {
      // Update content if newer frame arrived (e.g. transcription completed).
      if (Array.isArray(item.content)) {
        existing.content = item.content;
      }
      return;
    }
    const kind: ChatCtxItem['kind'] =
      item.type === 'function_call_output' ? 'function_call_output' : 'message';
    const role: ChatCtxRole =
      item.role === 'user' || item.role === 'assistant' || item.role === 'system'
        ? (item.role as ChatCtxRole)
        : 'assistant';
    const next: ChatCtxItem = {
      itemId: item.id,
      role,
      kind,
      content: Array.isArray(item.content) ? item.content : [],
      position: this.#nextPosition++,
    };
    this.#items.push(next);
    this.#byId.set(next.itemId, next);
  }

  /**
   * Record a finalized transcript for an item. Called on
   * `conversation.item.input_audio_transcription.completed` (user) and
   * `response.output_audio_transcript.done` (assistant).
   */
  applyTranscript(itemId: string, role: ChatCtxRole, text: string): void {
    let item = this.#byId.get(itemId);
    if (!item) {
      // Transcript arrived before item.added — create a placeholder.
      item = {
        itemId,
        role,
        kind: 'message',
        content: [],
        position: this.#nextPosition++,
      };
      this.#items.push(item);
      this.#byId.set(itemId, item);
    }
    const textType = role === 'user' ? 'input_text' : 'output_text';
    // Replace existing content — transcription-completed is the authoritative text.
    item.content = [{ type: textType, text }];
    item.role = role;
  }

  /**
   * Hydrate from a persisted snapshot (e.g. SQLite rows on DO wake). Replaces
   * existing state. `position` values must be monotonic — the next position
   * continues from `max(position) + 1`.
   */
  hydrate(items: ChatCtxItem[]): void {
    this.#items = items.slice().sort((a, b) => a.position - b.position);
    this.#byId = new Map(this.#items.map((i) => [i.itemId, i]));
    this.#nextPosition = this.#items.length
      ? Math.max(...this.#items.map((i) => i.position)) + 1
      : 0;
  }

  /**
   * Emit the `conversation.item.create` frame sequence needed to rebuild this
   * chat_ctx on a fresh session. Function-call items are excluded per LiveKit's
   * `excludeFunctionCall: true` precedent — restored tool results are replayed
   * as synthetic assistant messages would lose the tool call pairing; OpenAI's
   * `function_call_output` item requires a live `call_id` that no longer exists
   * on a new session.
   */
  toCreateFrames(): Record<string, unknown>[] {
    const frames: Record<string, unknown>[] = [];
    let previousId: string | null = null;
    for (const item of this.#items) {
      if (item.kind === 'function_call_output') continue;
      // Only include items that have non-empty content (empty placeholders from
      // interrupted turns aren't useful context and OpenAI rejects them).
      const contentArr = item.content as unknown[];
      if (!contentArr || contentArr.length === 0) continue;
      const itemFrame = {
        type: 'message',
        role: item.role,
        content: contentArr,
      };
      frames.push(buildItemCreate(itemFrame, previousId));
      previousId = item.itemId;
    }
    return frames;
  }

  /** For tests. */
  getById(itemId: string): ChatCtxItem | undefined {
    return this.#byId.get(itemId);
  }
}
