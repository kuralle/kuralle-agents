/**
 * Checkout token codec. The payment link is store-free: the token encodes the
 * exact DO id + the durable signal id to deliver on payment. `/pay/:token` decodes
 * it, routes to that DO via `idFromString`, and resumes it.
 *
 * DEMO-GRADE: this is a base64url JSON blob, not signed. A real deployment would
 * sign/encrypt it (or store a random token → order mapping server-side) so links
 * can't be forged. Kept transparent here to keep the demo dependency-free.
 */
export interface CheckoutToken {
  /** Hex Durable Object id (from `getDurableObjectId()`). */
  doId: string;
  /** Durable signal id to deliver (idempotency key for the resume). */
  signalId: string;
}

const b64urlEncode = (s: string): string =>
  btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const b64urlDecode = (s: string): string =>
  atob(s.replace(/-/g, '+').replace(/_/g, '/'));

export function encodeCheckoutToken(token: CheckoutToken): string {
  return b64urlEncode(JSON.stringify(token));
}

export function decodeCheckoutToken(raw: string): CheckoutToken | null {
  try {
    const parsed = JSON.parse(b64urlDecode(raw)) as CheckoutToken;
    if (typeof parsed?.doId === 'string' && typeof parsed?.signalId === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

/** The durable signal name the checkout action waits on. */
export const PAYMENT_SIGNAL = 'payment';
