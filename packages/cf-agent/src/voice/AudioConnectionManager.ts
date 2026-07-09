/**
 * Vendored, trimmed port of AudioConnectionManager + sendVoiceJSON from
 * `@cloudflare/voice` (cloudflare/agents, packages/voice/src/audio-pipeline.ts,
 * MIT License, © 2025 Cloudflare, Inc.).
 *
 * Original provides cascaded-pipeline state (audio buffers, transcriber
 * sessions, abort pipelines). The realtime variant needs none of that —
 * audio is pass-through, turn detection happens provider-side, there is no
 * separate STT session to manage. We keep only the connection-level
 * in-call tracking primitive.
 *
 * Upstream source:
 *   https://github.com/cloudflare/agents/blob/main/packages/voice/src/audio-pipeline.ts
 */

/**
 * Minimal per-connection state manager for the realtime voice mixin.
 *
 * Tracks which connection IDs currently have an open realtime session.
 * Owning the Map here (rather than inline in the mixin) keeps the mixin
 * class body focused on protocol handling and matches the shape the
 * cascaded lane uses.
 */
export class AudioConnectionManager {
  #inCall = new Set<string>();

  /** Mark a connection as having an active in-call state. */
  initConnection(connectionId: string): void {
    this.#inCall.add(connectionId);
  }

  /** True if this connection currently has an active realtime session. */
  isInCall(connectionId: string): boolean {
    return this.#inCall.has(connectionId);
  }

  /** Clear in-call state for a connection (end_call or onClose). */
  cleanup(connectionId: string): void {
    this.#inCall.delete(connectionId);
  }

  /** Count of active in-call connections. Used for maxConcurrentSessions gate. */
  size(): number {
    return this.#inCall.size;
  }
}

/**
 * Serialize and push a voice-protocol frame to a client connection.
 *
 * Upstream accepts a log prefix; we drop it since the realtime path has no
 * chatty log calls. Signature intentionally minimal so the mixin's send
 * sites stay readable.
 */
export function sendVoiceJSON(
  connection: { send(data: string | ArrayBuffer): void },
  data: unknown,
): void {
  connection.send(JSON.stringify(data));
}
