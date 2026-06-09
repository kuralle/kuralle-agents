import type { InputProcessor, OutputProcessor } from '../../types/processors.js';

/**
 * Deterministic PII detection + redaction over message text.
 *
 * Detectors are conservative by default: `credit-card` (separator-tolerant,
 * Luhn-validated so order/tracking numbers don't false-positive) and `email`.
 * `phone` and `iban` are opt-in because their shapes collide with order ids,
 * reference codes, and similar commerce artifacts.
 */
export type PiiDetector = 'credit-card' | 'email' | 'phone' | 'iban';

export interface PiiGuardOptions {
  /** Which detectors to run. Default: `['credit-card', 'email']`. */
  detect?: PiiDetector[];
  /** `redact` replaces matches in place; `block` refuses the message. Default: `redact`. */
  mode?: 'redact' | 'block';
  /** User-facing message when `mode: 'block'` trips. */
  message?: string;
  id?: string;
}

const DEFAULT_DETECTORS: PiiDetector[] = ['credit-card', 'email'];

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 13-19 digits with optional single space/dash separators; candidates are
// Luhn-checked before redaction so plain long numbers survive.
const CARD_CANDIDATE_PATTERN = /\b(?:\d[ -]?){12,18}\d\b/g;
// Opt-in: international or separator-formatted numbers with 9+ digits total.
const PHONE_PATTERN = /(?:\+\d{1,3}[ -.]?)?(?:\(\d{2,4}\)[ -.]?)?\d{2,4}[ -.]\d{3,4}[ -.]?\d{3,4}\b|\+\d{9,15}\b/g;
const IBAN_PATTERN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function ibanChecksumValid(candidate: string): boolean {
  const compact = candidate.replace(/\s+/g, '').toUpperCase();
  if (compact.length < 15 || compact.length > 34) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const value = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of value) {
      remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
    }
  }
  return remainder === 1;
}

export interface PiiMatch {
  detector: PiiDetector;
  matchedText: string;
}

export interface PiiScanResult {
  text: string;
  matches: PiiMatch[];
}

/**
 * Scan and redact PII in `text`. Returns the redacted text plus the list of
 * matches (detector + original matched text) so callers can audit what was
 * found without re-detecting.
 */
export function redactPii(text: string, detect: PiiDetector[] = DEFAULT_DETECTORS): PiiScanResult {
  const matches: PiiMatch[] = [];
  let current = text;

  if (detect.includes('credit-card')) {
    current = current.replace(CARD_CANDIDATE_PATTERN, (candidate) => {
      const digits = candidate.replace(/[ -]/g, '');
      if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) {
        return candidate;
      }
      matches.push({ detector: 'credit-card', matchedText: candidate });
      return '[redacted card number]';
    });
  }

  if (detect.includes('iban')) {
    current = current.replace(IBAN_PATTERN, (candidate) => {
      if (!ibanChecksumValid(candidate)) {
        return candidate;
      }
      matches.push({ detector: 'iban', matchedText: candidate });
      return '[redacted iban]';
    });
  }

  if (detect.includes('email')) {
    current = current.replace(EMAIL_PATTERN, (candidate) => {
      matches.push({ detector: 'email', matchedText: candidate });
      return '[redacted email]';
    });
  }

  if (detect.includes('phone')) {
    current = current.replace(PHONE_PATTERN, (candidate) => {
      const digits = candidate.replace(/\D/g, '');
      if (digits.length < 9 || digits.length > 15) {
        return candidate;
      }
      matches.push({ detector: 'phone', matchedText: candidate });
      return '[redacted phone]';
    });
  }

  return { text: current, matches };
}

/**
 * PII guard over inbound user text. `redact` mode rewrites the message before
 * the model (and persisted history) sees the raw value — credit-card redaction
 * inbound is the PCI-relevant default for commerce agents.
 */
export function createPiiInputGuard(options: PiiGuardOptions = {}): InputProcessor {
  const detect = options.detect ?? DEFAULT_DETECTORS;
  const mode = options.mode ?? 'redact';
  return {
    id: options.id ?? 'pii-input-guard',
    name: 'PII input guard',
    description: `Detects ${detect.join(', ')} in user input and ${mode}s it.`,
    process: ({ input }) => {
      const scan = redactPii(input, detect);
      if (scan.matches.length === 0) {
        return { action: 'allow' };
      }
      if (mode === 'block') {
        return {
          action: 'block',
          reason: `pii-detected: ${scan.matches.map((m) => m.detector).join(', ')}`,
          message:
            options.message ??
            'For your security, please do not share sensitive details like card numbers in chat.',
        };
      }
      return {
        action: 'modify',
        input: scan.text,
        reason: `pii-redacted: ${scan.matches.map((m) => m.detector).join(', ')}`,
      };
    },
  };
}

/** PII guard over assistant output — stops the model echoing sensitive values back. */
export function createPiiOutputGuard(options: PiiGuardOptions = {}): OutputProcessor {
  const detect = options.detect ?? DEFAULT_DETECTORS;
  const mode = options.mode ?? 'redact';
  return {
    id: options.id ?? 'pii-output-guard',
    name: 'PII output guard',
    description: `Detects ${detect.join(', ')} in assistant output and ${mode}s it.`,
    process: ({ text }) => {
      const scan = redactPii(text, detect);
      if (scan.matches.length === 0) {
        return { action: 'allow' };
      }
      if (mode === 'block') {
        return {
          action: 'block',
          reason: `pii-detected: ${scan.matches.map((m) => m.detector).join(', ')}`,
          message: options.message ?? 'Sorry, I cannot share that information.',
        };
      }
      return {
        action: 'modify',
        text: scan.text,
        reason: `pii-redacted: ${scan.matches.map((m) => m.detector).join(', ')}`,
      };
    },
  };
}
