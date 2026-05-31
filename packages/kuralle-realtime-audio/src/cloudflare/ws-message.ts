/// <reference path="./workers-env.d.ts" />

/** Decode a workerd WebSocket frame payload to UTF-8 text. Returns null if unrecognized. */
export async function decodeCFWorkerMessageData(
  raw: CFWorkerMessagePayload,
): Promise<string | null> {
  if (typeof raw === 'string') {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(raw));
  }
  if (ArrayBuffer.isView(raw)) {
    return new TextDecoder().decode(
      new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength),
    );
  }
  if (raw instanceof Blob) {
    return raw.text();
  }
  return null;
}
