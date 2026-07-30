const CONVERSATION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,95}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CommerceIdentity {
  userId: string;
  setCookie?: string;
}

export function identityCookieName(secure: boolean): string {
  return secure ? '__Host-kuralle_commerce_id' : 'kuralle_commerce_id';
}

export async function resolveCommerceIdentity(
  request: Request,
  secret: string,
  options: { secure: boolean; sameSite?: 'Lax' | 'None' },
): Promise<CommerceIdentity> {
  assertIdentitySecret(secret);
  const name = identityCookieName(options.secure);
  const current = parseCookies(request.headers.get('cookie')).get(name);
  if (current) {
    const verified = await verifyIdentityCookie(current, secret);
    if (verified) return { userId: verified };
  }

  const userId = crypto.randomUUID();
  const value = await signIdentityCookie(userId, secret);
  return {
    userId,
    setCookie: [
      `${name}=${value}`,
      'Path=/',
      'HttpOnly',
      `SameSite=${options.sameSite ?? 'Lax'}`,
      'Max-Age=31536000',
      ...(options.secure ? ['Secure'] : []),
    ].join('; '),
  };
}

export function scopedSessionId(userId: string, conversationId: string): string {
  if (!UUID_PATTERN.test(userId)) throw new Error('Invalid authenticated user id.');
  if (!CONVERSATION_PATTERN.test(conversationId)) throw new Error('Invalid conversation id.');
  return `${userId}:${conversationId}`;
}

export async function signIdentityCookie(userId: string, secret: string): Promise<string> {
  if (!UUID_PATTERN.test(userId)) throw new Error('Invalid authenticated user id.');
  assertIdentitySecret(secret);
  const payload = `v1.${userId}`;
  const signature = await hmac(payload, secret);
  return `${payload}.${encodeBase64Url(signature)}`;
}

export async function verifyIdentityCookie(value: string, secret: string): Promise<string | null> {
  assertIdentitySecret(secret);
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1' || !UUID_PATTERN.test(parts[1] ?? '')) return null;
  let signature: Uint8Array;
  try {
    signature = decodeBase64Url(parts[2] ?? '');
  } catch {
    return null;
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    signature as BufferSource,
    new TextEncoder().encode(`v1.${parts[1]}`),
  );
  return valid ? parts[1]! : null;
}

export function requireConversationId(value: unknown): string {
  if (typeof value !== 'string' || !CONVERSATION_PATTERN.test(value)) {
    throw new Error('A valid conversationId is required.');
  }
  return value;
}

function assertIdentitySecret(secret: string): void {
  if (secret.trim().length < 32) {
    throw new Error('COMMERCE_IDENTITY_SECRET must contain at least 32 characters.');
  }
}

function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const pair of header?.split(';') ?? []) {
    const separator = pair.indexOf('=');
    if (separator < 1) continue;
    cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
  }
  return cookies;
}

async function hmac(value: string, secret: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
}

function encodeBase64Url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
